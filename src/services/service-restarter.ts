import { closeSync, fchmodSync, openSync } from 'node:fs';
import { spawn, type SpawnOptions } from 'node:child_process';

export interface ServiceRestarter {
  restart(): Promise<void>;
}

type SpawnProcess = (
  command: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => ReturnType<typeof spawn>;

export class SpawnServiceRestarter implements ServiceRestarter {
  constructor(
    private readonly scriptFile: string,
    private readonly workspaceRoot: string,
    private readonly configFile: string,
    private readonly logFile: string,
    private readonly spawnProcess: SpawnProcess = spawn,
  ) {}

  async restart(): Promise<void> {
    const logDescriptor = openSync(this.logFile, 'a', 0o600);
    try {
      fchmodSync(logDescriptor, 0o600);
      const child = this.spawnProcess(this.scriptFile, [this.workspaceRoot, this.configFile], {
        cwd: this.workspaceRoot,
        detached: true,
        env: { ...process.env, CODEPILOT_WEB_RESTART_DELAY_MS: '750' },
        shell: false,
        stdio: ['ignore', logDescriptor, logDescriptor],
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } finally {
      closeSync(logDescriptor);
    }
  }
}
