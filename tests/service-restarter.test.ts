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
  it('spawns only the fixed restart script with the configured workspace and config file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-restarter-'));
    temporaryDirectories.push(root);
    const logFile = path.join(root, 'restart.log');
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const restarter = new SpawnServiceRestarter(
      '/project/scripts/restart-service.sh',
      '/workspace/root',
      '/project/config.json',
      logFile,
      spawnProcess,
    );

    await restarter.restart();

    expect(spawnProcess).toHaveBeenCalledWith(
      '/project/scripts/restart-service.sh',
      ['/workspace/root', '/project/config.json'],
      expect.objectContaining({
        cwd: '/workspace/root',
        detached: true,
        shell: false,
        env: expect.objectContaining({ TERMINAL_WEB_RESTART_DELAY_MS: '750' }),
      }),
    );
    expect(child.unref).toHaveBeenCalled();
    await expect(readFile(logFile, 'utf8')).resolves.toBe('');
  });
});
