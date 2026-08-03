import pino from 'pino';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  repositorySessionName,
  ZellijService,
  parseSessionNames,
  type ZellijAdapter,
} from '../src/services/zellij-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('parseSessionNames', () => {
  it('filters invalid lines, removes duplicates, and byte-sorts names', () => {
    const warnings: string[] = [];
    expect(parseSessionNames('zeta\ninvalid name\nalpha\nalpha\n', line => warnings.push(line))).toEqual(['alpha', 'zeta']);
    expect(warnings).toEqual(['invalid name']);
  });
});

describe('ZellijService', () => {
  it('derives a stable Session name from the opaque repository ID', () => {
    expect(repositorySessionName('flash-attention', `dir_${'a'.repeat(43)}`)).toBe('flash-attention');
    expect(repositorySessionName('project', `dir_${'a'.repeat(35)}12345678`, true)).toBe('project-12345678');
  });

  it('merges managed metadata and creates server-owned web URLs', async () => {
    const adapter: ZellijAdapter = { listSessions: async () => 'external\nmanaged\n' };
    const service = new ZellijService(adapter, 'https://192.0.2.10:8021', pino({ enabled: false }), new Map([
      ['managed', {
        repositoryId: 'dir_test',
        relativePath: 'project',
        createdAt: '2026-08-02T00:00:00.000Z',
        command: 'codex',
      }],
    ]));
    const sessions = await service.listSessions();
    expect(sessions.map(session => session.name)).toEqual(['external', 'managed']);
    expect(sessions[0]).toMatchObject({ origin: 'external', repositoryId: null, relativePath: null });
    expect(sessions[1]).toMatchObject({ origin: 'managed', repositoryId: 'dir_test', relativePath: 'project' });
    expect(sessions[1]?.webUrl).toBe('https://192.0.2.10:8021/managed');
  });

  it('creates a Codex Session in the selected repository with a temporary protected layout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-zellij-session-'));
    temporaryDirectories.push(root);
    let sessions = '';
    const createSession = vi.fn(async (arguments_: string[]) => {
      sessions = 'repo-session\n';
      expect(arguments_).toEqual([
        '--layout', expect.stringContaining('codex.kdl'),
        'attach', '--create-background', 'repo-session',
        'options', '--default-cwd', '/workspace/repository',
      ]);
    });
    const adapter: ZellijAdapter = { listSessions: async () => sessions, createSession };
    const service = new ZellijService(
      adapter,
      'https://192.0.2.10:8021',
      pino({ enabled: false }),
      new Map(),
      path.join(root, 'layouts'),
    );

    const session = await service.createSession(
      'repo-session', `dir_${'a'.repeat(43)}`, 'repository', '/workspace/repository',
    );
    expect(session).toMatchObject({ name: 'repo-session', origin: 'managed', relativePath: 'repository', command: 'codex' });
    expect(await readdir(path.join(root, 'layouts'))).toEqual([]);
  });

  it('reuses an existing repository Session without creating another one', async () => {
    const name = repositorySessionName('repository', `dir_${'a'.repeat(43)}`);
    const createSession = vi.fn(async () => undefined);
    const service = new ZellijService(
      { listSessions: async () => `${name}\n`, createSession },
      'https://192.0.2.10:8021',
      pino({ enabled: false }),
    );
    const result = await service.ensureRepositorySession(
      name, `dir_${'a'.repeat(43)}`, 'repository', '/workspace/repository',
    );
    expect(result.created).toBe(false);
    expect(result.session.name).toBe(name);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('coalesces concurrent repository Session creation', async () => {
    const name = repositorySessionName('repository', `dir_${'a'.repeat(43)}`);
    let sessions = '';
    const createSession = vi.fn(async () => {
      await Promise.resolve();
      sessions = `${name}\n`;
    });
    const service = new ZellijService(
      { listSessions: async () => sessions, createSession },
      'https://192.0.2.10:8021',
      pino({ enabled: false }),
    );
    const [first, second] = await Promise.all([
      service.ensureRepositorySession(name, `dir_${'a'.repeat(43)}`, 'repository', '/workspace/repository'),
      service.ensureRepositorySession(name, `dir_${'a'.repeat(43)}`, 'repository', '/workspace/repository'),
    ]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.session.name).toBe(name);
    expect(second.session.name).toBe(name);
  });

  it('deletes only the requested Session and verifies it disappeared', async () => {
    let sessions = 'keep\nremove\n';
    const deleteSession = vi.fn(async (arguments_: string[]) => {
      expect(arguments_).toEqual(['delete-session', '--force', 'remove']);
      sessions = 'keep\n';
    });
    const service = new ZellijService(
      { listSessions: async () => sessions, deleteSession },
      'https://192.0.2.10:8021',
      pino({ enabled: false }),
    );
    await service.deleteSession('remove');
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect((await service.listSessions()).map(session => session.name)).toEqual(['keep']);
  });
});
