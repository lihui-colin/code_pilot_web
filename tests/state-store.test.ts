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
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-state-'));
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
      version: 1,
      sessions: [{
        name: 'existing', repositoryId: 'dir_existing', relativePath: 'existing',
        createdAt: '2026-08-03T00:00:00.000Z', command: 'codex',
      }],
      viewers: [],
    });
  });
});
