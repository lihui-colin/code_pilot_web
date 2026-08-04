import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addManualRepository,
  getCodexStatus,
  getReadiness,
  getRepositoryContextFiles,
  getRepositoryFolders,
  restartServices,
  streamCodexMessage,
} from '../src/web/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web API', () => {
  it('treats a 503 readiness response as a readable not-ready result', async () => {
    const result = {
      status: 'not_ready' as const,
      checks: { workspaceRoot: true, directoryIdSecret: true, node: false, zellij: true, codeViewer: false },
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

  it('browses and selects server folders using only opaque IDs', async () => {
    const folderId = `folder_${'f'.repeat(43)}`;
    const repositoryId = `dir_${'r'.repeat(43)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        current: { id: folderId, name: 'projects', gitRepository: false }, parentId: null, entries: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repositoryId }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await getRepositoryFolders(folderId);
    await expect(addManualRepository(folderId)).resolves.toBe(repositoryId);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/repository-folders?directoryId=${folderId}`,
      { credentials: 'same-origin' },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/repositories', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directoryId: folderId }),
    });
  });

  it('parses streamed Codex NDJSON events', async () => {
    const events = [
      { type: 'conversation', conversationId: '123e4567-e89b-42d3-a456-426614174000' },
      { type: 'assistant_delta', delta: 'Hello' },
      { type: 'done' },
    ] as const;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
    )));
    const received: unknown[] = [];

    await streamCodexMessage({
      repositoryId: `dir_${'a'.repeat(43)}`,
      message: 'Hello',
    }, event => received.push(event));

    expect(received).toEqual(events);
  });
});
