import { afterEach, describe, expect, it, vi } from 'vitest';
import { getReadiness, restartServices } from '../src/web/api.js';

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
});
