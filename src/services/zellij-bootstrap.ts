import { execFile } from 'node:child_process';
import { lstat, chmod, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';
import { ensureZellij, type ZellijInstallerDependencies, type ZellijResolution } from './zellij-installer.js';

const execFileAsync = promisify(execFile);

export interface ZellijCertificateDependencies {
  runOpenSsl?: (arguments_: string[]) => Promise<string>;
  generateCertificate?: (certificateFile: string, privateKeyFile: string, hostname: string) => Promise<void>;
}

export interface ZellijBootstrapDependencies {
  installer?: ZellijInstallerDependencies;
  certificate?: ZellijCertificateDependencies;
}

export interface ZellijBootstrapResult {
  zellij: ZellijResolution;
  certificateCreated: boolean;
  webSharingConfigured: boolean;
}

export async function ensureZellijWebSharing(configFile: string): Promise<boolean> {
  const configStat = await lstat(configFile);
  if (!configStat.isFile()) throw new Error('Zellij config must be a regular file');
  const original = await readFile(configFile, 'utf8');
  const lines = original.split(/\r?\n/u);
  const webSharingPattern = /^web_sharing\s+"(on|off|disabled)"\s*(?:\/\/.*)?$/u;
  const activeLine = lines.findIndex(line => webSharingPattern.test(line));
  if (activeLine >= 0 && webSharingPattern.exec(lines[activeLine]!)?.[1] === 'on') return false;

  if (activeLine >= 0) lines[activeLine] = 'web_sharing "on"';
  else {
    if (lines.at(-1) !== '') lines.push('');
    lines.push('web_sharing "on"', '');
  }

  const temporaryFile = `${configFile}.tmp-${process.pid}-${Date.now()}`;
  const file = await open(temporaryFile, 'wx', configStat.mode & 0o777);
  try {
    await file.writeFile(lines.join('\n'), 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryFile, configFile);
  await chmod(configFile, configStat.mode & 0o777);
  return true;
}

async function runOpenSsl(arguments_: string[]): Promise<string> {
  const { stdout } = await execFileAsync('openssl', arguments_, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    shell: false,
  });
  return stdout;
}

async function fileStatus(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function validateCertificatePair(
  certificateFile: string,
  privateKeyFile: string,
  runner: (arguments_: string[]) => Promise<string>,
): Promise<void> {
  const [certificateStat, privateKeyStat] = await Promise.all([
    lstat(certificateFile),
    lstat(privateKeyFile),
  ]);
  if (!certificateStat.isFile() || certificateStat.size === 0) {
    throw new Error('Zellij Web certificate must be a non-empty regular file');
  }
  if (!privateKeyStat.isFile() || privateKeyStat.size === 0) {
    throw new Error('Zellij Web private key must be a non-empty regular file');
  }
  if ((privateKeyStat.mode & 0o077) !== 0) {
    throw new Error('Zellij Web private key permissions must be 0600');
  }

  await runner(['x509', '-in', certificateFile, '-noout', '-checkend', '0']);
  const [certificatePublicKey, privatePublicKey] = await Promise.all([
    runner(['x509', '-in', certificateFile, '-pubkey', '-noout']),
    runner(['pkey', '-in', privateKeyFile, '-pubout']),
  ]);
  if (certificatePublicKey.trim() !== privatePublicKey.trim()) {
    throw new Error('Zellij Web certificate and private key do not match');
  }
}

function certificateSubjectAltName(hostname: string): string {
  const names = new Set(['DNS:localhost', 'IP:127.0.0.1']);
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    names.add(isIP(hostname) ? `IP:${hostname}` : `DNS:${hostname}`);
  }
  return [...names].join(',');
}

async function generateCertificate(certificateFile: string, privateKeyFile: string, hostname: string): Promise<void> {
  await runOpenSsl([
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-sha256',
    '-nodes',
    '-days', '3650',
    '-keyout', privateKeyFile,
    '-out', certificateFile,
    '-subj', '/CN=Terminal Web Zellij',
    '-addext', `subjectAltName=${certificateSubjectAltName(hostname)}`,
  ]);
}

export async function ensureZellijWebCertificate(
  zellijWebBaseUrl: string,
  certificateFile: string,
  privateKeyFile: string,
  dependencies: ZellijCertificateDependencies = {},
): Promise<boolean> {
  const [certificateStat, privateKeyStat] = await Promise.all([
    fileStatus(certificateFile),
    fileStatus(privateKeyFile),
  ]);
  if ((certificateStat === null) !== (privateKeyStat === null)) {
    throw new Error('Zellij Web certificate and private key must either both exist or both be absent');
  }

  const runner = dependencies.runOpenSsl ?? runOpenSsl;
  if (certificateStat && privateKeyStat) {
    await validateCertificatePair(certificateFile, privateKeyFile, runner);
    return false;
  }

  const certificateDirectory = path.dirname(certificateFile);
  const privateKeyDirectory = path.dirname(privateKeyFile);
  await Promise.all([
    mkdir(certificateDirectory, { recursive: true, mode: 0o700 }),
    mkdir(privateKeyDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const certificateTemporaryDirectory = await mkdtemp(path.join(certificateDirectory, '.zellij-certificate-'));
  const keyTemporaryDirectory = certificateDirectory === privateKeyDirectory
    ? certificateTemporaryDirectory
    : await mkdtemp(path.join(privateKeyDirectory, '.zellij-key-'));
  const temporaryCertificate = path.join(certificateTemporaryDirectory, 'cert.pem');
  const temporaryPrivateKey = path.join(keyTemporaryDirectory, 'key.pem');
  try {
    const hostname = new URL(zellijWebBaseUrl).hostname.replace(/^\[|\]$/gu, '');
    await (dependencies.generateCertificate ?? generateCertificate)(
      temporaryCertificate,
      temporaryPrivateKey,
      hostname,
    );
    await Promise.all([
      chmod(temporaryCertificate, 0o644),
      chmod(temporaryPrivateKey, 0o600),
    ]);
    await validateCertificatePair(temporaryCertificate, temporaryPrivateKey, runner);
    await rename(temporaryPrivateKey, privateKeyFile);
    await rename(temporaryCertificate, certificateFile);
    return true;
  } finally {
    await rm(certificateTemporaryDirectory, { recursive: true, force: true });
    if (keyTemporaryDirectory !== certificateTemporaryDirectory) {
      await rm(keyTemporaryDirectory, { recursive: true, force: true });
    }
  }
}

export async function bootstrapZellij(
  config: AppConfig,
  dependencies: ZellijBootstrapDependencies = {},
): Promise<ZellijBootstrapResult> {
  const zellij = await ensureZellij(config.zellijManagedBinaryFile, dependencies.installer);
  const webSharingConfigured = await ensureZellijWebSharing(config.zellijConfigFile);
  const certificateCreated = await ensureZellijWebCertificate(
    config.zellijWebBaseUrl,
    config.zellijWebCertificateFile,
    config.zellijWebPrivateKeyFile,
    dependencies.certificate,
  );
  return { zellij, certificateCreated, webSharingConfigured };
}
