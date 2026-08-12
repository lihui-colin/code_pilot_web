import { spawn } from 'node:child_process';
import { open, readFile, rename, rm } from 'node:fs/promises';
import net from 'node:net';

export interface OpenVSCodeServiceOptions {
  executablePath: string;
  port: number;
  workspaceRoot: string;
  pidFile: string;
  logFile: string;
}

/**
 * Manages the OpenVSCode upstream process on behalf of the management
 * service. The upstream is started lazily: the first request to the
 * /openvscode proxy ensures it is running, then proxies through. The process
 * is recorded in a PID file (same location used by scripts/service-runtime.mjs)
 * and is stopped when the management service shuts down.
 */
export class OpenVSCodeService {
  private readonly executablePath: string;
  private readonly port: number;
  private readonly workspaceRoot: string;
  private readonly pidFile: string;
  private readonly logFile: string;
  private ensurePromise: Promise<void> | null = null;

  constructor(options: OpenVSCodeServiceOptions) {
    this.executablePath = options.executablePath;
    this.port = options.port;
    this.workspaceRoot = options.workspaceRoot;
    this.pidFile = options.pidFile;
    this.logFile = options.logFile;
  }

  private portOpen(): Promise<boolean> {
    return new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
      socket.setTimeout(300);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
  }

  private async waitForPort(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.portOpen()) return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`OpenVSCode upstream did not become ready on port ${this.port}`);
  }

  private async writePidFile(pid: number): Promise<void> {
    const temporaryFile = `${this.pidFile}.tmp-${process.pid}`;
    const handle = await open(temporaryFile, 'wx', 0o600);
    try {
      await handle.writeFile(`${pid}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryFile, this.pidFile);
  }

  private async readPid(): Promise<number | null> {
    try {
      const content = await readFile(this.pidFile, 'utf8');
      const pid = Number(content.trim());
      return Number.isInteger(pid) && pid > 1 ? pid : null;
    } catch {
      return null;
    }
  }

  private async processGroup(pid: number): Promise<number> {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const match = /\)\s+(\S+)\s+(\S+)\s+(\S+)/u.exec(stat);
      return match ? Number(match[3]) : 0;
    } catch {
      return 0;
    }
  }

  private async commandMentionsOpenVSCode(pid: number): Promise<boolean> {
    try {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.split('\0').some(argument => argument.includes('openvscode'));
    } catch {
      return false;
    }
  }

  /** Ensure the OpenVSCode upstream is running, starting it lazily when needed. */
  async ensureRunning(): Promise<void> {
    if (await this.portOpen()) return;
    if (!this.ensurePromise) {
      this.ensurePromise = this.start().finally(() => { this.ensurePromise = null; });
    }
    await this.ensurePromise;
  }

  private async start(): Promise<void> {
    const logHandle = await open(this.logFile, 'a', 0o600);
    let childPid: number | null = null;
    try {
      const child = spawn(this.executablePath, [
        '--host', '127.0.0.1',
        '--port', String(this.port),
        '--server-base-path', '/openvscode',
        '--without-connection-token',
        '--accept-server-license-terms',
        '--telemetry-level', 'off',
      ], {
        cwd: this.workspaceRoot,
        detached: true,
        shell: false,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      if (!child.pid) throw new Error('OpenVSCode did not provide a process ID');
      childPid = child.pid;
      await this.writePidFile(child.pid);
      child.unref();
      try {
        await this.waitForPort(30_000);
      } catch (error) {
        await this.stopProcess(child.pid);
        await rm(this.pidFile, { force: true });
        throw error;
      }
    } finally {
      await logHandle.close();
      if (childPid === null) await rm(this.pidFile, { force: true });
    }
  }

  /** Stop the OpenVSCode process recorded in the PID file, if any. */
  async stop(): Promise<void> {
    const pid = await this.readPid();
    if (pid === null) return;
    await this.stopProcess(pid);
    await rm(this.pidFile, { force: true });
  }

  private async stopProcess(pid: number): Promise<void> {
    // Only touch a process that still looks like ours (guards against a
    // recycled PID). The spawned launcher is detached and acts as the process
    // group leader, so terminate the whole group to reach the real server.
    if (!(await this.commandMentionsOpenVSCode(pid))) return;
    const group = await this.processGroup(pid);
    const target = group > 1 && group === pid ? -group : pid;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(target, signal);
      } catch {
        break; // already gone
      }
      if (signal === 'SIGTERM') {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
  }
}
