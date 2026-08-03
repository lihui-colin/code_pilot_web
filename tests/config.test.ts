import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfiguration, persistZellijWebToken } from '../src/config.js';

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-config-'));
  temporaryDirectories.push(root);
  const workspace = path.join(root, 'workspace');
  const workspaceLink = path.join(root, 'workspace-link');
  await mkdir(workspace);
  await symlink(workspace, workspaceLink);
  await writeFile(path.join(root, 'directory.secret'), 'a'.repeat(32), { mode: 0o600 });
  await writeFile(path.join(root, 'config.json'), JSON.stringify({
    listenHost: '0.0.0.0',
    listenPort: 8024,
    publicBaseUrl: 'http://192.0.2.10:8024',
    zellijWebBaseUrl: 'https://192.0.2.10:8021',
    zellij: {
      managedBinaryFile: 'bin/zellij',
      configFile: 'zellij/config.kdl',
      webTokenDatabaseFile: 'zellij/tokens.db',
      webCertificateFile: 'certs/cert.pem',
      webPrivateKeyFile: 'certs/key.pem',
    },
    directoryIdSecretFile: 'directory.secret',
    viewerPortRange: { start: 18_000, end: 18_100 },
    viewerIdleTimeoutMinutes: 60,
    viewerMaxInstances: 10,
    projectMarkers: ['.git', 'package.json'],
    allowedSessionCommands: ['codex'],
  }));
  return { root, workspace, workspaceLink };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('loadConfiguration', () => {
  it('requires a workspace root', async () => {
    const { root } = await fixture();
    await expect(loadConfiguration(['--config', 'config.json'], root)).rejects.toThrow('--workspace-root is required');
  });

  it('accepts 0.0.0.0 and stores the workspace real path', async () => {
    const { root, workspace, workspaceLink } = await fixture();
    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspaceLink,
    ], root);
    expect(loaded.config.listenHost).toBe('0.0.0.0');
    expect(loaded.config.workspaceRootRealPath).toBe(workspace);
    expect(loaded.config.zellijManagedBinaryFile).toBe(path.join(root, 'bin/zellij'));
    expect(loaded.config.zellijConfigFile).toBe(path.join(root, 'zellij/config.kdl'));
    expect(loaded.config.zellijWebTokenDatabaseFile).toBe(path.join(root, 'zellij/tokens.db'));
    expect(loaded.config.zellijWebCertificateFile).toBe(path.join(root, 'certs/cert.pem'));
    expect(loaded.directoryIdSecret?.length).toBe(32);
  });

  it('defaults the listen port to 8024', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.listenPort;
    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root);

    expect(loaded.config.listenPort).toBe(8024);
  });

  it('keeps serving possible but marks an unsafe directory secret unavailable', async () => {
    const { root, workspace } = await fixture();
    await chmod(path.join(root, 'directory.secret'), 0o644);
    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root);
    expect(loaded.directoryIdSecret).toBeNull();
  });

  it('does not use the wildcard listen address as a browser URL', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.publicBaseUrl = 'http://0.0.0.0:8024';
    await writeFile(configPath, JSON.stringify(config));
    await expect(loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root)).rejects.toThrow('IP address or hostname that browsers access');
  });

  it('keeps the management URL on HTTP and requires HTTPS for Zellij Web', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.publicBaseUrl = 'https://192.0.2.10:8024';
    await writeFile(configPath, JSON.stringify(config));
    await expect(loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root)).rejects.toThrow('publicBaseUrl must use HTTP');

    config.publicBaseUrl = 'http://192.0.2.10:8024';
    config.zellijWebBaseUrl = 'http://192.0.2.10:8021';
    await writeFile(configPath, JSON.stringify(config));
    await expect(loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root)).rejects.toThrow('zellijWebBaseUrl must use HTTPS');
  });

  it('atomically persists the Zellij Web token name and value with secure permissions', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const token = { name: 'terminal-web-test', value: '123e4567-e89b-42d3-a456-426614174000' };
    await persistZellijWebToken(configPath, token);
    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root);
    expect(loaded.config.zellijWebToken).toEqual(token);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });
});
