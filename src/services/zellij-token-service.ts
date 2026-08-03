import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { ZellijWebToken } from '../config.js';

const execFileAsync = promisify(execFile);
export interface ZellijTokenServiceDependencies {
  run?: (arguments_: string[]) => Promise<string>;
  createToken?: () => Promise<ZellijWebToken>;
  persist: (token: ZellijWebToken | null) => Promise<void>;
  warn?: (message: string) => void;
}

function sanitizedZellijEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    if (name === 'ZELLIJ' || name.startsWith('ZELLIJ_')) delete sanitized[name];
  }
  return sanitized;
}

async function runZellijWeb(executablePath: string, arguments_: string[]): Promise<string> {
  const { stdout } = await execFileAsync(executablePath, ['web', ...arguments_], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    shell: false,
    env: sanitizedZellijEnvironment(process.env),
  });
  return stdout;
}

export class ZellijTokenService {
  private currentToken: ZellijWebToken | null;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly executablePath: string,
    private readonly tokenDatabaseFile: string,
    initialToken: ZellijWebToken | null,
    private readonly dependencies: ZellijTokenServiceDependencies,
  ) {
    this.currentToken = initialToken;
  }

  get(): ZellijWebToken | null {
    return this.currentToken;
  }

  async initialize(): Promise<{ token: ZellijWebToken; created: boolean }> {
    return this.exclusive(async () => {
      if (this.currentToken && await this.tokenNameExists(this.currentToken.name)) {
        return { token: this.currentToken, created: false };
      }
      return { token: await this.createAndPersist(), created: true };
    });
  }

  async regenerate(): Promise<ZellijWebToken> {
    return this.exclusive(async () => {
      const previous = this.currentToken;
      const replacement = await this.createAndPersist();
      if (previous) {
        try {
          await this.run(['--revoke-token', previous.name]);
        } catch {
          this.dependencies.warn?.('new Zellij Web token was saved but the previous token could not be revoked');
        }
      }
      return replacement;
    });
  }

  async delete(): Promise<boolean> {
    return this.exclusive(async () => {
      const token = this.currentToken;
      if (!token) return false;
      await this.run(['--revoke-token', token.name]);
      await this.dependencies.persist(null);
      this.currentToken = null;
      return true;
    });
  }

  private async tokenNameExists(name: string): Promise<boolean> {
    const output = await this.run(['--list-tokens']);
    return output.split(/\r?\n/u).some(line => line.startsWith(`${name}:`));
  }

  private async createAndPersist(): Promise<ZellijWebToken> {
    let token: ZellijWebToken;
    if (this.dependencies.createToken) token = await this.dependencies.createToken();
    else {
      await this.run(['--list-tokens']);
      token = await createTokenInDatabase(this.tokenDatabaseFile);
    }
    try {
      await this.dependencies.persist(token);
    } catch (error) {
      try {
        await this.run(['--revoke-token', token.name]);
      } catch {
        this.dependencies.warn?.('failed to revoke a Zellij Web token after configuration persistence failed');
      }
      throw error;
    }
    this.currentToken = token;
    return token;
  }

  private async run(arguments_: string[]): Promise<string> {
    try {
      return await (this.dependencies.run
        ? this.dependencies.run(arguments_)
        : runZellijWeb(this.executablePath, arguments_));
    } catch {
      // execFile errors can carry stdout/stderr. Never let a command error that
      // may contain a newly-created token reach request or process logging.
      throw new Error('Zellij Web token command failed');
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release: () => void = () => undefined;
    this.operation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export async function createTokenInDatabase(tokenDatabaseFile: string): Promise<ZellijWebToken> {
  const name = `terminal-web-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const value = randomUUID();
  const tokenHash = createHash('sha256').update(value).digest('hex');
  const database = new DatabaseSync(tokenDatabaseFile);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    database.prepare(
      'INSERT INTO tokens (token_hash, name, read_only) VALUES (?, ?, 0)',
    ).run(tokenHash, name);
  } finally {
    database.close();
  }
  await chmod(tokenDatabaseFile, 0o600);
  return { name, value };
}
