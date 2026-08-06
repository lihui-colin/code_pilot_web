import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureOpenVSCode, type OpenVSCodeInstallation } from './services/openvscode-installer.js';
import { ensureZellijWebCertificate } from './services/zellij-bootstrap.js';
import { ensureZellij, ZELLIJ_VERSION_OUTPUT, type ZellijResolution } from './services/zellij-installer.js';

export interface InitOptions {
  host: string;
  listenHost: string;
  servicePort: number;
  zellijPort: number;
  viewerPort: number;
  openVSCodePort: number;
  configFile: string;
}

export interface InitDependencies {
  installOpenVSCode?: (downloadDirectory: string) => Promise<OpenVSCodeInstallation>;
  installZellij?: (managedBinaryFile: string) => Promise<ZellijResolution>;
  ensureCertificate?: typeof ensureZellijWebCertificate;
  homeDirectory?: string;
  xdgConfigHome?: string;
  xdgDataHome?: string;
}

export interface InitResult {
  configFile: string;
  openVSCodeExecutable: string;
  zellij: ZellijResolution;
}

function validatePort(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
}

export function validateInitOptions(options: InitOptions): void {
  if (!options.host || options.host === '0.0.0.0' || options.host === '::' || options.host === '[::]') {
    throw new Error('--host must be the host machine IP or hostname used by browsers');
  }
  if (options.host.includes('://') || options.host.includes('/')) {
    throw new Error('--host must not include a URL scheme or path');
  }
  try {
    const url = new URL(`https://${options.host}:${options.servicePort}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
  } catch {
    throw new Error('--host must be a valid hostname, IPv4 address, or bracketed IPv6 address');
  }

  validatePort('service port', options.servicePort);
  validatePort('Zellij port', options.zellijPort);
  validatePort('viewer port', options.viewerPort);
  validatePort('OpenVSCode port', options.openVSCodePort);
  const ports = new Set([
    options.servicePort,
    options.zellijPort,
    options.viewerPort,
    options.openVSCodePort,
  ]);
  if (ports.size !== 4) throw new Error('service, Zellij, viewer, and OpenVSCode ports must be different');
}

async function fileStatus(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeSecureFile(filePath: string, content: string): Promise<void> {
  const temporaryFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const file = await open(temporaryFile, 'wx', 0o600);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryFile, filePath);
  await chmod(filePath, 0o600);
}

async function ensureDirectorySecret(secretFile: string): Promise<void> {
  const existing = await fileStatus(secretFile);
  if (existing) {
    if (!existing.isFile() || existing.size === 0) throw new Error('directory ID secret must be a non-empty regular file');
    await chmod(secretFile, 0o600);
    return;
  }
  await writeSecureFile(secretFile, `${randomBytes(32).toString('base64')}\n`);
}

async function ensureZellijConfig(configFile: string, settings: ReadonlyMap<string, string>): Promise<void> {
  const existing = await fileStatus(configFile);
  if (existing && !existing.isFile()) throw new Error('Zellij config must be a regular file');
  if (!existing) await writeSecureFile(configFile, '');
  const configStat = await lstat(configFile);
  let content = await readFile(configFile, 'utf8');
  for (const [name, replacement] of settings) {
    const activeSetting = new RegExp(`^\\s*${name}\\s+.*$`, 'gm');
    content = activeSetting.test(content)
      ? content.replace(activeSetting, replacement)
      : `${content.replace(/\s*$/u, '')}\n${replacement}\n`;
  }
  const temporaryFile = `${configFile}.tmp-${process.pid}-${Date.now()}`;
  const file = await open(temporaryFile, 'wx', configStat.mode & 0o777);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryFile, configFile);
  await chmod(configFile, configStat.mode & 0o777);
}

export async function initializeCodePilot(
  options: InitOptions,
  dependencies: InitDependencies = {},
): Promise<InitResult> {
  validateInitOptions(options);
  const configFile = path.resolve(options.configFile);
  const configDirectory = path.dirname(configFile);
  const dataDirectory = path.join(configDirectory, 'data');
  const homeDirectory = dependencies.homeDirectory ?? os.homedir();
  const zellijConfigFile = path.join(
    dependencies.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? path.join(homeDirectory, '.config'),
    'zellij/config.kdl',
  );
  const zellijTokenDatabaseFile = path.join(
    dependencies.xdgDataHome ?? process.env.XDG_DATA_HOME ?? path.join(homeDirectory, '.local/share'),
    'zellij/tokens.db',
  );
  const managedZellijFile = path.join(dataDirectory, 'bin/zellij');
  const certificateFile = path.join(dataDirectory, 'zellij/certs/cert.pem');
  const privateKeyFile = path.join(dataDirectory, 'zellij/certs/key.pem');
  const secretFile = path.join(dataDirectory, 'directory-id.secret');
  const openVSCodeDirectory = path.join(dataDirectory, 'openvscode');
  const publicBaseUrl = `https://${options.host}:${options.servicePort}`;

  await Promise.all([
    mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(zellijConfigFile), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(zellijTokenDatabaseFile), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(certificateFile), { recursive: true, mode: 0o700 }),
  ]);
  await ensureDirectorySecret(secretFile);
  await (dependencies.ensureCertificate ?? ensureZellijWebCertificate)(
    publicBaseUrl,
    certificateFile,
    privateKeyFile,
  );
  await ensureZellijConfig(zellijConfigFile, new Map([
    ['mouse_mode', 'mouse_mode true'],
    ['copy_on_select', 'copy_on_select true'],
    ['scroll_buffer_size', 'scroll_buffer_size 500000'],
    ['web_server', 'web_server true'],
    ['web_sharing', 'web_sharing "on"'],
    ['show_startup_tips', 'show_startup_tips false'],
    ['show_release_notes', 'show_release_notes false'],
    ['web_server_ip', 'web_server_ip "127.0.0.1"'],
    ['web_server_port', `web_server_port ${options.zellijPort}`],
    ['web_server_cert', `web_server_cert "${certificateFile}"`],
    ['web_server_key', `web_server_key "${privateKeyFile}"`],
  ]));

  const openVSCode = await (dependencies.installOpenVSCode ?? ensureOpenVSCode)(openVSCodeDirectory);
  const zellij = await (dependencies.installZellij ?? ensureZellij)(managedZellijFile);
  if (zellij.version !== ZELLIJ_VERSION_OUTPUT) {
    throw new Error(`Zellij ${ZELLIJ_VERSION_OUTPUT.replace('zellij ', '')} is required; found ${zellij.version ?? 'no version'}`);
  }

  const config = {
    listenHost: options.listenHost,
    listenPort: options.servicePort,
    publicBaseUrl,
    zellij: {
      webPort: options.zellijPort,
      managedBinaryFile: path.relative(configDirectory, managedZellijFile),
      configFile: zellijConfigFile,
      webTokenDatabaseFile: zellijTokenDatabaseFile,
      webCertificateFile: path.relative(configDirectory, certificateFile),
      webPrivateKeyFile: path.relative(configDirectory, privateKeyFile),
    },
    openVSCode: {
      executableFile: path.relative(configDirectory, path.join(openVSCodeDirectory, 'current/bin/openvscode-server')),
      port: options.openVSCodePort,
    },
    directoryIdSecretFile: path.relative(configDirectory, secretFile),
    viewerPortRange: { start: options.viewerPort, end: options.viewerPort },
    viewerIdleTimeoutMinutes: 60,
    viewerMaxInstances: 1,
    projectMarkers: ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml'],
    allowedSessionCommands: ['codex'],
    codexChatAppearance: {
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      fontSize: 16,
    },
  };
  await writeSecureFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
  return { configFile, openVSCodeExecutable: openVSCode.executableFile, zellij };
}
