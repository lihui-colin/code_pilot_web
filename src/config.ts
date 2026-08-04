import { constants } from 'node:fs';
import { access, chmod, open, readFile, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const markerNames = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml'] as const;

const FileConfigSchema = z.object({
  listenHost: z.string().min(1).default('0.0.0.0'),
  listenPort: z.number().int().min(1).max(65_535).default(8020),
  publicBaseUrl: z.string().url(),
  zellij: z.object({
    webPort: z.number().int().min(1).max(65_535).default(8021),
    managedBinaryFile: z.string().min(1),
    configFile: z.string().min(1),
    webTokenDatabaseFile: z.string().min(1),
    webCertificateFile: z.string().min(1),
    webPrivateKeyFile: z.string().min(1),
    webToken: z.object({
      name: z.string().min(1).max(128),
      value: z.string().uuid(),
    }).strict().optional(),
  }).strict(),
  openVSCode: z.object({
    executableFile: z.string().min(1),
    port: z.number().int().min(1).max(65_535).default(8023),
  }).strict(),
  directoryIdSecretFile: z.string().min(1),
  viewerPortRange: z.object({
    start: z.number().int().min(1).max(65_535),
    end: z.number().int().min(1).max(65_535),
  }).strict().refine(value => value.start <= value.end, 'viewer port range is invalid'),
  viewerIdleTimeoutMinutes: z.number().int().positive().default(60),
  viewerMaxInstances: z.number().int().positive().default(10),
  projectMarkers: z.array(z.enum(markerNames)).min(1).default([...markerNames]),
  allowedSessionCommands: z.array(z.literal('codex')).min(1).default(['codex']),
}).strict();

export interface AppConfig {
  listenHost: string;
  listenPort: number;
  publicBaseUrl: string;
  zellijWebPort: number;
  zellijManagedBinaryFile: string;
  zellijConfigFile: string;
  zellijWebTokenDatabaseFile: string;
  zellijWebCertificateFile: string;
  zellijWebPrivateKeyFile: string;
  zellijWebToken: ZellijWebToken | null;
  openVSCodeExecutableFile: string;
  openVSCodePort: number;
  directoryIdSecretFile: string;
  viewerPortRange: { start: number; end: number };
  viewerIdleTimeoutMinutes: number;
  viewerMaxInstances: number;
  projectMarkers: Array<(typeof markerNames)[number]>;
  allowedSessionCommands: 'codex'[];
  workspaceRootRealPath: string;
}

export interface LoadedConfiguration {
  config: AppConfig;
  configFilePath: string;
  directoryIdSecret: Buffer | null;
}

export interface ZellijWebToken {
  name: string;
  value: string;
}

function validateBaseUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') {
    throw new Error(`${name} must use the IP address or hostname that browsers access`);
  }
  if (url.search || url.hash) throw new Error(`${name} must not contain a query or fragment`);
  if (url.pathname !== '/' && url.pathname !== '') throw new Error(`${name} must not contain an application path`);
  return url.toString().replace(/\/$/u, '');
}

async function readRequiredFile(filePath: string, label: string, secure = false): Promise<Buffer> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error(`${label} must be a regular file`);
  if (secure && (fileStat.mode & 0o077) !== 0) throw new Error(`${label} permissions must not allow group or other access`);
  const content = await readFile(filePath);
  if (content.length === 0) throw new Error(`${label} must not be empty`);
  return content;
}

async function loadDirectorySecret(filePath: string): Promise<Buffer | null> {
  try {
    return await readRequiredFile(filePath, 'directory ID secret', true);
  } catch {
    return null;
  }
}

export async function loadConfiguration(argv = process.argv.slice(2), cwd = process.cwd()): Promise<LoadedConfiguration> {
  const parsed = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'config.json' },
      'workspace-root': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const workspaceRoot = parsed.values['workspace-root'];
  if (!workspaceRoot) throw new Error('--workspace-root is required');

  const workspaceRootRealPath = await realpath(path.resolve(cwd, workspaceRoot));
  const workspaceStat = await stat(workspaceRootRealPath);
  if (!workspaceStat.isDirectory()) throw new Error('--workspace-root must resolve to a directory');
  await access(workspaceRootRealPath, constants.R_OK);

  const configPath = path.resolve(cwd, parsed.values.config ?? 'config.json');
  const configDirectory = path.dirname(configPath);
  const raw = FileConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const publicBaseUrl = validateBaseUrl(raw.publicBaseUrl, 'publicBaseUrl');
  const reservedPorts = new Set([raw.listenPort, raw.zellij.webPort]);
  for (let port = raw.viewerPortRange.start; port <= raw.viewerPortRange.end; port += 1) reservedPorts.add(port);
  if (reservedPorts.has(raw.openVSCode.port)) {
    throw new Error('OpenVSCode port must be different from management, Zellij, and viewer ports');
  }
  const resolveConfigPath = (value: string) => path.resolve(configDirectory, value);
  const directoryIdSecretFile = resolveConfigPath(raw.directoryIdSecretFile);

  return {
    config: {
      listenHost: raw.listenHost,
      listenPort: raw.listenPort,
      publicBaseUrl,
      zellijWebPort: raw.zellij.webPort,
      zellijManagedBinaryFile: resolveConfigPath(raw.zellij.managedBinaryFile),
      zellijConfigFile: resolveConfigPath(raw.zellij.configFile),
      zellijWebTokenDatabaseFile: resolveConfigPath(raw.zellij.webTokenDatabaseFile),
      zellijWebCertificateFile: resolveConfigPath(raw.zellij.webCertificateFile),
      zellijWebPrivateKeyFile: resolveConfigPath(raw.zellij.webPrivateKeyFile),
      zellijWebToken: raw.zellij.webToken ?? null,
      openVSCodeExecutableFile: resolveConfigPath(raw.openVSCode.executableFile),
      openVSCodePort: raw.openVSCode.port,
      directoryIdSecretFile,
      viewerPortRange: raw.viewerPortRange,
      viewerIdleTimeoutMinutes: raw.viewerIdleTimeoutMinutes,
      viewerMaxInstances: raw.viewerMaxInstances,
      projectMarkers: raw.projectMarkers,
      allowedSessionCommands: raw.allowedSessionCommands,
      workspaceRootRealPath,
    },
    configFilePath: configPath,
    directoryIdSecret: await loadDirectorySecret(directoryIdSecretFile),
  };
}

export async function persistZellijWebToken(
  configFilePath: string,
  token: ZellijWebToken | null,
): Promise<void> {
  const raw = JSON.parse(await readFile(configFilePath, 'utf8')) as Record<string, unknown>;
  const zellij = raw.zellij;
  if (!zellij || typeof zellij !== 'object' || Array.isArray(zellij)) {
    throw new Error('zellij configuration is missing');
  }
  if (token) (zellij as Record<string, unknown>).webToken = token;
  else delete (zellij as Record<string, unknown>).webToken;

  const temporaryFile = `${configFilePath}.tmp-${process.pid}-${Date.now()}`;
  const file = await open(temporaryFile, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryFile, configFilePath);
  await chmod(configFilePath, 0o600);
}
