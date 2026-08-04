import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { ViewerInstance } from '../domain/types.js';
import { ApiError } from '../errors.js';

const MAX_OUTPUT_BYTES = 64 * 1024;

export interface ViewerProcessHandle {
  pid: number;
  output(): string;
  exited(): boolean;
  waitForExit(): Promise<void>;
}

export interface ViewerProcessAdapter {
  start(repositoryRealPath: string, port: number): Promise<ViewerProcessHandle>;
  healthy(port: number): Promise<boolean>;
  stop(process: ViewerProcessHandle): Promise<void>;
}

function limitedAppend(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_BYTES);
}

export class SpawnViewerProcessAdapter implements ViewerProcessAdapter {
  constructor(private readonly executablePath = 'code-viewer') {}

  async start(repositoryRealPath: string, port: number): Promise<ViewerProcessHandle> {
    const child = spawn(this.executablePath, ['--cwd', repositoryRealPath, '--port', String(port)], {
      cwd: repositoryRealPath,
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output = limitedAppend(output, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { output = limitedAppend(output, chunk); });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (!child.pid) throw new Error('code-viewer did not provide a process ID');
    let hasExited = false;
    const exitPromise = new Promise<void>(resolve => child.once('exit', () => {
      hasExited = true;
      resolve();
    }));
    return {
      pid: child.pid,
      output: () => output,
      exited: () => hasExited,
      waitForExit: () => exitPromise,
    };
  }

  async healthy(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      return response.status >= 200 && response.status < 400;
    } catch {
      return false;
    }
  }

  async stop(handle: ViewerProcessHandle): Promise<void> {
    if (handle.exited()) return;
    try {
      process.kill(-handle.pid, 'SIGTERM');
    } catch {
      return;
    }
    const stopped = await Promise.race([
      handle.waitForExit().then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (stopped) return;
    try {
      process.kill(-handle.pid, 'SIGKILL');
    } catch {
      return;
    }
    await handle.waitForExit();
  }
}

interface ActiveViewer {
  instance: ViewerInstance;
  process: ViewerProcessHandle;
}

export class ViewerManager {
  private active: ActiveViewer | null = null;
  private starting: Promise<ViewerInstance> | null = null;

  constructor(
    private readonly adapter: ViewerProcessAdapter,
    private readonly port: number,
    private readonly publicBaseUrl: string,
  ) {}

  currentFor(repositoryId: string): ViewerInstance | null {
    return this.active?.instance.repositoryId === repositoryId ? this.active.instance : null;
  }

  upstreamFor(viewerId: string): string | null {
    if (this.active?.instance.id !== viewerId || this.active.instance.status !== 'running') return null;
    this.active.instance.lastAccessedAt = new Date().toISOString();
    return this.active.instance.upstreamUrl;
  }

  activeViewerId(): string | null {
    return this.active?.instance.status === 'running' ? this.active.instance.id : null;
  }

  async create(repositoryId: string, repositoryRealPath: string): Promise<{ instance: ViewerInstance; created: boolean }> {
    if (this.starting) {
      const instance = await this.starting;
      if (instance.repositoryId === repositoryId) return { instance, created: false };
    }
    if (this.active?.instance.repositoryId === repositoryId && await this.adapter.healthy(this.port)) {
      return { instance: this.active.instance, created: false };
    }
    if (this.active) await this.stopActive();

    const operation = this.start(repositoryId, repositoryRealPath);
    this.starting = operation;
    try {
      return { instance: await operation, created: true };
    } finally {
      this.starting = null;
    }
  }

  private async start(repositoryId: string, repositoryRealPath: string): Promise<ViewerInstance> {
    const process = await this.adapter.start(repositoryRealPath, this.port);
    const id = `viewer_${randomBytes(16).toString('base64url')}`;
    const now = new Date().toISOString();
    const instance: ViewerInstance = {
      id,
      repositoryId,
      pid: process.pid,
      upstreamUrl: `http://127.0.0.1:${this.port}`,
      webUrl: new URL(`/viewer/${id}/`, `${this.publicBaseUrl}/`).toString(),
      createdAt: now,
      lastAccessedAt: now,
      status: 'starting',
    };
    this.active = { instance, process };
    void process.waitForExit().then(() => {
      if (process.exited() && this.active?.process === process) this.active = null;
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !process.exited()) {
      if (await this.adapter.healthy(this.port)) {
        const expected = `GDP_LISTEN_URL=http://127.0.0.1:${this.port}/`;
        if (process.output().includes(expected)) {
          instance.status = 'running';
          return instance;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    instance.status = 'failed';
    await this.adapter.stop(process);
    this.active = null;
    throw new ApiError(502, 'VIEWER_START_FAILED', 'code-viewer could not be started');
  }

  async stopActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.instance.status = 'stopping';
    await this.adapter.stop(active.process);
    if (this.active === active) this.active = null;
  }

  async stopFor(repositoryId: string): Promise<void> {
    if (this.starting) {
      try {
        const instance = await this.starting;
        if (instance.repositoryId !== repositoryId) return;
      } catch {
        // A failed start cannot leave a running viewer for this repository.
      }
    }
    if (this.active?.instance.repositoryId === repositoryId) await this.stopActive();
  }

  async close(): Promise<void> {
    await this.stopActive();
  }
}
