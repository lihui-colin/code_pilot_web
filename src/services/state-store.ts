import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ManagedSessionMetadata } from './zellij-service.js';

const sessionStateSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  repositoryId: z.string(),
  relativePath: z.string(),
  createdAt: z.string(),
  command: z.string(),
}).strict();

const stateSchema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionStateSchema),
  viewers: z.array(z.unknown()),
}).strict();

interface StateFile {
  version: 1;
  sessions: Array<ManagedSessionMetadata & { name: string }>;
  viewers: unknown[];
}

export class StateStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly stateFile = path.resolve('data/state.json')) {}

  async initialize(actualSessionNames: readonly string[] | null): Promise<Map<string, ManagedSessionMetadata>> {
    const state = await this.read();
    if (actualSessionNames === null) {
      return new Map(state.sessions.map(({ name, ...metadata }) => [name, metadata]));
    }
    const actualNames = new Set(actualSessionNames);
    const sessions = state.sessions.filter(session => actualNames.has(session.name));
    if (sessions.length !== state.sessions.length || state.viewers.length > 0) {
      await this.write({ version: 1, sessions, viewers: [] });
    }
    return new Map(sessions.map(({ name, ...metadata }) => [name, metadata]));
  }

  persist(sessions: ReadonlyMap<string, ManagedSessionMetadata>): Promise<void> {
    const state: StateFile = {
      version: 1,
      sessions: [...sessions.entries()]
        .map(([name, metadata]) => ({ name, ...metadata }))
        .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))),
      viewers: [],
    };
    const operation = this.writeQueue.then(() => this.write(state));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async read(): Promise<StateFile> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.stateFile, 'utf8'))) as StateFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, sessions: [], viewers: [] };
      }
      throw error;
    }
  }

  private async write(state: StateFile): Promise<void> {
    const directory = path.dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.stateFile}.tmp-${process.pid}-${Date.now()}`;
    const file = await open(temporaryFile, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryFile, this.stateFile);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}
