#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfiguration } from './config.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dataDirectory = path.join(projectRoot, 'data');
const serverFile = path.join(projectRoot, 'dist/codepilot-server.js');
const serviceRuntimeFile = path.join(projectRoot, 'scripts/service-runtime.mjs');
const pidFile = path.join(dataDirectory, 'codepilot-web.pid');
const runtimeFile = path.join(dataDirectory, 'service-runtime.json');
const logFile = path.join(dataDirectory, 'codepilot-web.log');

interface RuntimeMetadata {
  configFile: string;
  workspaceRoot: string;
  browserHost: string;
  port: number;
}

function usage(): string {
  return `Usage:
  codepilot-server start --host <address> --port <port> --workspace <directory> [options]
  codepilot-server stop
  codepilot-server restart
  codepilot-server status
  codepilot-server run --host <address> --port <port> --workspace <directory> [options]

Options:
  --host <address>         Browser host used for the HTTPS certificate
  --port <port>            HTTPS management port
  --workspace <directory>  Workspace directory to manage
  --config <file>          Configuration file (default: config.json)
  -h, --help               Show this help
`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(): Promise<number | null> {
  try {
    const value = (await readFile(pidFile, 'utf8')).trim();
    if (!/^\d+$/u.test(value)) throw new Error('Invalid CodePilot Web PID file');
    return Number(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function commandArguments(pid: number): Promise<string[]> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`)).toString('utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

async function isManagementProcess(pid: number): Promise<boolean> {
  return (await commandArguments(pid)).includes(serverFile);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !processExists(pid);
}

async function waitForPort(port: number, shouldBeOpen: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
    if (open === shouldBeOpen) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`port ${port} did not become ${shouldBeOpen ? 'ready' : 'free'}`);
}

async function writeSecureFile(file: string, content: string): Promise<void> {
  const temporaryFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporaryFile, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryFile, file);
  await chmod(file, 0o600);
}

async function runServiceRuntime(operation: 'cleanup' | 'ensure-support', metadata: RuntimeMetadata): Promise<void> {
  const child = spawn(process.execPath, [
    serviceRuntimeFile,
    operation,
    metadata.configFile,
    metadata.workspaceRoot,
    String(metadata.port),
  ], { cwd: projectRoot, shell: false, stdio: 'inherit' });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`support service ${operation} failed`);
}

function parseStartOptions(arguments_: string[]): string[] {
  const parsed = parseArgs({
    args: arguments_,
    options: {
      config: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      workspace: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const result: string[] = [];
  if (parsed.values.config) result.push('--config', parsed.values.config);
  if (parsed.values.host) result.push('--host', parsed.values.host);
  if (parsed.values.port) result.push('--port', parsed.values.port);
  if (parsed.values.workspace) result.push('--workspace', parsed.values.workspace);
  return result;
}

async function resolveMetadata(arguments_: string[]): Promise<{ metadata: RuntimeMetadata; serverArguments: string[] }> {
  const options = parseStartOptions(arguments_);
  const hasConfig = options.includes('--config');
  const serverArguments = hasConfig ? options : ['--config', path.resolve('config.json'), ...options];
  const loaded = await loadConfiguration(serverArguments, process.cwd());
  return {
    metadata: {
      configFile: loaded.configFilePath,
      workspaceRoot: loaded.config.workspaceRootRealPath,
      browserHost: new URL(loaded.config.publicBaseUrl).hostname,
      port: loaded.config.listenPort,
    },
    serverArguments,
  };
}

async function start(arguments_: string[]): Promise<void> {
  await access(serverFile, constants.R_OK);
  const { metadata, serverArguments } = await resolveMetadata(arguments_);
  const existingPid = await readPid();
  if (existingPid && processExists(existingPid)) {
    throw new Error(await isManagementProcess(existingPid)
      ? `CodePilot Web is already running with PID ${existingPid}`
      : `PID file points to another running process: ${existingPid}`);
  }
  if (existingPid) await rm(pidFile, { force: true });

  await waitForPort(metadata.port, false, 1_000);
  await runServiceRuntime('ensure-support', metadata);
  await writeSecureFile(runtimeFile, `${JSON.stringify(metadata, null, 2)}\n`);

  const logHandle = await open(logFile, 'w', 0o600);
  await logHandle.chmod(0o600);
  let child: ChildProcess | undefined;
  try {
    const spawnedChild = spawn(process.execPath, [serverFile, ...serverArguments], {
      cwd: projectRoot,
      detached: true,
      shell: false,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
    await new Promise<void>((resolve, reject) => {
      spawnedChild.once('spawn', resolve);
      spawnedChild.once('error', reject);
    });
    if (!spawnedChild.pid) throw new Error('CodePilot Web did not provide a process ID');
    child = spawnedChild;
    await writeSecureFile(pidFile, `${spawnedChild.pid}\n`);
    spawnedChild.unref();
  } finally {
    await logHandle.close();
  }

  try {
    await waitForPort(metadata.port, true, 15_000);
  } catch (error) {
    if (child?.pid && processExists(child.pid)) process.kill(child.pid, 'SIGTERM');
    await Promise.all([rm(pidFile, { force: true }), rm(runtimeFile, { force: true })]);
    throw error;
  }

  process.stdout.write(`CodePilot Web started with PID ${child.pid}\n`);
  process.stdout.write(`Access URL: https://${metadata.browserHost}:${metadata.port}\n`);
  process.stdout.write(`Workspace: ${metadata.workspaceRoot}\n`);
  process.stdout.write(`Log: ${logFile}\n`);
}

async function readMetadata(): Promise<RuntimeMetadata> {
  const value = JSON.parse(await readFile(runtimeFile, 'utf8')) as Partial<RuntimeMetadata>;
  if (typeof value.configFile !== 'string' || typeof value.workspaceRoot !== 'string') {
    throw new Error('Invalid CodePilot Web runtime metadata');
  }
  if (typeof value.browserHost === 'string' && Number.isInteger(value.port)) return value as RuntimeMetadata;
  const loaded = await loadConfiguration([
    '--config', value.configFile,
    '--workspace', value.workspaceRoot,
  ], projectRoot);
  return {
    configFile: loaded.configFilePath,
    workspaceRoot: loaded.config.workspaceRootRealPath,
    browserHost: new URL(loaded.config.publicBaseUrl).hostname,
    port: loaded.config.listenPort,
  };
}

async function stop(): Promise<void> {
  const pid = await readPid();
  let metadata: RuntimeMetadata | null = null;
  try {
    metadata = await readMetadata();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (pid && processExists(pid)) {
    if (!(await isManagementProcess(pid))) throw new Error(`PID ${pid} does not belong to this CodePilot Web service`);
    process.stdout.write(`Sending SIGTERM to CodePilot Web (PID ${pid})\n`);
    process.kill(pid, 'SIGTERM');
    if (!(await waitForExit(pid, 10_000))) {
      process.stderr.write(`Sending SIGKILL to CodePilot Web (PID ${pid})\n`);
      process.kill(pid, 'SIGKILL');
      if (!(await waitForExit(pid, 5_000))) throw new Error(`CodePilot Web process ${pid} did not stop`);
    }
  } else {
    process.stdout.write('CodePilot Web is not running\n');
  }

  await rm(pidFile, { force: true });
  if (metadata) await runServiceRuntime('cleanup', metadata);
  await rm(runtimeFile, { force: true });
  process.stdout.write('CodePilot Web stopped\n');
}

async function status(): Promise<void> {
  const pid = await readPid();
  if (pid && processExists(pid) && await isManagementProcess(pid)) {
    process.stdout.write(`CodePilot Web is running with PID ${pid}\n`);
    return;
  }
  process.stdout.write('CodePilot Web is stopped\n');
  process.exitCode = 1;
}

async function run(arguments_: string[]): Promise<void> {
  const { metadata, serverArguments } = await resolveMetadata(arguments_);
  await runServiceRuntime('ensure-support', metadata);
  const child = spawn(process.execPath, [serverFile, ...serverArguments], {
    cwd: projectRoot,
    shell: false,
    stdio: 'inherit',
  });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
    process.exitCode = exitCode;
  } finally {
    await runServiceRuntime('cleanup', metadata);
  }
}

async function restart(): Promise<void> {
  const restartDelay = Number(process.env.CODEPILOT_WEB_RESTART_DELAY_MS ?? '0');
  if (!Number.isInteger(restartDelay) || restartDelay < 0 || restartDelay > 10_000) {
    throw new Error('CODEPILOT_WEB_RESTART_DELAY_MS must be an integer from 0 to 10000');
  }
  if (restartDelay > 0) await new Promise(resolve => setTimeout(resolve, restartDelay));
  const metadata = await readMetadata();
  await stop();
  await start([
    '--config', metadata.configFile,
    '--host', metadata.browserHost,
    '--port', String(metadata.port),
    '--workspace', metadata.workspaceRoot,
  ]);
}

async function main(): Promise<void> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const [command, ...arguments_] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return;
  }
  if (command === 'start') await start(arguments_);
  else if (command === 'stop') await stop();
  else if (command === 'restart') await restart();
  else if (command === 'status') await status();
  else if (command === 'run') await run(arguments_);
  else throw new Error(`unknown command: ${command}`);
}

main().catch(error => {
  process.stderr.write(`CodePilot Web lifecycle failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
