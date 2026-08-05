import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZellijWebToken } from '../src/config.js';
import { createTokenInDatabase, ZellijTokenService } from '../src/services/zellij-token-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function fixture(initialToken: ZellijWebToken | null = null) {
  const names = new Set<string>();
  if (initialToken) names.add(initialToken.name);
  let tokenCounter = 1;
  const persist = vi.fn(async () => undefined);
  const createToken = vi.fn(async () => {
    const token = {
      name: `codepilot-web-${tokenCounter}`,
      value: `123e4567-e89b-42d3-a456-42661417400${tokenCounter++}`,
    };
    names.add(token.name);
    return token;
  });
  const run = vi.fn(async (arguments_: string[]) => {
    if (arguments_[0] === '--list-tokens') {
      return [...names].map(name => `${name}: created at 2026-08-02 00:00:00`).join('\n');
    }
    if (arguments_[0] === '--revoke-token') {
      if (arguments_[1]) names.delete(arguments_[1]);
      return 'Token revoked\n';
    }
    throw new Error('unexpected command');
  });
  return {
    names,
    persist,
    createToken,
    run,
    service: new ZellijTokenService('/managed/zellij', '/managed/tokens.db', initialToken, { run, createToken, persist }),
  };
}

describe('ZellijTokenService', () => {
  it('creates and persists both the token name and value on first startup', async () => {
    const { service, persist, createToken } = fixture();
    const result = await service.initialize();
    expect(result.created).toBe(true);
    expect(result.token.name).toBe('codepilot-web-1');
    expect(result.token.value).toBe('123e4567-e89b-42d3-a456-426614174001');
    expect(persist).toHaveBeenCalledWith(result.token);
    expect(createToken).toHaveBeenCalledTimes(1);
  });

  it('reuses a configured token when its name still exists in Zellij', async () => {
    const existing = { name: 'codepilot-web-existing', value: '123e4567-e89b-42d3-a456-426614174000' };
    const { service, persist, run } = fixture(existing);
    await expect(service.initialize()).resolves.toEqual({ token: existing, created: false });
    expect(persist).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(['--create-token']));
  });

  it('replaces a configured token when its saved name no longer exists in Zellij', async () => {
    const existing = { name: 'codepilot-web-missing', value: '123e4567-e89b-42d3-a456-426614174000' };
    const { service, names, persist } = fixture(existing);
    names.delete(existing.name);
    const result = await service.initialize();
    expect(result.created).toBe(true);
    expect(result.token.name).not.toBe(existing.name);
    expect(persist).toHaveBeenCalledWith(result.token);
  });

  it('saves a replacement before revoking the previous token', async () => {
    const existing = { name: 'codepilot-web-existing', value: '123e4567-e89b-42d3-a456-426614174000' };
    const { service, persist, run } = fixture(existing);
    const replacement = await service.regenerate();
    expect(persist).toHaveBeenCalledWith(replacement);
    expect(run).toHaveBeenCalledWith(['--revoke-token', existing.name]);
    const revokeCall = run.mock.calls.findIndex(call => call[0][0] === '--revoke-token');
    const persistOrder = persist.mock.invocationCallOrder[0];
    const revokeOrder = run.mock.invocationCallOrder[revokeCall];
    expect(persistOrder).toBeDefined();
    expect(revokeOrder).toBeDefined();
    expect(persistOrder!).toBeLessThan(revokeOrder!);
    expect(service.get()).toEqual(replacement);
  });

  it('revokes by the saved token name and removes it from configuration', async () => {
    const existing = { name: 'codepilot-web-existing', value: '123e4567-e89b-42d3-a456-426614174000' };
    const { service, persist, run } = fixture(existing);
    await expect(service.delete()).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(['--revoke-token', existing.name]);
    expect(persist).toHaveBeenCalledWith(null);
    expect(service.get()).toBeNull();
  });

  it('does not expose command output when a Zellij token command fails', async () => {
    const secret = '123e4567-e89b-42d3-a456-426614174099';
    const service = new ZellijTokenService('/managed/zellij', '/managed/tokens.db', null, {
      persist: async () => undefined,
      run: async () => { throw new Error(`command failed with stdout: ${secret}`); },
    });
    await expect(service.initialize()).rejects.toThrow('Zellij Web token command failed');
    await expect(service.initialize()).rejects.not.toThrow(secret);
  });

  it('stores only a hash in the Zellij token database and protects the file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-token-db-'));
    temporaryDirectories.push(root);
    const databaseFile = path.join(root, 'tokens.db');
    const database = new DatabaseSync(databaseFile);
    database.exec('CREATE TABLE tokens (id INTEGER PRIMARY KEY, token_hash TEXT UNIQUE, name TEXT UNIQUE, read_only BOOLEAN)');
    database.close();

    const token = await createTokenInDatabase(databaseFile);
    const verification = new DatabaseSync(databaseFile, { readOnly: true });
    const row = verification.prepare('SELECT token_hash, name, read_only FROM tokens').get() as {
      token_hash: string;
      name: string;
      read_only: number;
    };
    verification.close();
    expect(row.name).toBe(token.name);
    expect(row.token_hash).toBe(createHash('sha256').update(token.value).digest('hex'));
    expect(row.token_hash).not.toBe(token.value);
    expect(row.read_only).toBe(0);
    expect((await stat(databaseFile)).mode & 0o777).toBe(0o600);
  });
});
