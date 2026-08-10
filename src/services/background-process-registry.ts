import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export type BackgroundProcessKind = 'codex' | 'viewer';

interface BackgroundProcessEntry {
  kind: BackgroundProcessKind;
  pid: number;
  processGroup: number;
  startTime: string;
  arguments: string[];
}

export interface BackgroundProcessRegistration {
  release(): Promise<void>;
}

export interface BackgroundProcessRegistry {
  register(kind: BackgroundProcessKind, pid: number): Promise<BackgroundProcessRegistration>;
}

async function processIdentity(pid: number): Promise<Omit<BackgroundProcessEntry, 'kind' | 'pid'>> {
  const [stat, commandLine] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile(`/proc/${pid}/cmdline`),
  ]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const processGroup = Number(fields[2]);
  const startTime = fields[19];
  const arguments_ = commandLine.toString('utf8').split('\0').filter(Boolean);
  if (!Number.isInteger(processGroup) || processGroup < 1 || !startTime || arguments_.length === 0) {
    throw new Error(`background process ${pid} identity could not be verified`);
  }
  return { processGroup, startTime, arguments: arguments_ };
}

export class FileBackgroundProcessRegistry implements BackgroundProcessRegistry {
  private operation = Promise.resolve();

  constructor(private readonly registryFile: string) {}

  async register(kind: BackgroundProcessKind, pid: number): Promise<BackgroundProcessRegistration> {
    const identity = await processIdentity(pid);
    const entry: BackgroundProcessEntry = { kind, pid, ...identity };
    await this.serialized(async () => {
      const entries = await this.readEntries();
      entries.push(entry);
      await this.writeEntries(entries);
    });
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.serialized(async () => {
          const entries = await this.readEntries();
          await this.writeEntries(entries.filter(candidate => (
            candidate.pid !== entry.pid || candidate.startTime !== entry.startTime
          )));
        });
      },
    };
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readEntries(): Promise<BackgroundProcessEntry[]> {
    try {
      const value = JSON.parse(await readFile(this.registryFile, 'utf8')) as unknown;
      if (!Array.isArray(value)) throw new Error('Invalid background process registry');
      return value as BackgroundProcessEntry[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeEntries(entries: BackgroundProcessEntry[]): Promise<void> {
    if (entries.length === 0) {
      await rm(this.registryFile, { force: true });
      return;
    }
    await mkdir(path.dirname(this.registryFile), { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.registryFile}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(temporaryFile, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entries, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryFile, this.registryFile);
    await chmod(this.registryFile, 0o600);
  }
}
