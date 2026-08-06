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

  it('prints only initialization options for init help', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['dist/cli.js', 'init', '--help'], { encoding: 'utf8' });
    expect(stdout).toContain('--port <port>');
    expect(stdout).toContain('--openvscode-port <port>');
    expect(stdout).not.toContain('--service-port <port>');
    expect(stdout).not.toContain('--workspace <directory>');
  });

  it.each(['start', 'run'] as const)('prints only service options for %s help', async command => {
    const { stdout } = await execFileAsync(process.execPath, ['dist/cli.js', command, '--help'], { encoding: 'utf8' });
    expect(stdout).toContain('--host <address>');
    expect(stdout).toContain('--port <port>');
    expect(stdout).toContain('--workspace <directory>');
    expect(stdout).toContain('--config <file>');
    expect(stdout).not.toContain('--zellij-port <port>');
    expect(stdout).not.toContain('--non-interactive');
  });

  it.each(['stop', 'restart', 'status'] as const)('prints no business options for %s help', async command => {
    const { stdout } = await execFileAsync(process.execPath, ['dist/cli.js', command, '--help'], { encoding: 'utf8' });
    expect(stdout).toContain(`codepilot-server ${command}`);
    expect(stdout).toContain('-h, --help');
    expect(stdout).not.toContain('--host <address>');
    expect(stdout).not.toContain('--port <port>');
    expect(stdout).not.toContain('--config <file>');
  });

  it('requires a host for non-interactive initialization', async () => {
    await expect(execFileAsync(process.execPath, [
      'dist/cli.js',
      'init',
      '--port', '8020',
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
