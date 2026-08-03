import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureZellijWebCertificate, ensureZellijWebSharing } from '../src/services/zellij-bootstrap.js';
import {
  ensureZellij,
  ZELLIJ_VERSION_OUTPUT,
} from '../src/services/zellij-installer.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ensureZellij', () => {
  it('reuses a matching system Zellij without downloading it', async () => {
    const root = await temporaryDirectory('terminal-web-zellij-');
    const installer = vi.fn();
    const result = await ensureZellij(path.join(root, 'bin/zellij'), {
      readVersion: async executablePath => executablePath === 'zellij' ? ZELLIJ_VERSION_OUTPUT : null,
      installDownloadedBinary: installer,
    });

    expect(result).toEqual({
      executablePath: 'zellij',
      version: ZELLIJ_VERSION_OUTPUT,
      source: 'system',
      downloaded: false,
    });
    expect(installer).not.toHaveBeenCalled();
  });

  it('downloads a fixed release into the managed project path when Zellij is absent', async () => {
    const root = await temporaryDirectory('terminal-web-zellij-');
    const managedBinary = path.join(root, 'data/bin/zellij');
    const installer = vi.fn(async (url: string, destination: string) => {
      expect(url).toBe('https://github.com/zellij-org/zellij/releases/download/v0.44.3/zellij-x86_64-unknown-linux-musl.tar.gz');
      await writeFile(destination, 'managed zellij');
    });
    const result = await ensureZellij(managedBinary, {
      platform: 'linux',
      architecture: 'x64',
      readVersion: async executablePath => executablePath.includes('.zellij-install-')
        ? ZELLIJ_VERSION_OUTPUT
        : null,
      installDownloadedBinary: installer,
    });

    expect(result).toMatchObject({ executablePath: managedBinary, source: 'managed', downloaded: true });
    expect(await readFile(managedBinary, 'utf8')).toBe('managed zellij');
    expect((await stat(managedBinary)).mode & 0o777).toBe(0o755);
  });

  it('does not silently replace a Zellij installation with a mismatched version', async () => {
    const root = await temporaryDirectory('terminal-web-zellij-');
    const managedBinary = path.join(root, 'data/bin/zellij');
    const installer = vi.fn();
    const result = await ensureZellij(managedBinary, {
      readVersion: async executablePath => executablePath === 'zellij' ? 'zellij 0.43.1' : null,
      installDownloadedBinary: installer,
    });

    expect(result).toMatchObject({ executablePath: 'zellij', version: 'zellij 0.43.1', downloaded: false });
    expect(installer).not.toHaveBeenCalled();
  });
});

describe('ensureZellijWebCertificate', () => {
  const matchingOpenSsl = async (arguments_: string[]) => {
    if (arguments_.includes('-pubkey') || arguments_.includes('-pubout')) return 'PUBLIC KEY\n';
    if (arguments_.includes('-checkhost')) return 'Certificate is valid for the requested host\n';
    return '';
  };

  it('reuses an existing valid certificate and private key', async () => {
    const root = await temporaryDirectory('terminal-web-cert-');
    const certificateFile = path.join(root, 'cert.pem');
    const privateKeyFile = path.join(root, 'key.pem');
    await writeFile(certificateFile, 'certificate', { mode: 0o644 });
    await writeFile(privateKeyFile, 'private key', { mode: 0o600 });

    await expect(ensureZellijWebCertificate(
      'https://10.30.0.24:8021',
      certificateFile,
      privateKeyFile,
      { runOpenSsl: matchingOpenSsl },
    )).resolves.toBe(false);
  });

  it('creates a certificate with the configured Zellij Web hostname when both files are absent', async () => {
    const root = await temporaryDirectory('terminal-web-cert-');
    const certificateFile = path.join(root, 'certs/cert.pem');
    const privateKeyFile = path.join(root, 'keys/key.pem');
    const generator = vi.fn(async (temporaryCertificate: string, temporaryKey: string) => {
      await Promise.all([
        writeFile(temporaryCertificate, 'certificate'),
        writeFile(temporaryKey, 'private key'),
      ]);
    });

    await expect(ensureZellijWebCertificate(
      'https://10.30.0.24:8021',
      certificateFile,
      privateKeyFile,
      { runOpenSsl: matchingOpenSsl, generateCertificate: generator },
    )).resolves.toBe(true);

    expect(generator).toHaveBeenCalledWith(expect.any(String), expect.any(String), '10.30.0.24');
    expect((await stat(privateKeyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(certificateFile)).mode & 0o777).toBe(0o644);
  });

  it('rejects an existing certificate that does not cover the configured hostname', async () => {
    const root = await temporaryDirectory('terminal-web-cert-');
    const certificateFile = path.join(root, 'cert.pem');
    const privateKeyFile = path.join(root, 'key.pem');
    await writeFile(certificateFile, 'certificate', { mode: 0o644 });
    await writeFile(privateKeyFile, 'private key', { mode: 0o600 });

    await expect(ensureZellijWebCertificate(
      'https://10.30.0.24:8021',
      certificateFile,
      privateKeyFile,
      {
        runOpenSsl: async arguments_ => {
          if (arguments_.includes('-checkhost')) throw new Error('hostname mismatch');
          return matchingOpenSsl(arguments_);
        },
      },
    )).rejects.toThrow('hostname mismatch');
  });

  it('fails without overwriting a partial certificate state', async () => {
    const root = await temporaryDirectory('terminal-web-cert-');
    const certificateFile = path.join(root, 'cert.pem');
    const privateKeyFile = path.join(root, 'key.pem');
    await mkdir(path.dirname(certificateFile), { recursive: true });
    await writeFile(certificateFile, 'certificate');

    await expect(ensureZellijWebCertificate(
      'https://10.30.0.24:8021',
      certificateFile,
      privateKeyFile,
      { runOpenSsl: matchingOpenSsl },
    )).rejects.toThrow('must either both exist or both be absent');
  });
});

describe('ensureZellijWebSharing', () => {
  it('adds web sharing when the Zellij config only contains the commented default', async () => {
    const root = await temporaryDirectory('terminal-web-zellij-config-');
    const configFile = path.join(root, 'config.kdl');
    await writeFile(configFile, '// web_sharing "off"\nweb_server true\n', { mode: 0o640 });
    await expect(ensureZellijWebSharing(configFile)).resolves.toBe(true);
    expect(await readFile(configFile, 'utf8')).toContain('\nweb_sharing "on"\n');
    expect((await stat(configFile)).mode & 0o777).toBe(0o640);
  });

  it('replaces an active disabled value and then reuses the enabled config', async () => {
    const root = await temporaryDirectory('terminal-web-zellij-config-');
    const configFile = path.join(root, 'config.kdl');
    await writeFile(configFile, 'web_sharing "off"\n');
    await expect(ensureZellijWebSharing(configFile)).resolves.toBe(true);
    await expect(ensureZellijWebSharing(configFile)).resolves.toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe('web_sharing "on"\n');
  });
});
