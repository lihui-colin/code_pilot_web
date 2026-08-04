import type {
  CodexChatAppearance,
  CodexChatRequest,
  CodexCliStatus,
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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(body.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(result.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return response.json() as Promise<T>;
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

export function getRepositoryFolders(directoryId?: string): Promise<RepositoryFolderListing> {
  const query = directoryId ? `?directoryId=${encodeURIComponent(directoryId)}` : '';
  return getJson<RepositoryFolderListing>(`/api/repository-folders${query}`);
}

export async function addManualRepository(directoryId: string): Promise<string> {
  const result = await postJson<{ repositoryId: string }>('/api/repositories', { directoryId });
  return result.repositoryId;
}

export async function deleteManualRepository(repositoryId: string): Promise<void> {
  const response = await fetch(`/api/repositories/${encodeURIComponent(repositoryId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(result.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
}

export function createSession(repositoryId: string): Promise<SessionInfo> {
  return postJson<SessionInfo>('/api/sessions', { repositoryId, command: 'codex' });
}

export async function deleteSession(name: string): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(result.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
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
  const response = await fetch('/api/zellij-token', {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(result.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
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

export function getRepositoryContextFiles(repositoryId: string): Promise<RepositoryContextFileListing> {
  return getJson<RepositoryContextFileListing>(`/api/repositories/${encodeURIComponent(repositoryId)}/files`);
}

export async function getCodexConversation(repositoryId: string): Promise<CodexConversationSnapshot | null> {
  const result = await getJson<{ conversation: CodexConversationSnapshot | null }>(
    `/api/codex/conversations/${encodeURIComponent(repositoryId)}`,
  );
  return result.conversation;
}

export async function startCodexMessage(request: CodexChatRequest): Promise<CodexConversationSnapshot> {
  const result = await postJson<{ conversation: CodexConversationSnapshot }>('/api/codex/messages', request);
  return result.conversation;
}

export async function stopCodexConversation(repositoryId: string): Promise<void> {
  await postJson<{ status: 'stopping' }>(
    `/api/codex/conversations/${encodeURIComponent(repositoryId)}/stop`,
    {},
  );
}

export async function clearCodexConversation(repositoryId: string): Promise<void> {
  const response = await fetch(`/api/codex/conversations/${encodeURIComponent(repositoryId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(result.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
}
