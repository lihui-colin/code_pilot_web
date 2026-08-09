import type {
  CodexChatAppearance,
  CodexChatRequest,
  CodexCliStatus,
  CodexConversationActivity,
  CodexConversationStreamEvent,
  CodexConversationSnapshot,
  ReadinessResult,
  RepositoryContextFileListing,
  RepositoryFolderListing,
  RepositoryListingResponse,
  SessionInfo,
  ViewerInstance,
  ZellijWebTokenInfo,
} from '../domain/types.js';

interface ApiErrorBody {
  error?: { message?: string };
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(body.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function getJson<T>(url: string): Promise<T> {
  return requestJson<T>(url);
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function getReadiness(): Promise<ReadinessResult> {
  const response = await fetch('/api/ready', { credentials: 'same-origin' });
  if (response.ok || response.status === 503) return response.json() as Promise<ReadinessResult>;
  const body = await response.json().catch(() => ({})) as ApiErrorBody;
  throw new Error(body.error?.message ?? `请求失败（HTTP ${response.status}）`);
}

export async function getSessions(): Promise<SessionInfo[]> {
  const result = await getJson<{ sessions: SessionInfo[] }>('/api/sessions');
  return result.sessions;
}

export function getRepositories(): Promise<RepositoryListingResponse> {
  return getJson<RepositoryListingResponse>('/api/repositories');
}

export function getRepositoryFolders(directoryId?: string, initialPath?: string): Promise<RepositoryFolderListing> {
  const query = directoryId
    ? `?directoryId=${encodeURIComponent(directoryId)}`
    : initialPath ? `?initialPath=${encodeURIComponent(initialPath)}` : '';
  return getJson<RepositoryFolderListing>(`/api/repository-folders${query}`);
}

export async function addManualRepository(directoryId: string): Promise<string> {
  const result = await postJson<{ repositoryId: string }>('/api/repositories', { directoryId });
  return result.repositoryId;
}

export async function deleteManualRepository(repositoryId: string): Promise<void> {
  await requestJson<void>(`/api/repositories/${encodeURIComponent(repositoryId)}`, {
    method: 'DELETE',
  });
}

export function createSession(repositoryId: string): Promise<SessionInfo> {
  return postJson<SessionInfo>('/api/sessions', { repositoryId, command: 'codex' });
}

export async function deleteSession(name: string): Promise<void> {
  await requestJson<void>(`/api/sessions/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export function createViewer(repositoryId: string): Promise<ViewerInstance> {
  return postJson<ViewerInstance>('/api/viewers', { repositoryId });
}

export async function getZellijToken(): Promise<ZellijWebTokenInfo | null> {
  const result = await getJson<{ token: ZellijWebTokenInfo | null }>('/api/zellij-token');
  return result.token;
}

export async function regenerateZellijToken(): Promise<ZellijWebTokenInfo> {
  const result = await postJson<{ token: ZellijWebTokenInfo }>('/api/zellij-token/regenerate', {});
  return result.token;
}

export async function deleteZellijToken(): Promise<void> {
  await requestJson<void>('/api/zellij-token', {
    method: 'DELETE',
  });
}

export async function restartServices(): Promise<void> {
  await postJson<{ status: 'restarting' }>('/api/services/restart', {});
}

export function getCodexStatus(): Promise<CodexCliStatus> {
  return getJson<CodexCliStatus>('/api/codex/status');
}

export function getCodexAppearance(): Promise<CodexChatAppearance> {
  return getJson<CodexChatAppearance>('/api/codex/appearance');
}

export function getCodexActivity(): Promise<CodexConversationActivity> {
  return getJson<CodexConversationActivity>('/api/codex/activity');
}

export function getRepositoryContextFiles(repositoryId: string): Promise<RepositoryContextFileListing> {
  return getJson<RepositoryContextFileListing>(`/api/repositories/${encodeURIComponent(repositoryId)}/files`);
}

export async function getCodexConversation(repositoryId: string): Promise<CodexConversationSnapshot | null> {
  const result = await getJson<{ conversation: CodexConversationSnapshot | null }>(
    `/api/codex/conversations/${encodeURIComponent(repositoryId)}`,
  );
  return result.conversation;
}

const CODEX_CONVERSATION_EVENT_TYPES: CodexConversationStreamEvent['type'][] = [
  'conversation.snapshot',
  'turn.started',
  'thread.started',
  'turn.steered',
  'app-server.event',
  'message.delta',
  'message.completed',
  'activity.updated',
  'turn.completed',
  'conversation.cleared',
];

function applyCodexConversationEvent(
  current: CodexConversationSnapshot | null,
  event: CodexConversationStreamEvent,
): CodexConversationSnapshot | null {
  if (event.type === 'conversation.snapshot') return event.conversation;
  if (event.type === 'conversation.cleared') return null;
  if (event.type === 'app-server.event') return current;

  const baseMessages = current?.repositoryId === event.repositoryId ? current.messages : [];
  if (event.type === 'turn.started') {
    const replacingIds = new Set([event.userMessage.id, event.assistantMessage.id]);
    return {
      repositoryId: event.repositoryId,
      conversationId: event.conversationId,
      messages: [
        ...baseMessages.filter(message => !replacingIds.has(message.id)),
        event.userMessage,
        event.assistantMessage,
      ],
      ...(current?.repositoryId === event.repositoryId && current.activities
        ? { activities: current.activities }
        : {}),
      status: 'running',
      phase: event.phase,
      error: null,
      updatedAt: event.updatedAt,
    };
  }

  const base: CodexConversationSnapshot = current?.repositoryId === event.repositoryId
    ? current
    : {
      repositoryId: event.repositoryId,
      conversationId: event.conversationId,
      messages: [],
      status: 'running',
      error: null,
      updatedAt: event.updatedAt,
    };
  if (event.type === 'thread.started') {
    return {
      ...base,
      conversationId: event.conversationId,
      status: 'running',
      phase: event.phase,
      error: null,
      updatedAt: event.updatedAt,
    };
  }
  if (event.type === 'turn.steered') {
    const replacingIds = new Set([event.userMessage.id, event.assistantMessage.id]);
    return {
      ...base,
      conversationId: event.conversationId,
      messages: [
        ...base.messages.filter(message => !replacingIds.has(message.id)),
        event.userMessage,
        event.assistantMessage,
      ],
      status: 'running',
      phase: event.phase,
      error: null,
      updatedAt: event.updatedAt,
    };
  }
  if (event.type === 'message.delta') {
    const existingIndex = base.messages.findIndex(message => message.id === event.messageId);
    const messages = [...base.messages];
    if (existingIndex >= 0) {
      const existing = messages[existingIndex]!;
      messages[existingIndex] = { ...existing, content: `${existing.content}${event.delta}` };
    } else {
      messages.push({ id: event.messageId, role: 'assistant', content: event.delta });
    }
    return {
      ...base,
      conversationId: event.conversationId,
      messages,
      status: 'running',
      phase: event.phase,
      error: null,
      updatedAt: event.updatedAt,
    };
  }
  if (event.type === 'message.completed') {
    const messages = base.messages.some(message => message.id === event.message.id)
      ? base.messages.map(message => message.id === event.message.id ? event.message : message)
      : [...base.messages, event.message];
    return {
      ...base,
      conversationId: event.conversationId,
      messages,
      status: 'running',
      phase: event.phase,
      error: null,
      updatedAt: event.updatedAt,
    };
  }
  if (event.type === 'activity.updated') {
    const currentActivities = base.activities ?? [];
    const activities = currentActivities.some(activity => activity.id === event.activity.id)
      ? currentActivities.map(activity => activity.id === event.activity.id ? event.activity : activity)
      : [...currentActivities, event.activity];
    return {
      ...base,
      conversationId: event.conversationId,
      activities,
      status: 'running',
      phase: event.phase,
      error: null,
      updatedAt: event.updatedAt,
    };
  }

  const rollbackMessageIds = new Set(event.rollbackMessageIds ?? []);
  const remainingMessages = rollbackMessageIds.size > 0
    ? base.messages.filter(message => !rollbackMessageIds.has(message.id))
    : base.messages;
  const messages = event.assistantMessage
    ? remainingMessages.some(message => message.id === event.assistantMessageId)
      ? remainingMessages.map(message => message.id === event.assistantMessageId ? event.assistantMessage! : message)
      : [...remainingMessages, event.assistantMessage]
    : remainingMessages.filter(message => message.id !== event.assistantMessageId);
  const { phase: _phase, ...completedBase } = base;
  return {
    ...completedBase,
    conversationId: event.conversationId,
    messages,
    ...(rollbackMessageIds.size > 0
      ? { activities: (base.activities ?? []).filter(activity => !rollbackMessageIds.has(activity.assistantMessageId)) }
      : {}),
    status: event.status,
    error: event.error,
    updatedAt: event.updatedAt,
  };
}

export function subscribeCodexConversation(
  repositoryId: string,
  onSnapshot: (
    snapshot: CodexConversationSnapshot | null,
    event?: CodexConversationStreamEvent,
  ) => void,
  onError?: () => void,
): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;
  const source = new EventSource(`/api/codex/conversations/${encodeURIComponent(repositoryId)}/events`);
  let conversation: CodexConversationSnapshot | null = null;
  const handleEvent = (rawEvent: Event) => {
    try {
      const messageEvent = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(messageEvent.data) as CodexConversationStreamEvent;
      if (payload.type !== rawEvent.type) throw new Error('Codex event type mismatch');
      conversation = applyCodexConversationEvent(conversation, payload);
      onSnapshot(conversation, payload);
    } catch {
      onError?.();
    }
  };
  for (const eventType of CODEX_CONVERSATION_EVENT_TYPES) {
    source.addEventListener(eventType, handleEvent);
  }
  source.onerror = () => onError?.();
  const page = typeof window === 'undefined' ? null : window;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    page?.removeEventListener('pagehide', close);
    for (const eventType of CODEX_CONVERSATION_EVENT_TYPES) {
      source.removeEventListener(eventType, handleEvent);
    }
    source.close();
  };
  page?.addEventListener('pagehide', close, { once: true });
  return close;
}

export async function startCodexMessage(request: CodexChatRequest): Promise<CodexConversationSnapshot> {
  const result = await postJson<{ conversation: CodexConversationSnapshot }>('/api/codex/messages', request);
  return result.conversation;
}

export async function steerCodexConversation(
  repositoryId: string,
  message: string,
): Promise<CodexConversationSnapshot> {
  const result = await postJson<{ conversation: CodexConversationSnapshot }>(
    `/api/codex/conversations/${encodeURIComponent(repositoryId)}/steer`,
    { message },
  );
  return result.conversation;
}

export async function stopCodexConversation(repositoryId: string): Promise<void> {
  await postJson<{ status: 'stopping' }>(
    `/api/codex/conversations/${encodeURIComponent(repositoryId)}/stop`,
    {},
  );
}

export async function clearCodexConversation(repositoryId: string): Promise<void> {
  await requestJson<void>(`/api/codex/conversations/${encodeURIComponent(repositoryId)}`, {
    method: 'DELETE',
  });
}
