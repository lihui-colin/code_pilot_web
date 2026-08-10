import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBackgroundProcessRegistry } from '../src/services/background-process-registry.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('background process registry', () => {
  it('atomically tracks a managed process identity and removes it on release', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'codepilot-background-process-'));
    temporaryDirectories.push(directory);
    const registryFile = path.join(directory, 'background-processes.json');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (!child.pid) throw new Error('test child did not provide a PID');

    try {
      const registration = await new FileBackgroundProcessRegistry(registryFile).register('codex', child.pid);
      const entries = JSON.parse(await readFile(registryFile, 'utf8')) as Array<Record<string, unknown>>;

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'codex', pid: child.pid, processGroup: child.pid });
      expect(entries[0]?.arguments).toEqual([
        process.execPath,
        '-e',
        'setInterval(() => undefined, 1000)',
      ]);
      expect((await stat(registryFile)).mode & 0o777).toBe(0o600);

      await registration.release();
      await expect(readFile(registryFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The process may already have exited.
      }
    }
  });
});
