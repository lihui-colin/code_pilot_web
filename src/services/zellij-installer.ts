import { execFile } from 'node:child_process';
import { lstat, chmod, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { withoutZellijEnvironment } from './zellij-environment.js';

const execFileAsync = promisify(execFile);

export const ZELLIJ_VERSION = '0.44.3';
export const ZELLIJ_VERSION_OUTPUT = `zellij ${ZELLIJ_VERSION}`;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

const releaseAssets: Record<string, string> = {
  'linux-x64': 'zellij-x86_64-unknown-linux-musl.tar.gz',
  'linux-arm64': 'zellij-aarch64-unknown-linux-musl.tar.gz',
  'darwin-x64': 'zellij-x86_64-apple-darwin.tar.gz',
  'darwin-arm64': 'zellij-aarch64-apple-darwin.tar.gz',
};

export interface ZellijResolution {
  executablePath: string;
  version: string | null;
  source: 'managed' | 'system';
  downloaded: boolean;
}

export interface ZellijInstallerDependencies {
  readVersion?: (executablePath: string) => Promise<string | null>;
  installDownloadedBinary?: (downloadUrl: string, destination: string) => Promise<void>;
  platform?: NodeJS.Platform;
  architecture?: string;
}

export async function readZellijVersion(executablePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executablePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      shell: false,
      env: withoutZellijEnvironment(process.env),
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function downloadUrl(platform: NodeJS.Platform, architecture: string): string {
  const asset = releaseAssets[`${platform}-${architecture}`];
  if (!asset) throw new Error(`Zellij ${ZELLIJ_VERSION} is not available for this platform`);
  return `https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/${asset}`;
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error(`Zellij download failed with HTTP ${response.status}`);

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Zellij download exceeds the allowed size');
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
      if (received > MAX_ARCHIVE_BYTES) throw new Error('Zellij download exceeds the allowed size');
      await file.write(value, 0, value.byteLength, null);
      if (Number.isFinite(contentLength) && contentLength > 0) {
        const percent = Math.floor(received / contentLength * 100);
        if (percent !== reportedPercent) {
          process.stderr.write(`\rDownloading Zellij ${percent}%`);
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

async function installDownloadedBinary(downloadUrlValue: string, destination: string): Promise<void> {
  const extractionDirectory = path.dirname(destination);
  const archivePath = path.join(extractionDirectory, 'zellij.tar.gz');
  await downloadFile(downloadUrlValue, archivePath);
  await execFileAsync('tar', [
    '-xzf', archivePath,
    '-C', extractionDirectory,
    '--no-same-owner',
    '--no-same-permissions',
    'zellij',
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    shell: false,
  });
}

export async function ensureZellij(
  managedBinaryFile: string,
  dependencies: ZellijInstallerDependencies = {},
): Promise<ZellijResolution> {
  const readVersion = dependencies.readVersion ?? readZellijVersion;
  const managedVersion = await readVersion(managedBinaryFile);
  if (managedVersion === ZELLIJ_VERSION_OUTPUT) {
    return { executablePath: managedBinaryFile, version: managedVersion, source: 'managed', downloaded: false };
  }

  const systemVersion = await readVersion('zellij');
  if (systemVersion === ZELLIJ_VERSION_OUTPUT) {
    return { executablePath: 'zellij', version: systemVersion, source: 'system', downloaded: false };
  }

  // A present but mismatched executable remains visible to readiness instead of
  // being silently replaced with a different version.
  if (managedVersion !== null) {
    return { executablePath: managedBinaryFile, version: managedVersion, source: 'managed', downloaded: false };
  }
  if (systemVersion !== null) {
    return { executablePath: 'zellij', version: systemVersion, source: 'system', downloaded: false };
  }

  const parentDirectory = path.dirname(managedBinaryFile);
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(path.join(parentDirectory, '.zellij-install-'));
  const temporaryBinary = path.join(temporaryDirectory, 'zellij');
  try {
    const installer = dependencies.installDownloadedBinary ?? installDownloadedBinary;
    await installer(
      downloadUrl(dependencies.platform ?? process.platform, dependencies.architecture ?? process.arch),
      temporaryBinary,
    );
    const binaryStat = await lstat(temporaryBinary);
    if (!binaryStat.isFile()) throw new Error('Downloaded Zellij executable is not a regular file');
    await chmod(temporaryBinary, 0o755);
    const installedVersion = await readVersion(temporaryBinary);
    if (installedVersion !== ZELLIJ_VERSION_OUTPUT) {
      throw new Error(`Downloaded Zellij executable is not version ${ZELLIJ_VERSION}`);
    }
    await rename(temporaryBinary, managedBinaryFile);
    return {
      executablePath: managedBinaryFile,
      version: installedVersion,
      source: 'managed',
      downloaded: true,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function installForProject(): Promise<void> {
  const managedBinaryFile = path.resolve(process.cwd(), 'data/bin/zellij');
  const resolution = await ensureZellij(managedBinaryFile);
  if (resolution.downloaded) {
    process.stdout.write(`Installed Zellij ${ZELLIJ_VERSION} at ${managedBinaryFile}\n`);
    return;
  }
  if (resolution.version === ZELLIJ_VERSION_OUTPUT) {
    process.stdout.write(`Using Zellij ${ZELLIJ_VERSION} from ${resolution.source}\n`);
    return;
  }
  process.stderr.write(`Zellij was found but version ${ZELLIJ_VERSION} is required\n`);
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedFile === import.meta.url && process.argv.includes('--install-only')) {
  installForProject().catch(error => {
    process.stderr.write(`Unable to install Zellij: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
