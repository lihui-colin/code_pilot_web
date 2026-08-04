import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('stop-service.sh', () => {
  it('reports graceful shutdown progress and removes the PID file', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-stop-script-'));
    temporaryDirectories.push(projectRoot);
    const scriptsDirectory = path.join(projectRoot, 'scripts');
    const dataDirectory = path.join(projectRoot, 'data');
    const distDirectory = path.join(projectRoot, 'dist');
    await mkdir(scriptsDirectory);
    await mkdir(dataDirectory);
    await mkdir(distDirectory);

    const stopScript = path.join(scriptsDirectory, 'stop-service.sh');
    await copyFile(path.resolve('scripts/stop-service.sh'), stopScript);
    await chmod(stopScript, 0o755);
    const cleanupRecord = path.join(projectRoot, 'cleanup-record.json');
    const runtimeScript = path.join(scriptsDirectory, 'service-runtime.mjs');
    await writeFile(runtimeScript, `import { writeFileSync } from 'node:fs';
  writeFileSync(${JSON.stringify(cleanupRecord)}, JSON.stringify(process.argv.slice(2)));
  `);
    const configFile = path.join(projectRoot, 'config.json');
    const workspaceRoot = path.join(projectRoot, 'workspace');
    await mkdir(workspaceRoot);
    await writeFile(configFile, '{}\n');
    const runtimeFile = path.join(dataDirectory, 'service-runtime.json');
    await writeFile(runtimeFile, `${JSON.stringify({ configFile, workspaceRoot }, null, 2)}\n`, { mode: 0o600 });

    const readyFile = path.join(projectRoot, 'service.ready');
    const serverFile = path.join(distDirectory, 'server.js');
    const service = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[1], 'ready');
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1_200));
setInterval(() => {}, 1_000);`,
      readyFile,
      serverFile,
    ], { stdio: 'ignore' });
    childProcesses.push(service);
    await waitForFile(readyFile);

    const pidFile = path.join(dataDirectory, 'terminal-web.pid');
    await writeFile(pidFile, `${service.pid}\n`);
    const { stdout } = await execFileAsync(stopScript, { encoding: 'utf8' });

    expect(stdout).toContain(`Sending SIGTERM to Terminal Web (PID ${service.pid})`);
    expect(stdout).toContain('Waiting for graceful shutdown:   0% (0.0s/10.0s)');
    expect(stdout).toContain('Waiting for graceful shutdown:  10% (1.0s/10.0s)');
    expect(stdout).toMatch(/Graceful shutdown completed after \d+\.\ds/u);
    expect(stdout).toContain('Stopping Zellij Web, code-viewer, OpenVSCode, and remaining managed services');
    expect(stdout).toContain('Terminal Web support services stopped');
    expect(stdout).toContain('Terminal Web stopped');
    await expect(readFile(pidFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(runtimeFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(cleanupRecord, 'utf8'))).toEqual(['cleanup', configFile, workspaceRoot]);
  });

  it('cleans support services when the management PID file is missing', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-stop-orphaned-'));
    temporaryDirectories.push(projectRoot);
    const scriptsDirectory = path.join(projectRoot, 'scripts');
    const dataDirectory = path.join(projectRoot, 'data');
    await mkdir(scriptsDirectory);
    await mkdir(dataDirectory);
    const stopScript = path.join(scriptsDirectory, 'stop-service.sh');
    await copyFile(path.resolve('scripts/stop-service.sh'), stopScript);
    await chmod(stopScript, 0o755);
    const cleanupRecord = path.join(projectRoot, 'cleanup-record.json');
    await writeFile(path.join(scriptsDirectory, 'service-runtime.mjs'), `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(cleanupRecord)}, JSON.stringify(process.argv.slice(2)));
`);
    const configFile = path.join(projectRoot, 'config.json');
    const workspaceRoot = path.join(projectRoot, 'workspace');
    await mkdir(workspaceRoot);
    await writeFile(configFile, '{}\n');
    await writeFile(path.join(dataDirectory, 'service-runtime.json'), `${JSON.stringify({ configFile, workspaceRoot })}\n`);

    const { stdout } = await execFileAsync(stopScript, { encoding: 'utf8' });

    expect(stdout).toContain('Terminal Web is not running (PID file not found)');
    expect(stdout).toContain('Terminal Web support services stopped');
    expect(JSON.parse(await readFile(cleanupRecord, 'utf8'))).toEqual(['cleanup', configFile, workspaceRoot]);
  });
});
