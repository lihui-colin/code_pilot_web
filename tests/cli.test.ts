import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

beforeAll(async () => {
  await execFileAsync('npm', ['run', 'build'], { encoding: 'utf8' });
});

describe('codepilot-web CLI', () => {
  it('prints Node CLI lifecycle commands', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
    expect(stdout).toContain('codepilot-server init');
    expect(stdout).toContain('codepilot-server start');
    expect(stdout).toContain('codepilot-server stop');
    expect(stdout).toContain('codepilot-server restart');
    expect(stdout).toContain('codepilot-server status');
    expect(stdout).toContain('codepilot-server run');
  });

  it('requires a host for non-interactive initialization', async () => {
    await expect(execFileAsync(process.execPath, [
      'dist/cli.js',
      'init',
      '--service-port', '8020',
      '--non-interactive',
    ], { encoding: 'utf8' })).rejects.toMatchObject({
      stderr: expect.stringContaining('--host is required'),
    });
  });

  it('reports a missing workspace for start', async () => {
    await expect(execFileAsync(process.execPath, [
      'dist/cli.js',
      'start',
      '--config', 'config.json',
    ], { encoding: 'utf8' })).rejects.toMatchObject({
      stdout: expect.stringContaining('Starting CodePilot Web: 20% validating configuration'),
      stderr: expect.stringContaining('--workspace is required'),
    });
  });

  it('rejects unknown lifecycle commands', async () => {
    await expect(execFileAsync(process.execPath, ['dist/cli.js', 'launch'], { encoding: 'utf8' })).rejects.toMatchObject({
      stderr: expect.stringContaining('unknown command: launch'),
    });
  });
});
