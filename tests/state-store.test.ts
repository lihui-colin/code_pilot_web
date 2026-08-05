import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/services/state-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('StateStore', () => {
  it('removes managed Session records that no longer exist during startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-state-'));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, 'data');
    const stateFile = path.join(dataDirectory, 'state.json');
    await mkdir(dataDirectory, { mode: 0o700 });
    await writeFile(stateFile, `${JSON.stringify({
      version: 1,
      sessions: [
        {
          name: 'existing', repositoryId: 'dir_existing', relativePath: 'existing',
          createdAt: '2026-08-03T00:00:00.000Z', command: 'codex',
        },
        {
          name: 'deleted', repositoryId: 'dir_deleted', relativePath: 'deleted',
          createdAt: '2026-08-03T00:00:00.000Z', command: 'codex',
        },
      ],
      viewers: [],
    }, null, 2)}\n`, { mode: 0o600 });

    const sessions = await new StateStore(stateFile).initialize(['existing']);

    expect([...sessions.keys()]).toEqual(['existing']);
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({
      version: 3,
      sessions: [{
        name: 'existing', repositoryId: 'dir_existing', relativePath: 'existing',
        createdAt: '2026-08-03T00:00:00.000Z', command: 'codex',
      }],
      viewers: [],
      repositories: [],
      codexConversations: [],
    });
  });

  it('persists manual repositories without losing managed Sessions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-state-'));
    temporaryDirectories.push(root);
    const stateFile = path.join(root, 'data/state.json');
    const store = new StateStore(stateFile);
    await store.initialize(null);
    await store.persistRepositoryPaths(['/srv/repository-b', '/srv/repository-a']);
    await store.persist(new Map([['session-a', {
      repositoryId: 'dir_test',
      relativePath: 'repository-a',
      createdAt: '2026-08-04T00:00:00.000Z',
      command: 'codex',
    }]]));
    const repositoryId = `dir_${'a'.repeat(43)}`;
    const conversationId = '123e4567-e89b-42d3-a456-426614174000';
    await store.persistCodexConversations(new Map([[repositoryId, conversationId]]));

    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({
      version: 3,
      sessions: [{
        name: 'session-a', repositoryId: 'dir_test', relativePath: 'repository-a',
        createdAt: '2026-08-04T00:00:00.000Z', command: 'codex',
      }],
      viewers: [],
      repositories: ['/srv/repository-a', '/srv/repository-b'],
      codexConversations: [{ repositoryId, conversationId }],
    });

    const reloaded = new StateStore(stateFile);
    await reloaded.initialize(null);
    expect(reloaded.repositoryPaths()).toEqual(['/srv/repository-a', '/srv/repository-b']);
    expect(reloaded.codexConversations()).toEqual(new Map([[repositoryId, conversationId]]));
  });
});
