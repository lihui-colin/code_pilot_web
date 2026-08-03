import { afterEach, describe, expect, it, vi } from 'vitest';
import { getReadiness } from '../src/web/api.js';

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
});
