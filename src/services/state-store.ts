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

const stateV1Schema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionStateSchema),
  viewers: z.array(z.unknown()),
}).strict();

const stateV2Schema = z.object({
  version: z.literal(2),
  sessions: z.array(sessionStateSchema),
  viewers: z.array(z.unknown()),
  repositories: z.array(z.string().min(1)),
}).strict();

const stateSchema = z.union([stateV1Schema, stateV2Schema]);

interface StateFile {
  version: 2;
  sessions: Array<ManagedSessionMetadata & { name: string }>;
  viewers: unknown[];
  repositories: string[];
}

export class StateStore {
  private writeQueue = Promise.resolve();
  private state: StateFile = { version: 2, sessions: [], viewers: [], repositories: [] };

  constructor(private readonly stateFile = path.resolve('data/state.json')) {}

  async initialize(actualSessionNames: readonly string[] | null): Promise<Map<string, ManagedSessionMetadata>> {
    const loaded = await this.read();
    const state: StateFile = {
      version: 2,
      sessions: loaded.sessions,
      viewers: loaded.viewers,
      repositories: loaded.version === 2 ? loaded.repositories : [],
    };
    if (actualSessionNames === null) {
      this.state = state;
      if (loaded.version === 1) await this.write(this.state);
      return new Map(state.sessions.map(({ name, ...metadata }) => [name, metadata]));
    }
    const actualNames = new Set(actualSessionNames);
    const sessions = state.sessions.filter(session => actualNames.has(session.name));
    this.state = { ...state, sessions, viewers: [] };
    if (loaded.version === 1 || sessions.length !== state.sessions.length || state.viewers.length > 0) {
      await this.write(this.state);
    }
    return new Map(sessions.map(({ name, ...metadata }) => [name, metadata]));
  }

  repositoryPaths(): readonly string[] {
    return [...this.state.repositories];
  }

  persist(sessions: ReadonlyMap<string, ManagedSessionMetadata>): Promise<void> {
    return this.enqueue(state => ({
      ...state,
      sessions: [...sessions.entries()]
        .map(([name, metadata]) => ({ name, ...metadata }))
        .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))),
    }));
  }

  persistRepositoryPaths(repositoryPaths: readonly string[]): Promise<void> {
    return this.enqueue(state => ({
      ...state,
      repositories: [...new Set(repositoryPaths)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    }));
  }

  private enqueue(update: (state: StateFile) => StateFile): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const next = update(this.state);
      await this.write(next);
      this.state = next;
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async read(): Promise<z.infer<typeof stateSchema>> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.stateFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, sessions: [], viewers: [], repositories: [] };
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
