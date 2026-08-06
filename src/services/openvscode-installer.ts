import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const OPENVSCODE_VERSION = '1.109.5';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60 * 60_000;

const releaseArchitectures: Record<string, { name: string; sha256: string }> = {
  x64: {
    name: 'x64',
    sha256: 'b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363',
  },
  arm64: {
    name: 'arm64',
    sha256: '36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc',
  },
  arm: {
    name: 'armhf',
    sha256: 'f84ac0dcea0bdeac07e172e58903b38bc5ef0ac94b0bf2ab2ce4eca325ab98bb',
  },
};

export interface OpenVSCodeInstallerDependencies {
  platform?: NodeJS.Platform;
  architecture?: string;
  downloadArchive?: (url: string, destination: string) => Promise<void>;
  verifyArchive?: (archive: string, expectedSha256: string) => Promise<boolean>;
  extractArchive?: (archive: string, destination: string, installationName: string) => Promise<void>;
  readVersion?: (executable: string) => Promise<string | null>;
}

export interface OpenVSCodeInstallation {
  executableFile: string;
  installationDirectory: string;
  downloaded: boolean;
}

async function fileStatus(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function downloadArchive(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`OpenVSCode download failed with HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
    throw new Error('OpenVSCode download exceeds the allowed size');
  }

  const file = await open(destination, 'wx', 0o600);
  let received = 0;
  let reportedPercent = -1;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) throw new Error('OpenVSCode download exceeds the allowed size');
      await file.write(value, 0, value.byteLength, null);
      if (Number.isFinite(contentLength) && contentLength > 0) {
        const percent = Math.floor(received / contentLength * 100);
        if (percent !== reportedPercent) {
          process.stderr.write(`\rDownloading OpenVSCode Server ${percent}%`);
          reportedPercent = percent;
        }
      }
    }
    await file.sync();
  } finally {
    await file.close();
    if (reportedPercent >= 0) process.stderr.write('\n');
  }
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function extractArchive(archive: string, destination: string, installationName: string): Promise<void> {
  await execFileAsync('tar', [
    '-xzf', archive,
    '-C', destination,
    '--no-same-owner',
    '--no-same-permissions',
    installationName,
  ], {
    encoding: 'utf8',
    timeout: 5 * 60_000,
    maxBuffer: 64 * 1024,
    shell: false,
  });
}

async function readVersion(executable: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      shell: false,
    });
    return stdout.split(/\r?\n/u)[0]?.trim() || null;
  } catch {
    return null;
  }
}

async function updateCurrentLink(downloadDirectory: string, installationName: string): Promise<void> {
  const currentLink = path.join(downloadDirectory, 'current');
  const currentStat = await fileStatus(currentLink);
  if (currentStat && !currentStat.isSymbolicLink()) {
    throw new Error(`${currentLink} exists and is not a symbolic link`);
  }
  if (currentStat && await readlink(currentLink) === installationName) return;
  const temporaryLink = path.join(downloadDirectory, `.current-${process.pid}-${Date.now()}`);
  await symlink(installationName, temporaryLink);
  try {
    await rename(temporaryLink, currentLink);
  } finally {
    await rm(temporaryLink, { force: true });
  }
}

export async function ensureOpenVSCode(
  downloadDirectory: string,
  dependencies: OpenVSCodeInstallerDependencies = {},
): Promise<OpenVSCodeInstallation> {
  if ((dependencies.platform ?? process.platform) !== 'linux') {
    throw new Error(`OpenVSCode Server ${OPENVSCODE_VERSION} is only available for Linux`);
  }
  const release = releaseArchitectures[dependencies.architecture ?? process.arch];
  if (!release) {
    throw new Error(`OpenVSCode Server ${OPENVSCODE_VERSION} is not available for this CPU architecture`);
  }

  const installationName = `openvscode-server-v${OPENVSCODE_VERSION}-linux-${release.name}`;
  const installationDirectory = path.join(downloadDirectory, installationName);
  const executableFile = path.join(installationDirectory, 'bin/openvscode-server');
  const versionReader = dependencies.readVersion ?? readVersion;
  const installationStat = await fileStatus(installationDirectory);
  if (installationStat) {
    if (!installationStat.isDirectory() || await versionReader(executableFile) !== OPENVSCODE_VERSION) {
      throw new Error(`${installationDirectory} is not a valid OpenVSCode Server ${OPENVSCODE_VERSION} installation`);
    }
    await updateCurrentLink(downloadDirectory, installationName);
    return { executableFile, installationDirectory, downloaded: false };
  }

  await mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(path.join(downloadDirectory, '.openvscode-download-'));
  const archiveName = `${installationName}.tar.gz`;
  const archiveFile = path.join(temporaryDirectory, archiveName);
  const url = `https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/${archiveName}`;
  try {
    await (dependencies.downloadArchive ?? downloadArchive)(url, archiveFile);
    const archiveMatches = dependencies.verifyArchive
      ? await dependencies.verifyArchive(archiveFile, release.sha256)
      : await sha256(archiveFile) === release.sha256;
    if (!archiveMatches) {
      throw new Error('downloaded OpenVSCode archive checksum did not match the official release digest');
    }
    await (dependencies.extractArchive ?? extractArchive)(archiveFile, temporaryDirectory, installationName);
    const extractedDirectory = path.join(temporaryDirectory, installationName);
    const extractedExecutable = path.join(extractedDirectory, 'bin/openvscode-server');
    if (await versionReader(extractedExecutable) !== OPENVSCODE_VERSION) {
      throw new Error(`downloaded OpenVSCode executable is not version ${OPENVSCODE_VERSION}`);
    }
    await chmod(extractedExecutable, 0o755);
    await rename(extractedDirectory, installationDirectory);
    await updateCurrentLink(downloadDirectory, installationName);
    return { executableFile, installationDirectory, downloaded: true };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
