import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import type { SessionInfo } from '../domain/types.js';
import { ApiError } from '../errors.js';

const execFileAsync = promisify(execFile);
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const NO_ACTIVE_SESSIONS_OUTPUT = 'No active zellij sessions found.';

export function isNoActiveSessionsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const output = `${'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''}\n${
    'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  }`;
  return output.split(/\r?\n/u).some(line => line.trim() === NO_ACTIVE_SESSIONS_OUTPUT);
}

export interface ZellijAdapter {
  listSessions(): Promise<string>;
  createSession?(arguments_: string[], cwd: string): Promise<void>;
  deleteSession?(arguments_: string[]): Promise<void>;
}

export interface ManagedSessionMetadata {
  repositoryId: string;
  relativePath: string;
  createdAt: string;
  command: string;
}

export class ExecFileZellijAdapter implements ZellijAdapter {
  constructor(private readonly executablePath = 'zellij') {}

  async listSessions(): Promise<string> {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name === 'ZELLIJ' || name.startsWith('ZELLIJ_')) delete env[name];
    }
    try {
      const { stdout } = await execFileAsync(this.executablePath, ['list-sessions', '--short'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        shell: false,
        env,
      });
      return stdout;
    } catch (error) {
      if (isNoActiveSessionsError(error)) return '';
      throw error;
    }
  }

  async createSession(arguments_: string[], cwd: string): Promise<void> {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name === 'ZELLIJ' || name.startsWith('ZELLIJ_')) delete env[name];
    }
    await execFileAsync(this.executablePath, arguments_, {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      shell: false,
      env,
    });
  }

  async deleteSession(arguments_: string[]): Promise<void> {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name === 'ZELLIJ' || name.startsWith('ZELLIJ_')) delete env[name];
    }
    await execFileAsync(this.executablePath, arguments_, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      shell: false,
      env,
    });
  }
}

export function repositorySessionName(repositoryName: string, repositoryId: string, duplicateName = false): string {
  if (!/^dir_[A-Za-z0-9_-]{43}$/u.test(repositoryId)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Repository ID is invalid');
  }
  const baseName = repositoryName.replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 64) || 'codex';
  if (!duplicateName) return baseName;
  const suffix = repositoryId.slice(-8);
  return `${baseName.slice(0, 55)}-${suffix}`;
}

export function parseSessionNames(output: string, warn: (line: string) => void = () => undefined): string[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    if (!SESSION_NAME_PATTERN.test(line)) {
      warn(line);
      continue;
    }
    names.add(line);
  }
  return [...names].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export class ZellijService {
  private readonly createLocks = new Map<string, Promise<SessionInfo>>();
  private readonly repositorySessionLocks = new Map<string, Promise<{ session: SessionInfo; created: boolean }>>();
  private readonly deleteLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly adapter: ZellijAdapter,
    private readonly zellijWebBaseUrl: string,
    private readonly logger: FastifyBaseLogger,
    private readonly managedSessions: Map<string, ManagedSessionMetadata> = new Map(),
    private readonly layoutsDirectory = path.resolve('data/layouts'),
    private readonly persistManagedSessions: (sessions: ReadonlyMap<string, ManagedSessionMetadata>) => Promise<void> = async () => undefined,
  ) {}

  async listSessions(): Promise<SessionInfo[]> {
    const output = await this.adapter.listSessions();
    const names = parseSessionNames(output, line => {
      this.logger.warn({ outputLineLength: line.length }, 'ignored invalid zellij session output line');
    });
    return names.map(name => {
      const metadata = this.managedSessions.get(name);
      return {
        name,
        status: 'running',
        origin: metadata ? 'managed' : 'external',
        repositoryId: metadata?.repositoryId ?? null,
        relativePath: metadata?.relativePath ?? null,
        createdAt: metadata?.createdAt ?? null,
        command: metadata?.command ?? null,
        webUrl: new URL(encodeURIComponent(name), `${this.zellijWebBaseUrl}/`).toString(),
      };
    });
  }

  async createSession(
    name: string,
    repositoryId: string,
    relativePath: string,
    repositoryRealPath: string,
  ): Promise<SessionInfo> {
    const existingLock = this.createLocks.get(name);
    if (existingLock) {
      await existingLock;
      throw new ApiError(409, 'SESSION_ALREADY_EXISTS', 'Session name already exists');
    }
    const operation = this.createSessionUnlocked(name, repositoryId, relativePath, repositoryRealPath);
    this.createLocks.set(name, operation);
    try {
      return await operation;
    } finally {
      this.createLocks.delete(name);
    }
  }

  async ensureRepositorySession(
    name: string,
    repositoryId: string,
    relativePath: string,
    repositoryRealPath: string,
  ): Promise<{ session: SessionInfo; created: boolean }> {
    const existingLock = this.repositorySessionLocks.get(name);
    if (existingLock) return { session: (await existingLock).session, created: false };
    const operation = this.ensureRepositorySessionUnlocked(
      name, repositoryId, relativePath, repositoryRealPath,
    );
    this.repositorySessionLocks.set(name, operation);
    try {
      return await operation;
    } finally {
      this.repositorySessionLocks.delete(name);
    }
  }

  private async ensureRepositorySessionUnlocked(
    name: string,
    repositoryId: string,
    relativePath: string,
    repositoryRealPath: string,
  ): Promise<{ session: SessionInfo; created: boolean }> {
    const existing = (await this.listSessions()).find(session => session.name === name);
    if (existing) return { session: existing, created: false };
    return {
      session: await this.createSession(name, repositoryId, relativePath, repositoryRealPath),
      created: true,
    };
  }

  async deleteSession(name: string): Promise<void> {
    if (!SESSION_NAME_PATTERN.test(name)) throw new ApiError(400, 'INVALID_REQUEST', 'Session name is invalid');
    const ensuring = this.repositorySessionLocks.get(name);
    if (ensuring) {
      try {
        await ensuring;
      } catch {
        // The existence check below determines the final result.
      }
    }
    const creating = this.createLocks.get(name);
    if (creating) {
      try {
        await creating;
      } catch {
        // The existence check below determines the final result.
      }
    }
    const existingDelete = this.deleteLocks.get(name);
    if (existingDelete) {
      await existingDelete;
      throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session does not exist');
    }
    const operation = this.deleteSessionUnlocked(name);
    this.deleteLocks.set(name, operation);
    try {
      await operation;
    } finally {
      this.deleteLocks.delete(name);
    }
  }

  private async deleteSessionUnlocked(name: string): Promise<void> {
    if (!this.adapter.deleteSession) throw new ApiError(503, 'SERVICE_NOT_READY', 'Session deletion is not ready');
    const existing = parseSessionNames(await this.adapter.listSessions());
    if (!existing.includes(name)) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session does not exist');
    try {
      await this.adapter.deleteSession(['delete-session', '--force', name]);
    } catch {
      throw new ApiError(502, 'ZELLIJ_DELETE_FAILED', 'Zellij could not delete the Session');
    }
    const remaining = parseSessionNames(await this.adapter.listSessions());
    if (remaining.includes(name)) throw new ApiError(502, 'ZELLIJ_DELETE_FAILED', 'Zellij did not delete the Session');
    this.managedSessions.delete(name);
    try {
      await this.persistManagedSessions(this.managedSessions);
    } catch {
      throw new ApiError(500, 'STATE_WRITE_FAILED', 'Session was deleted but state could not be updated');
    }
  }

  private async createSessionUnlocked(
    name: string,
    repositoryId: string,
    relativePath: string,
    repositoryRealPath: string,
  ): Promise<SessionInfo> {
    if (!this.adapter.createSession) throw new ApiError(503, 'SERVICE_NOT_READY', 'Session creation is not ready');
    const existing = parseSessionNames(await this.adapter.listSessions());
    if (existing.includes(name)) throw new ApiError(409, 'SESSION_ALREADY_EXISTS', 'Session name already exists');

    await mkdir(this.layoutsDirectory, { recursive: true, mode: 0o700 });
    const temporaryDirectory = await mkdtemp(path.join(this.layoutsDirectory, '.session-'));
    const layoutPath = path.join(temporaryDirectory, 'codex.kdl');
    try {
      await writeFile(layoutPath, 'layout {\n    pane command="codex"\n}\n', { mode: 0o600 });
      await this.adapter.createSession([
        '--layout',
        layoutPath,
        'attach',
        '--create-background',
        name,
        'options',
        '--default-cwd',
        repositoryRealPath,
      ], repositoryRealPath);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }

    const created = parseSessionNames(await this.adapter.listSessions());
    if (!created.includes(name)) throw new ApiError(502, 'ZELLIJ_CREATE_FAILED', 'Zellij did not create the requested Session');
    this.managedSessions.set(name, {
      repositoryId,
      relativePath,
      createdAt: new Date().toISOString(),
      command: 'codex',
    });
    try {
      await this.persistManagedSessions(this.managedSessions);
    } catch {
      throw new ApiError(500, 'STATE_WRITE_FAILED', 'Session was created but state could not be updated');
    }
    const session = (await this.listSessions()).find(candidate => candidate.name === name);
    if (!session) throw new ApiError(502, 'ZELLIJ_CREATE_FAILED', 'Zellij did not create the requested Session');
    return session;
  }
}
