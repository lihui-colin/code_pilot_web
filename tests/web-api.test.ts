import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addManualRepository,
  clearCodexConversation,
  getCodexConversation,
  getCodexStatus,
  getReadiness,
  getRepositoryContextFiles,
  getRepositoryFolders,
  restartServices,
  startCodexMessage,
  steerCodexConversation,
  stopCodexConversation,
  subscribeCodexConversation,
} from '../src/web/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web API', () => {
  it('treats a 503 readiness response as a readable not-ready result', async () => {
    const result = {
      status: 'not_ready' as const,
      checks: { workspaceRoot: true, state: true, directoryIdSecret: true, node: false, zellij: true, codeViewer: false },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(result), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(getReadiness()).resolves.toEqual(result);
  });

  it('requests a fixed same-origin backend service restart', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'restarting' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await restartServices();

    expect(fetchMock).toHaveBeenCalledWith('/api/services/restart', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('reads Codex CLI availability from the server', async () => {
    const status = { available: true, version: 'codex-cli 0.146.0' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(status), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCodexStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith('/api/codex/status', { credentials: 'same-origin' });
  });

  it('loads attachable files using only the repository ID', async () => {
    const listing = {
      files: [{ id: `file_${'b'.repeat(43)}`, relativePath: 'src/app.ts', size: 123 }],
      truncated: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(listing), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const repositoryId = `dir_${'a'.repeat(43)}`;

    await expect(getRepositoryContextFiles(repositoryId)).resolves.toEqual(listing);
    expect(fetchMock).toHaveBeenCalledWith(`/api/repositories/${repositoryId}/files`, {
      credentials: 'same-origin',
    });
  });

  it('browses server folders by opaque IDs and relative initial paths', async () => {
    const folderId = `folder_${'f'.repeat(43)}`;
    const repositoryId = `dir_${'r'.repeat(43)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        current: { id: folderId, name: 'projects', relativePath: 'data01/projects', gitRepository: false }, parentId: null, entries: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        current: { id: folderId, name: 'projects', relativePath: 'data01/projects', gitRepository: false }, parentId: null, entries: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repositoryId }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await getRepositoryFolders(folderId);
    await getRepositoryFolders(undefined, 'data01/home/lihui/projects');
    await expect(addManualRepository(folderId)).resolves.toBe(repositoryId);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/repository-folders?directoryId=${folderId}`,
      { credentials: 'same-origin' },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/repository-folders?initialPath=data01%2Fhome%2Flihui%2Fprojects',
      { credentials: 'same-origin' },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/repositories', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directoryId: folderId }),
    });
  });

  it('starts, reads, stops, and clears a background Codex conversation', async () => {
    const repositoryId = `dir_${'a'.repeat(43)}`;
    const snapshot = {
      repositoryId,
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      messages: [{ id: 'user-1', role: 'user', content: 'Hello' }],
      status: 'running',
      error: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ conversation: snapshot }), {
        status: 202, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ conversation: snapshot }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'stopping' }), {
        status: 202, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(startCodexMessage({ repositoryId, message: 'Hello' })).resolves.toEqual(snapshot);
    await expect(getCodexConversation(repositoryId)).resolves.toEqual(snapshot);
    await stopCodexConversation(repositoryId);
    await clearCodexConversation(repositoryId);

    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/codex/conversations/${repositoryId}`, {
      credentials: 'same-origin',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, `/api/codex/conversations/${repositoryId}/stop`, expect.objectContaining({
      method: 'POST', body: '{}',
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, `/api/codex/conversations/${repositoryId}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
  });

  it('sends interactive input only to the fixed Codex steer endpoint', async () => {
    const repositoryId = `dir_${'a'.repeat(43)}`;
    const snapshot = {
      repositoryId,
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      messages: [],
      status: 'running',
      phase: 'generating',
      error: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversation: snapshot }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(steerCodexConversation(repositoryId, 'Also run tests')).resolves.toEqual(snapshot);

    expect(fetchMock).toHaveBeenCalledWith(`/api/codex/conversations/${repositoryId}/steer`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Also run tests' }),
    });
  });

  it('reduces typed same-origin Codex SSE events into snapshots and closes cleanly', () => {
    let source: FakeEventSource;
    class FakeEventSource extends EventTarget {
      onerror?: () => void;
      close = vi.fn();
      constructor(public readonly url: string) {
        super();
        source = this;
      }

      emit(type: string, payload: unknown): void {
        this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }));
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('window', new EventTarget());
    const received: unknown[] = [];
    const eventTypes: string[] = [];
    const unsubscribe = subscribeCodexConversation(
      `dir_${'a'.repeat(43)}`,
      (snapshot, event) => {
        received.push(snapshot);
        if (event) eventTypes.push(event.type);
      },
    );

    source!.emit('conversation.snapshot', {
      type: 'conversation.snapshot',
      conversation: null,
    });
    source!.emit('turn.started', {
      type: 'turn.started',
      repositoryId: 'repo',
      conversationId: null,
      userMessage: { id: 'user-live', role: 'user', content: '问题' },
      assistantMessage: { id: 'assistant-live', role: 'assistant', content: '' },
      phase: 'starting',
      updatedAt: '2026-08-04T00:00:00.000Z',
    });
    source!.emit('thread.started', {
      type: 'thread.started',
      repositoryId: 'repo',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      phase: 'generating',
      updatedAt: '2026-08-04T00:00:00.500Z',
    });
    source!.emit('app-server.event', {
      type: 'app-server.event',
      repositoryId: 'repo',
      event: {
        id: 'app-server-1',
        sequence: 1,
        kind: 'notification',
        method: 'turn/started',
        requestId: null,
        threadId: '123e4567-e89b-42d3-a456-426614174000',
        turnId: 'turn-live',
        itemId: null,
        status: 'received',
        updatedAt: '2026-08-04T00:00:00.600Z',
      },
      updatedAt: '2026-08-04T00:00:00.600Z',
    });
    source!.emit('turn.steered', {
      type: 'turn.steered',
      repositoryId: 'repo',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      userMessage: { id: 'user-steered', role: 'user', content: '再运行测试' },
      assistantMessage: { id: 'assistant-steered', role: 'assistant', content: '' },
      phase: 'generating',
      updatedAt: '2026-08-04T00:00:00.700Z',
    });
    source!.emit('activity.updated', {
      type: 'activity.updated',
      repositoryId: 'repo',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      activity: {
        id: 'activity-thinking',
        assistantMessageId: 'assistant-steered',
        kind: 'thinking',
        title: '思考',
        status: 'running',
        detail: '分析代码',
      },
      phase: 'generating',
      updatedAt: '2026-08-04T00:00:00.750Z',
    });
    source!.emit('message.delta', {
      type: 'message.delta',
      repositoryId: 'repo',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      messageId: 'assistant-steered',
      delta: '实时输出',
      phase: 'generating',
      updatedAt: '2026-08-04T00:00:01.000Z',
    });
    source!.emit('message.completed', {
      type: 'message.completed',
      repositoryId: 'repo',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      message: { id: 'assistant-steered', role: 'assistant', content: '实时输出完成' },
      phase: 'generating',
      updatedAt: '2026-08-04T00:00:02.000Z',
    });
    source!.emit('turn.completed', {
      type: 'turn.completed',
      repositoryId: 'repo',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      assistantMessageId: 'assistant-steered',
      assistantMessage: { id: 'assistant-steered', role: 'assistant', content: '实时输出完成' },
      status: 'idle',
      error: null,
      updatedAt: '2026-08-04T00:00:03.000Z',
    });
    source!.emit('conversation.cleared', {
      type: 'conversation.cleared',
      repositoryId: 'repo',
      updatedAt: '2026-08-04T00:00:04.000Z',
    });
    window.dispatchEvent(new Event('pagehide'));
    unsubscribe();

    expect(source!.url).toBe(`/api/codex/conversations/dir_${'a'.repeat(43)}/events`);
    expect(eventTypes).toEqual([
      'conversation.snapshot',
      'turn.started',
      'thread.started',
      'app-server.event',
      'turn.steered',
      'activity.updated',
      'message.delta',
      'message.completed',
      'turn.completed',
      'conversation.cleared',
    ]);
    expect(received.at(-2)).toMatchObject({
      repositoryId: 'repo',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      messages: [
        { content: '问题' },
        { content: '' },
        { content: '再运行测试' },
        { content: '实时输出完成' },
      ],
      activities: [{ title: '思考', detail: '分析代码' }],
      status: 'idle',
    });
    expect(received.at(-1)).toBeNull();
    expect(source!.close).toHaveBeenCalledOnce();
  });

  it('removes both local placeholders when a completed event rolls back a writer conflict', () => {
    let source: FakeEventSource;
    class FakeEventSource extends EventTarget {
      onerror?: () => void;
      close = vi.fn();
      constructor(public readonly url: string) {
        super();
        source = this;
      }

      emit(type: string, payload: unknown): void {
        this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }));
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('window', new EventTarget());
    const received: unknown[] = [];
    const unsubscribe = subscribeCodexConversation('repo', snapshot => received.push(snapshot));

    source!.emit('conversation.snapshot', {
      type: 'conversation.snapshot',
      conversation: {
        repositoryId: 'repo',
        conversationId: '123e4567-e89b-42d3-a456-426614174000',
        messages: [
          { id: 'user-existing', role: 'user', content: '已有问题' },
          { id: 'assistant-existing', role: 'assistant', content: '已有回复' },
        ],
        status: 'idle',
        error: null,
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    });
    source!.emit('turn.started', {
      type: 'turn.started',
      repositoryId: 'repo',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      userMessage: { id: 'user-retry', role: 'user', content: '重试' },
      assistantMessage: { id: 'assistant-retry', role: 'assistant', content: '' },
      phase: 'starting',
      updatedAt: '2026-08-09T00:00:01.000Z',
    });
    source!.emit('turn.completed', {
      type: 'turn.completed',
      repositoryId: 'repo',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      assistantMessageId: 'assistant-retry',
      assistantMessage: null,
      rollbackMessageIds: ['user-retry', 'assistant-retry'],
      status: 'failed',
      error: '该对话正在另一个 Codex 客户端中使用，请关闭该客户端或新建对话。',
      updatedAt: '2026-08-09T00:00:02.000Z',
    });

    expect(received.at(-1)).toMatchObject({
      messages: [
        { id: 'user-existing', content: '已有问题' },
        { id: 'assistant-existing', content: '已有回复' },
      ],
      status: 'failed',
      error: '该对话正在另一个 Codex 客户端中使用，请关闭该客户端或新建对话。',
    });
    unsubscribe();
  });

  it('reads running Codex repository activity', async () => {
    const activity = { runningRepositoryIds: [`dir_${'a'.repeat(43)}`] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(activity), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { getCodexActivity } = await import('../src/web/api.js');
    await expect(getCodexActivity()).resolves.toEqual(activity);
    expect(fetchMock).toHaveBeenCalledWith('/api/codex/activity', { credentials: 'same-origin' });
  });
});
