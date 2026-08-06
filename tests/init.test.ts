import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeCodePilot, validateInitOptions } from '../src/init.js';
import { ZELLIJ_VERSION_OUTPUT } from '../src/services/zellij-installer.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-init-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('validateInitOptions', () => {
  const options = {
    host: '192.0.2.20',
    listenHost: '0.0.0.0',
    servicePort: 8020,
    zellijPort: 5021,
    viewerPort: 5022,
    openVSCodePort: 5023,
    configFile: '/tmp/config.json',
  };

  it('rejects browser wildcard hosts and overlapping ports', () => {
    expect(() => validateInitOptions({ ...options, host: '0.0.0.0' })).toThrow('host machine IP or hostname');
    expect(() => validateInitOptions({ ...options, viewerPort: 5021 })).toThrow('ports must be different');
  });
});

describe('initializeCodePilot', () => {
  it('creates config, secret, certificate paths, and Zellij settings without shell scripts', async () => {
    const root = await temporaryDirectory();
    const configFile = path.join(root, 'config.json');
    const homeDirectory = path.join(root, 'home');
    await mkdir(homeDirectory);
    const ensureCertificate = vi.fn(async () => true);
    const installOpenVSCode = vi.fn(async downloadDirectory => ({
      executableFile: path.join(downloadDirectory, 'openvscode-server-v1.109.5-linux-x64/bin/openvscode-server'),
      installationDirectory: path.join(downloadDirectory, 'openvscode-server-v1.109.5-linux-x64'),
      downloaded: true,
    }));
    const installZellij = vi.fn(async managedBinaryFile => ({
      executablePath: managedBinaryFile,
      version: ZELLIJ_VERSION_OUTPUT,
      source: 'managed' as const,
      downloaded: true,
    }));

    const result = await initializeCodePilot({
      host: '192.0.2.20',
      listenHost: '0.0.0.0',
      servicePort: 8020,
      zellijPort: 5021,
      viewerPort: 5022,
      openVSCodePort: 5023,
      configFile,
    }, {
      homeDirectory,
      ensureCertificate,
      installOpenVSCode,
      installZellij,
    });

    const config = JSON.parse(await readFile(configFile, 'utf8'));
    expect(config).toMatchObject({
      listenPort: 8020,
      publicBaseUrl: 'https://192.0.2.20:8020',
      zellij: { webPort: 5021, managedBinaryFile: 'data/bin/zellij' },
      openVSCode: { executableFile: 'data/openvscode/current/bin/openvscode-server', port: 5023 },
      directoryIdSecretFile: 'data/directory-id.secret',
      viewerPortRange: { start: 5022, end: 5022 },
    });
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(root, 'data/directory-id.secret'))).mode & 0o777).toBe(0o600);
    const zellijConfig = await readFile(path.join(homeDirectory, '.config/zellij/config.kdl'), 'utf8');
    expect(zellijConfig).toContain('web_server_port 5021');
    expect(zellijConfig).toContain(`web_server_cert "${path.join(root, 'data/zellij/certs/cert.pem')}"`);
    expect(ensureCertificate).toHaveBeenCalledWith(
      'https://192.0.2.20:8020',
      path.join(root, 'data/zellij/certs/cert.pem'),
      path.join(root, 'data/zellij/certs/key.pem'),
    );
    expect(result.configFile).toBe(configFile);
  });
});
