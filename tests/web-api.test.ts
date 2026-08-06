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

  it('subscribes to same-origin Codex SSE snapshots and closes cleanly', () => {
    let source: { url: string; onmessage?: (event: MessageEvent) => void; onerror?: () => void; close: ReturnType<typeof vi.fn> };
    class FakeEventSource {
      onmessage?: (event: MessageEvent) => void;
      onerror?: () => void;
      close = vi.fn();
      constructor(public readonly url: string) {
        source = this;
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('window', new EventTarget());
    const received: unknown[] = [];
    const unsubscribe = subscribeCodexConversation(
      `dir_${'a'.repeat(43)}`,
      snapshot => received.push(snapshot),
    );

    source!.onmessage?.({ data: JSON.stringify({ conversation: { repositoryId: 'repo', status: 'running' } }) } as MessageEvent);
    window.dispatchEvent(new Event('pagehide'));
    unsubscribe();

    expect(source!.url).toBe(`/api/codex/conversations/dir_${'a'.repeat(43)}/events`);
    expect(received).toEqual([{ repositoryId: 'repo', status: 'running' }]);
    expect(source!.close).toHaveBeenCalledOnce();
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
