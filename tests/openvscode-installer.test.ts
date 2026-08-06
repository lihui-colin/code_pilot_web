import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureOpenVSCode, OPENVSCODE_VERSION } from '../src/services/openvscode-installer.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ensureOpenVSCode', () => {
  it('installs a verified archive and atomically points current at it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-openvscode-'));
    temporaryDirectories.push(root);
    const installation = await ensureOpenVSCode(root, {
      platform: 'linux',
      architecture: 'x64',
      downloadArchive: async (_url, destination) => writeFile(destination, 'archive'),
      verifyArchive: async (_archive, expectedSha256) => expectedSha256.length === 64,
      extractArchive: async (_archive, destination, installationName) => {
        const executable = path.join(destination, installationName, 'bin/openvscode-server');
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, 'openvscode');
      },
      readVersion: async () => OPENVSCODE_VERSION,
    });

    expect(installation.downloaded).toBe(true);
    expect(await readlink(path.join(root, 'current'))).toBe('openvscode-server-v1.109.5-linux-x64');
  });

  it('rejects an archive that fails checksum verification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-openvscode-'));
    temporaryDirectories.push(root);
    await expect(ensureOpenVSCode(root, {
      platform: 'linux',
      architecture: 'x64',
      downloadArchive: async (_url, destination) => writeFile(destination, 'archive'),
      verifyArchive: async () => false,
    })).rejects.toThrow('checksum did not match');
  });
});
