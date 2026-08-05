import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfiguration, persistZellijWebToken } from '../src/config.js';

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-config-'));
  temporaryDirectories.push(root);
  const workspace = path.join(root, 'workspace');
  const workspaceLink = path.join(root, 'workspace-link');
  await mkdir(workspace);
  await symlink(workspace, workspaceLink);
  await writeFile(path.join(root, 'directory.secret'), 'a'.repeat(32), { mode: 0o600 });
  await writeFile(path.join(root, 'config.json'), JSON.stringify({
    listenHost: '0.0.0.0',
    listenPort: 8024,
    publicBaseUrl: 'https://192.0.2.10:8024',
    zellij: {
      webPort: 8021,
      managedBinaryFile: 'bin/zellij',
      configFile: 'zellij/config.kdl',
      webTokenDatabaseFile: 'zellij/tokens.db',
      webCertificateFile: 'certs/cert.pem',
      webPrivateKeyFile: 'certs/key.pem',
    },
    openVSCode: {
      executableFile: 'openvscode/current/bin/openvscode-server',
      port: 8023,
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
    await expect(loadConfiguration(['--config', 'config.json'], root)).rejects.toThrow('--workspace is required');
  });

  it('accepts concise host, port, and workspace options', async () => {
    const { root, workspace } = await fixture();
    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--host', '192.0.2.20',
      '--port', '9443',
      '--workspace', workspace,
    ], root);

    expect(loaded.config.listenHost).toBe('0.0.0.0');
    expect(loaded.config.listenPort).toBe(9443);
    expect(loaded.config.publicBaseUrl).toBe('https://192.0.2.20:9443');
    expect(loaded.config.workspaceRootRealPath).toBe(workspace);
  });

  it('defaults the listen address to 0.0.0.0', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.listenHost = '127.0.0.1';
    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--workspace', workspace,
    ], root);

    expect(loaded.config.listenHost).toBe('0.0.0.0');
    expect(loaded.config.publicBaseUrl).toBe('https://192.0.2.10:8024');
  });

  it('rejects a wildcard browser host', async () => {
    const { root, workspace } = await fixture();
    await expect(loadConfiguration([
      '--config', 'config.json',
      '--host', '0.0.0.0',
      '--port', '9443',
      '--workspace', workspace,
    ], root)).rejects.toThrow('--host must be the IP address or hostname used by browsers');
  });

  it('rejects an invalid command-line port', async () => {
    const { root, workspace } = await fixture();
    await expect(loadConfiguration([
      '--config', 'config.json',
      '--port', '70000',
      '--workspace', workspace,
    ], root)).rejects.toThrow('--port must be an integer between 1 and 65535');
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
    expect(loaded.config.openVSCodeExecutableFile).toBe(path.join(root, 'openvscode/current/bin/openvscode-server'));
    expect(loaded.config.openVSCodePort).toBe(8023);
    expect(loaded.directoryIdSecret?.length).toBe(32);
  });

  it('defaults the listen port to 8020', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.listenPort;
    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root);

    expect(loaded.config.listenPort).toBe(8020);
  });

  it('defaults the OpenVSCode port to 8023', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.openVSCode.port;
    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root);

    expect(loaded.config.openVSCodePort).toBe(8023);
  });

  it('loads configured Codex chat typography', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.codexChatAppearance = { fontFamily: '"Noto Sans SC", sans-serif', fontSize: 18 };
    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root);

    expect(loaded.config.codexChatAppearance).toEqual({
      fontFamily: '"Noto Sans SC", sans-serif',
      fontSize: 18,
    });
  });

  it('rejects a Codex chat font size outside the supported range', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.codexChatAppearance = { fontFamily: 'sans-serif', fontSize: 25 };
    await writeFile(configPath, JSON.stringify(config));

    await expect(loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root)).rejects.toThrow();
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
    config.publicBaseUrl = 'https://0.0.0.0:8024';
    await writeFile(configPath, JSON.stringify(config));
    await expect(loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root)).rejects.toThrow('IP address or hostname that browsers access');
  });

  it('requires HTTPS for the public browser URL', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.publicBaseUrl = 'http://192.0.2.10:8024';
    await writeFile(configPath, JSON.stringify(config));
    await expect(loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root)).rejects.toThrow('publicBaseUrl must use HTTPS');

  });

  it('rejects an OpenVSCode port that overlaps another configured service', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.openVSCode.port = 18_000;
    await writeFile(configPath, JSON.stringify(config));
    await expect(loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root)).rejects.toThrow('OpenVSCode port must be different');
  });

  it('atomically persists the Zellij Web token name and value with secure permissions', async () => {
    const { root, workspace } = await fixture();
    const configPath = path.join(root, 'config.json');
    const token = { name: 'codepilot-web-test', value: '123e4567-e89b-42d3-a456-426614174000' };
    await persistZellijWebToken(configPath, token);
    const loaded = await loadConfiguration([
      '--config', 'config.json',
      '--workspace-root', workspace,
    ], root);
    expect(loaded.config.zellijWebToken).toEqual(token);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });
});
