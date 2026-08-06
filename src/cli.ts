#!/usr/bin/env node

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfiguration } from './config.js';
import { initializeCodePilot, type InitOptions } from './init.js';

const execFileAsync = promisify(execFile);

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
  openVSCodeExecutable: string;
  openVSCodePort: number;
  viewerPorts: number[];
  zellijConfigFile: string;
  zellijManagedBinary: string;
  zellijWebPort: number;
}

interface ProgressBar {
  update(step: number, message: string): void;
  finish(message: string): void;
  fail(message: string): void;
}

function createProgressBar(label: string, totalSteps: number): ProgressBar {
  const interactive = Boolean(process.stdout.isTTY);
  let lastLength = 0;
  const update = (step: number, message: string) => {
    const percentage = Math.max(0, Math.min(100, Math.round((step / totalSteps) * 100)));
    if (!interactive) {
      process.stdout.write(`${label}: ${percentage}% ${message}\n`);
      return;
    }
    const width = 24;
    const filled = Math.round((percentage / 100) * width);
    const line = `${label} [${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${percentage}% ${message}`;
    process.stdout.write(`\r${line}${' '.repeat(Math.max(0, lastLength - line.length))}`);
    lastLength = line.length;
  };
  const endLine = (message: string) => {
    if (interactive) process.stdout.write('\n');
    process.stdout.write(`${label}: ${message}\n`);
  };
  return {
    update,
    finish: endLine,
    fail: message => endLine(`failed - ${message}`),
  };
}

function usage(): string {
  return `Usage:
  codepilot-server init --host <address> --service-port <port> [options]
  codepilot-server start --host <address> --port <port> --workspace <directory> [options]
  codepilot-server stop
  codepilot-server restart
  codepilot-server status
  codepilot-server run --host <address> --port <port> --workspace <directory> [options]

Options:
  --service-port <port>   CodePilot Web HTTPS port for init
  --zellij-port <port>   Local Zellij Web port for init (default: 5021)
  --viewer-port <port>   Local code-viewer port for init (default: 5022)
  --openvscode-port <port> Local OpenVSCode port for init (default: 5023)
  --listen-host <address> Listen address for init (default: 0.0.0.0)
  --non-interactive      Fail instead of prompting for missing init values
  --host <address>         Browser host used for the HTTPS certificate
  --port <port>            HTTPS management port
  --workspace <directory>  Workspace directory to manage
  --config <file>          Configuration file (default: config.json)
  -h, --help               Show this help
`;
}

function parsePort(name: string, value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer between 1 and 65535`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

async function init(arguments_: string[]): Promise<void> {
  const parsed = parseArgs({
    args: arguments_,
    options: {
      config: { type: 'string', default: 'config.json' },
      host: { type: 'string' },
      'service-port': { type: 'string' },
      'zellij-port': { type: 'string', default: '5021' },
      'viewer-port': { type: 'string', default: '5022' },
      'openvscode-port': { type: 'string', default: '5023' },
      'listen-host': { type: 'string', default: '0.0.0.0' },
      'non-interactive': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    process.stdout.write(usage());
    return;
  }

  let host = parsed.values.host;
  let servicePort = parsed.values['service-port'];
  let zellijPort = parsed.values['zellij-port'] ?? '5021';
  let viewerPort = parsed.values['viewer-port'] ?? '5022';
  let openVSCodePort = parsed.values['openvscode-port'] ?? '5023';
  if (!parsed.values['non-interactive']) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      host ||= (await prompt.question('Browser-reachable host machine IP or hostname (not the container IP): ')).trim();
      servicePort ||= (await prompt.question('CodePilot Web HTTPS port: ')).trim();
      const promptedZellij = (await prompt.question(`Zellij Web HTTPS port [${zellijPort}]: `)).trim();
      const promptedViewer = (await prompt.question(`Local code-viewer port [${viewerPort}]: `)).trim();
      const promptedOpenVSCode = (await prompt.question(`Local OpenVSCode upstream port [${openVSCodePort}]: `)).trim();
      if (promptedZellij) zellijPort = promptedZellij;
      if (promptedViewer) viewerPort = promptedViewer;
      if (promptedOpenVSCode) openVSCodePort = promptedOpenVSCode;
    } finally {
      prompt.close();
    }
  }
  if (!host) throw new Error('--host is required and must be the browser-reachable host machine address');
  if (!servicePort) throw new Error('--service-port is required');

  const options: InitOptions = {
    host,
    listenHost: parsed.values['listen-host'] ?? '0.0.0.0',
    servicePort: parsePort('service port', servicePort),
    zellijPort: parsePort('Zellij port', zellijPort),
    viewerPort: parsePort('viewer port', viewerPort),
    openVSCodePort: parsePort('OpenVSCode port', openVSCodePort),
    configFile: path.resolve(parsed.values.config ?? 'config.json'),
  };
  process.stdout.write(`Initializing CodePilot Web at ${path.dirname(options.configFile)}\n`);
  const result = await initializeCodePilot(options);
  process.stdout.write('Configuration initialization complete.\n');
  process.stdout.write(`Config: ${result.configFile}\n`);
  process.stdout.write(`OpenVSCode executable: ${result.openVSCodeExecutable}\n`);
  process.stdout.write(`Zellij: ${result.zellij.executablePath}\n`);
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

function hasOption(arguments_: readonly string[], option: string, value: string): boolean {
  const index = arguments_.indexOf(option);
  return index >= 0 && arguments_[index + 1] === value;
}

async function processStartTime(pid: number): Promise<string | null> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, 'utf8');
    return content.slice(content.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

async function listenerPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('ss', ['-H', '-ltnp', `sport = :${port}`], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      shell: false,
    });
    return [...stdout.matchAll(/pid=(\d+)/gu)].map(match => Number(match[1]));
  } catch {
    return [];
  }
}

function matchesManagementArguments(arguments_: readonly string[], metadata: RuntimeMetadata): boolean {
  return arguments_.includes(serverFile)
    && hasOption(arguments_, '--config', metadata.configFile)
    && hasOption(arguments_, '--workspace', metadata.workspaceRoot);
}

async function isManagementProcess(pid: number, metadata: RuntimeMetadata): Promise<boolean> {
  const arguments_ = await commandArguments(pid);
  if (!matchesManagementArguments(arguments_, metadata)) return false;
  const hasHostOrPort = arguments_.includes('--host') || arguments_.includes('--port');
  if (hasHostOrPort) {
    return hasOption(arguments_, '--host', metadata.browserHost)
      && hasOption(arguments_, '--port', String(metadata.port));
  }
  return (await listenerPids(metadata.port)).includes(pid);
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
    JSON.stringify(metadata),
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
  const metadata = {
    configFile: loaded.configFilePath,
    workspaceRoot: loaded.config.workspaceRootRealPath,
    browserHost: new URL(loaded.config.publicBaseUrl).hostname,
    port: loaded.config.listenPort,
    openVSCodeExecutable: loaded.config.openVSCodeExecutableFile,
    openVSCodePort: loaded.config.openVSCodePort,
    viewerPorts: Array.from(
      { length: loaded.config.viewerPortRange.end - loaded.config.viewerPortRange.start + 1 },
      (_, index) => loaded.config.viewerPortRange.start + index,
    ),
    zellijConfigFile: loaded.config.zellijConfigFile,
    zellijManagedBinary: loaded.config.zellijManagedBinaryFile,
    zellijWebPort: loaded.config.zellijWebPort,
  };
  return {
    metadata,
    serverArguments: [
      '--config', metadata.configFile,
      '--host', metadata.browserHost,
      '--port', String(metadata.port),
      '--workspace', metadata.workspaceRoot,
    ],
  };
}

async function start(arguments_: string[]): Promise<void> {
  const progress = createProgressBar('Starting CodePilot Web', 5);
  try {
    progress.update(1, 'validating configuration');
    try {
      await access(serverFile, constants.R_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('CodePilot Web is not built; run npm run build before starting the service');
      }
      throw error;
    }
    const { metadata, serverArguments } = await resolveMetadata(arguments_);
    const existingPid = await readPid();
    if (existingPid && processExists(existingPid)) {
      throw new Error(await isManagementProcess(existingPid, metadata)
        ? `CodePilot Web is already running with PID ${existingPid}`
        : `PID file points to another running process: ${existingPid}`);
    }
    if (existingPid) await rm(pidFile, { force: true });

    progress.update(2, 'checking management port');
    await waitForPort(metadata.port, false, 1_000);
    progress.update(3, 'starting support services');
    await runServiceRuntime('ensure-support', metadata);
    let child: ChildProcess | undefined;
    try {
      await writeSecureFile(runtimeFile, `${JSON.stringify(metadata, null, 2)}\n`);
      const logHandle = await open(logFile, 'w', 0o600);
      await logHandle.chmod(0o600);
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
      progress.update(4, 'waiting for management service');
      await waitForPort(metadata.port, true, 15_000);
    } catch (error) {
      if (child?.pid && processExists(child.pid)) process.kill(child.pid, 'SIGTERM');
      await runServiceRuntime('cleanup', metadata).catch(() => undefined);
      await Promise.all([rm(pidFile, { force: true }), rm(runtimeFile, { force: true })]);
      throw error;
    }

    progress.update(5, 'ready');
    progress.finish(`started with PID ${child.pid}`);
    process.stdout.write(`Access URL: https://${metadata.browserHost}:${metadata.port}\n`);
    process.stdout.write(`Workspace: ${metadata.workspaceRoot}\n`);
    process.stdout.write(`Log: ${logFile}\n`);
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : 'unknown error');
    throw error;
  }
}

async function readMetadata(): Promise<RuntimeMetadata> {
  const value = JSON.parse(await readFile(runtimeFile, 'utf8')) as Partial<RuntimeMetadata>;
  if (typeof value.configFile !== 'string' || typeof value.workspaceRoot !== 'string') {
    throw new Error('Invalid CodePilot Web runtime metadata');
  }
  if (typeof value.browserHost === 'string'
    && Number.isInteger(value.port)
    && typeof value.openVSCodeExecutable === 'string'
    && Number.isInteger(value.openVSCodePort)
    && Array.isArray(value.viewerPorts)
    && value.viewerPorts.every(Number.isInteger)
    && typeof value.zellijConfigFile === 'string'
    && typeof value.zellijManagedBinary === 'string'
    && Number.isInteger(value.zellijWebPort)) return value as RuntimeMetadata;
  const loaded = await loadConfiguration([
    '--config', value.configFile,
    '--workspace', value.workspaceRoot,
  ], projectRoot);
  return {
    configFile: loaded.configFilePath,
    workspaceRoot: loaded.config.workspaceRootRealPath,
    browserHost: new URL(loaded.config.publicBaseUrl).hostname,
    port: loaded.config.listenPort,
    openVSCodeExecutable: loaded.config.openVSCodeExecutableFile,
    openVSCodePort: loaded.config.openVSCodePort,
    viewerPorts: Array.from(
      { length: loaded.config.viewerPortRange.end - loaded.config.viewerPortRange.start + 1 },
      (_, index) => loaded.config.viewerPortRange.start + index,
    ),
    zellijConfigFile: loaded.config.zellijConfigFile,
    zellijManagedBinary: loaded.config.zellijManagedBinaryFile,
    zellijWebPort: loaded.config.zellijWebPort,
  };
}

export async function recoverMetadataFromArguments(arguments_: readonly string[]): Promise<RuntimeMetadata | null> {
  if (!arguments_.includes(serverFile)) return null;
  const recoveredArguments: string[] = [];
  for (const option of ['--config', '--host', '--port', '--workspace']) {
    const index = arguments_.indexOf(option);
    const value = index >= 0 ? arguments_[index + 1] : undefined;
    if (!value) return null;
    recoveredArguments.push(option, value);
  }
  return (await resolveMetadata(recoveredArguments)).metadata;
}

async function recoverMetadataFromProcess(pid: number): Promise<RuntimeMetadata | null> {
  return recoverMetadataFromArguments(await commandArguments(pid));
}

async function stop(): Promise<void> {
  const progress = createProgressBar('Stopping CodePilot Web', 5);
  try {
    progress.update(1, 'reading runtime state');
    const pid = await readPid();
    let metadata: RuntimeMetadata | null = null;
    try {
      metadata = await readMetadata();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (pid && processExists(pid)) metadata = await recoverMetadataFromProcess(pid);
    }

    if (pid && processExists(pid)) {
      if (!metadata || !(await isManagementProcess(pid, metadata))) {
        throw new Error(`PID ${pid} does not belong to this CodePilot Web service`);
      }
      const startTime = await processStartTime(pid);
      if (!startTime) throw new Error(`CodePilot Web process ${pid} identity could not be verified`);
      progress.update(2, `sending SIGTERM to PID ${pid}`);
      process.kill(pid, 'SIGTERM');
      if (!(await waitForExit(pid, 10_000))) {
        const arguments_ = await commandArguments(pid);
        if (await processStartTime(pid) !== startTime || !matchesManagementArguments(arguments_, metadata)) {
          throw new Error(`CodePilot Web process ${pid} identity changed while stopping`);
        }
        progress.update(3, `sending SIGKILL to PID ${pid}`);
        process.kill(pid, 'SIGKILL');
        if (!(await waitForExit(pid, 5_000))) throw new Error(`CodePilot Web process ${pid} did not stop`);
      } else {
        progress.update(3, 'management service stopped');
      }
    } else {
      progress.update(2, 'management service is not running');
      progress.update(3, 'no management process to stop');
    }

    progress.update(4, 'cleaning support services');
    await rm(pidFile, { force: true });
    if (metadata) await runServiceRuntime('cleanup', metadata);
    await rm(runtimeFile, { force: true });
    progress.update(5, 'complete');
    progress.finish('stopped');
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : 'unknown error');
    throw error;
  }
}

async function status(): Promise<void> {
  const pid = await readPid();
  let metadata: RuntimeMetadata | null = null;
  try {
    metadata = await readMetadata();
  } catch {
    // Missing or invalid runtime metadata means ownership cannot be verified.
  }
  if (pid && metadata && processExists(pid) && await isManagementProcess(pid, metadata)) {
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
  if (command === 'init') await init(arguments_);
  else if (command === 'start') await start(arguments_);
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
