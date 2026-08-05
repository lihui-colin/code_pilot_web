import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpawnServiceRestarter } from '../src/services/service-restarter.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('SpawnServiceRestarter', () => {
  it('spawns only the fixed Node CLI restart command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-restarter-'));
    temporaryDirectories.push(root);
    const logFile = path.join(root, 'restart.log');
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const restarter = new SpawnServiceRestarter(
      '/project/dist/cli.js',
      '/project',
      logFile,
      spawnProcess,
    );

    await restarter.restart();

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['/project/dist/cli.js', 'restart'],
      expect.objectContaining({
        cwd: '/project',
        detached: true,
        shell: false,
        env: expect.objectContaining({ CODEPILOT_WEB_RESTART_DELAY_MS: '750' }),
      }),
    );
    expect(child.unref).toHaveBeenCalled();
    await expect(readFile(logFile, 'utf8')).resolves.toBe('');
  });
});
