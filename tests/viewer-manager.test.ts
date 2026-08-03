import { describe, expect, it, vi } from 'vitest';
import {
  ViewerManager,
  type ViewerProcessAdapter,
  type ViewerProcessHandle,
} from '../src/services/viewer-manager.js';

function fixture() {
  let pid = 100;
  const handles: ViewerProcessHandle[] = [];
  const adapter: ViewerProcessAdapter = {
    start: vi.fn(async (_repositoryRealPath, port) => {
      let exited = false;
      const handle: ViewerProcessHandle = {
        pid: pid++,
        output: () => `GDP_LISTEN_URL=http://127.0.0.1:${port}/\n`,
        exited: () => exited,
        waitForExit: async () => undefined,
      };
      Object.defineProperty(handle, 'markExited', { value: () => { exited = true; } });
      handles.push(handle);
      return handle;
    }),
    healthy: vi.fn(async () => true),
    stop: vi.fn(async handle => {
      (handle as ViewerProcessHandle & { markExited(): void }).markExited();
    }),
  };
  return { adapter, manager: new ViewerManager(adapter, 8022, 'http://192.0.2.10:8024') };
}

describe('ViewerManager', () => {
  it('starts code-viewer on localhost port 8022 and reuses it for the same repository', async () => {
    const { adapter, manager } = fixture();
    const first = await manager.create(`dir_${'a'.repeat(43)}`, '/workspace/repository');
    const second = await manager.create(`dir_${'a'.repeat(43)}`, '/workspace/repository');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.instance.id).toBe(first.instance.id);
    expect(first.instance).toMatchObject({
      upstreamUrl: 'http://127.0.0.1:8022',
      webUrl: expect.stringMatching(/^http:\/\/192\.0\.2\.10:8024\/viewer\/viewer_/u),
      status: 'running',
    });
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it('stops the previous single-port viewer before opening another repository', async () => {
    const { adapter, manager } = fixture();
    await manager.create(`dir_${'a'.repeat(43)}`, '/workspace/one');
    await manager.create(`dir_${'b'.repeat(43)}`, '/workspace/two');
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledTimes(2);
  });
});
