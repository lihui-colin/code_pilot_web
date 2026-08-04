#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, chmod, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dataDirectory = path.join(projectRoot, 'data');
const openVSCodePidFile = path.join(dataDirectory, 'openvscode.pid');
const zellijWebPidFile = path.join(dataDirectory, 'zellij-web.pid');

function resolveConfigPath(configDirectory, value) {
  return path.resolve(configDirectory, value);
}

async function loadRuntime(configFile, workspaceRoot) {
  const resolvedConfigFile = await realpath(configFile);
  const configDirectory = path.dirname(resolvedConfigFile);
  const config = JSON.parse(await readFile(resolvedConfigFile, 'utf8'));
  const workspaceRootRealPath = await realpath(workspaceRoot);
  const workspaceStat = await stat(workspaceRootRealPath);
  if (!workspaceStat.isDirectory()) throw new Error('workspace root is not a directory');
  return {
    configFile: resolvedConfigFile,
    managementPort: Number(config.listenPort),
    openVSCodeExecutable: resolveConfigPath(configDirectory, config.openVSCode.executableFile),
    openVSCodePort: Number(config.openVSCode.port),
    viewerPorts: Array.from(
      { length: Number(config.viewerPortRange.end) - Number(config.viewerPortRange.start) + 1 },
      (_, index) => Number(config.viewerPortRange.start) + index,
    ),
    workspaceRoot: workspaceRootRealPath,
    zellijConfigFile: resolveConfigPath(configDirectory, config.zellij.configFile),
    zellijManagedBinary: resolveConfigPath(configDirectory, config.zellij.managedBinaryFile),
    zellijWebPort: Number(config.zellij.webPort),
  };
}

async function isExecutable(file) {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function zellijVersion(file) {
  try {
    const { stdout } = await execFile(file, ['--version'], { shell: false, timeout: 5_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function resolveZellijExecutable(runtime) {
  if (await isExecutable(runtime.zellijManagedBinary)
    && await zellijVersion(runtime.zellijManagedBinary) === 'zellij 0.44.3') {
    return runtime.zellijManagedBinary;
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, 'zellij');
    if (await isExecutable(candidate) && await zellijVersion(candidate) === 'zellij 0.44.3') return candidate;
  }
  throw new Error('Zellij 0.44.3 executable was not found');
}

async function listenerPids(port) {
  try {
    const { stdout } = await execFile('ss', ['-H', '-ltnp', `sport = :${port}`], {
      shell: false,
      timeout: 5_000,
    });
    return [...stdout.matchAll(/pid=(\d+)/gu)].map(match => Number(match[1]));
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      const stdout = String(error.stdout ?? '');
      return [...stdout.matchAll(/pid=(\d+)/gu)].map(match => Number(match[1]));
    }
    throw error;
  }
}

async function commandArguments(pid) {
  try {
    const content = await readFile(`/proc/${pid}/cmdline`);
    return content.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

async function processGroup(pid) {
  const content = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = content.slice(content.lastIndexOf(')') + 2).split(' ');
  return Number(fields[2]);
}

function hasOption(arguments_, option, value) {
  const index = arguments_.indexOf(option);
  return index >= 0 && arguments_[index + 1] === value;
}

async function processKind(pid, runtime) {
  const arguments_ = await commandArguments(pid);
  if (arguments_.length === 0) return null;
  const managementEntry = path.join(projectRoot, 'dist/server.js');
  if (arguments_.includes(managementEntry) && hasOption(arguments_, '--config', runtime.configFile)) return 'management';

  const viewerEntry = path.join(projectRoot, 'node_modules/@youtyan/code-viewer/dist/code-viewer.js');
  if (arguments_.includes(viewerEntry)
    && runtime.viewerPorts.some(port => hasOption(arguments_, '--port', String(port)))) return 'viewer';

  let openVSCodeRealExecutable = runtime.openVSCodeExecutable;
  try {
    openVSCodeRealExecutable = await realpath(runtime.openVSCodeExecutable);
  } catch {
    // A missing executable will be reported when support services are started.
  }
  const openVSCodeRoot = path.dirname(path.dirname(openVSCodeRealExecutable));
  if (hasOption(arguments_, '--port', String(runtime.openVSCodePort))
    && arguments_.some(argument => (
      argument === runtime.openVSCodeExecutable
      || argument === openVSCodeRealExecutable
      || argument.startsWith(`${openVSCodeRoot}${path.sep}`)
    ))) return 'openvscode';

  if (arguments_.some(argument => path.basename(argument) === 'zellij')
    && arguments_.includes('web')
    && hasOption(arguments_, '--config', runtime.zellijConfigFile)) return 'zellij-web';
  return null;
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processExists(pid))) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !(await processExists(pid));
}

async function signalManagedProcess(runtime, pid, kind, signal) {
  if (!(await processExists(pid))) return;
  if (kind === 'viewer' || kind === 'openvscode') {
    const group = await processGroup(pid);
    const groupLeaderKind = group > 1 ? await processKind(group, runtime) : null;
    if (group > 1 && group !== process.pid && groupLeaderKind === kind) {
      process.kill(-group, signal);
      return;
    }
  }
  process.kill(pid, signal);
}

async function stopPid(runtime, pid, kind) {
  try {
    await signalManagedProcess(runtime, pid, kind, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (await waitForProcessExit(pid, 10_000)) return;
  try {
    await signalManagedProcess(runtime, pid, kind, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (!(await waitForProcessExit(pid, 5_000))) throw new Error(`${kind} process ${pid} did not stop`);
}

async function cleanupPort(runtime, port, expectedKinds) {
  const pids = [...new Set(await listenerPids(port))];
  for (const pid of pids) {
    const kind = await processKind(pid, runtime);
    if (!kind || !expectedKinds.includes(kind)) {
      throw new Error(`port ${port} is occupied by an unrelated process (PID ${pid})`);
    }
    await stopPid(runtime, pid, kind);
  }
  if ((await listenerPids(port)).length > 0) throw new Error(`port ${port} is still occupied after cleanup`);
}

async function stopZellijWeb(runtime) {
  let zellijExecutable;
  try {
    zellijExecutable = await resolveZellijExecutable(runtime);
  } catch {
    return;
  }
  try {
    await execFile(zellijExecutable, ['--config', runtime.zellijConfigFile, 'web', '--stop'], {
      shell: false,
      timeout: 15_000,
    });
  } catch {
    // The listener identity check below decides whether a remaining process is safe to terminate.
  }
}

async function cleanup(runtime) {
  await stopZellijWeb(runtime);
  await cleanupPort(runtime, runtime.managementPort, ['management']);
  for (const port of runtime.viewerPorts) await cleanupPort(runtime, port, ['viewer']);
  await cleanupPort(runtime, runtime.openVSCodePort, ['openvscode']);
  await cleanupPort(runtime, runtime.zellijWebPort, ['zellij-web']);
  await Promise.all([
    rm(openVSCodePidFile, { force: true }),
    rm(zellijWebPidFile, { force: true }),
  ]);
}

async function waitForPort(port, shouldBeOpen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
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

async function writePidFile(file, pid) {
  const temporaryFile = `${file}.tmp-${process.pid}`;
  const handle = await open(temporaryFile, 'wx', 0o600);
  try {
    await handle.writeFile(`${pid}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryFile, file);
  await chmod(file, 0o600);
}

async function startZellijWeb(runtime) {
  const zellijExecutable = await resolveZellijExecutable(runtime);
  await execFile(zellijExecutable, [
    '--config', runtime.zellijConfigFile,
    'web', '-d',
    '--ip', '127.0.0.1',
    '--port', String(runtime.zellijWebPort),
  ], {
    cwd: projectRoot,
    shell: false,
    timeout: 15_000,
  });
  await waitForPort(runtime.zellijWebPort, true, 15_000);
  const pids = await listenerPids(runtime.zellijWebPort);
  let pid;
  for (const candidate of pids) {
    if (await processKind(candidate, runtime) === 'zellij-web') {
      pid = candidate;
      break;
    }
  }
  pid ??= pids[0];
  if (pid) await writePidFile(zellijWebPidFile, pid);
}

async function startOpenVsCode(runtime) {
  if (!(await isExecutable(runtime.openVSCodeExecutable))) throw new Error('OpenVSCode executable is not available');
  const logFile = path.join(dataDirectory, 'openvscode.log');
  const logHandle = await open(logFile, 'a', 0o600);
  await logHandle.chmod(0o600);
  let child;
  try {
    child = spawn(runtime.openVSCodeExecutable, [
      '--host', '127.0.0.1',
      '--port', String(runtime.openVSCodePort),
      '--server-base-path', '/openvscode',
      '--without-connection-token',
      '--accept-server-license-terms',
      '--telemetry-level', 'off',
    ], {
      cwd: runtime.workspaceRoot,
      detached: true,
      shell: false,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (!child.pid) throw new Error('OpenVSCode did not provide a process ID');
    await writePidFile(openVSCodePidFile, child.pid);
    child.unref();
  } finally {
    await logHandle.close();
  }
  try {
    await waitForPort(runtime.openVSCodePort, true, 30_000);
  } catch (error) {
    if (child?.pid) await stopPid(runtime, child.pid, 'openvscode');
    await rm(openVSCodePidFile, { force: true });
    throw error;
  }
}

async function startSupport(runtime) {
  const ports = [runtime.managementPort, ...runtime.viewerPorts, runtime.openVSCodePort, runtime.zellijWebPort];
  for (const port of ports) await waitForPort(port, false, 1_000);
  await startZellijWeb(runtime);
  try {
    await startOpenVsCode(runtime);
  } catch (error) {
    await stopZellijWeb(runtime);
    await cleanupPort(runtime, runtime.zellijWebPort, ['zellij-web']);
    throw error;
  }
}

async function ensureManagedListener(runtime, port, kind, pidFile, start) {
  const pids = [...new Set(await listenerPids(port))];
  if (pids.length === 0) {
    await start(runtime);
    return;
  }
  let managedPid;
  for (const pid of pids) {
    const actualKind = await processKind(pid, runtime);
    if (actualKind !== kind) {
      throw new Error(`port ${port} is occupied by an unrelated process (PID ${pid})`);
    }
    managedPid ??= pid;
  }
  if (managedPid) await writePidFile(pidFile, managedPid);
}

async function ensureSupport(runtime) {
  await ensureManagedListener(runtime, runtime.zellijWebPort, 'zellij-web', zellijWebPidFile, startZellijWeb);
  try {
    await ensureManagedListener(runtime, runtime.openVSCodePort, 'openvscode', openVSCodePidFile, startOpenVsCode);
  } catch (error) {
    if ((await listenerPids(runtime.zellijWebPort)).length === 0) {
      await rm(zellijWebPidFile, { force: true });
    }
    throw error;
  }
}

async function main() {
  const [operation, configFile, workspaceRoot] = process.argv.slice(2);
  if (!['cleanup', 'start-support', 'ensure-support'].includes(operation) || !configFile || !workspaceRoot) {
    throw new Error('usage: service-runtime.mjs <cleanup|start-support|ensure-support> <config-file> <workspace-root>');
  }
  const runtime = await loadRuntime(configFile, workspaceRoot);
  if (operation === 'cleanup') await cleanup(runtime);
  else if (operation === 'start-support') await startSupport(runtime);
  else await ensureSupport(runtime);
}

main().catch(error => {
  process.stderr.write(`Service lifecycle failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
