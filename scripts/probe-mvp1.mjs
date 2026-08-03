#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function request(url) {
  return new Promise((resolve, reject) => {
    const outgoing = http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.once('error', reject);
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request(url);
      if (response.statusCode > 0) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('server startup timed out');
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function revokeProbeToken(configFile) {
  let name;
  try {
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    name = config.zellij?.webToken?.name;
  } catch {
    return;
  }
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(name)) return;
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key === 'ZELLIJ' || key.startsWith('ZELLIJ_')) delete environment[key];
  }
  await new Promise(resolve => {
    const cleanup = spawn('zellij', ['web', '--revoke-token', name], {
      cwd: projectRoot,
      env: environment,
      shell: false,
      stdio: 'ignore',
    });
    cleanup.once('error', resolve);
    cleanup.once('exit', resolve);
  });
}

async function main() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-mvp1-'));
  const workspace = path.join(fixtureRoot, 'workspace');
  const configFile = path.join(fixtureRoot, 'config.json');
  const port = await freePort();
  let child;

  try {
    await mkdir(path.join(workspace, 'repository'), { recursive: true });
    await mkdir(path.join(workspace, 'repository', '.git'));
    await writeFile(path.join(workspace, 'repository', 'package.json'), '{}');
    await writeFile(path.join(fixtureRoot, 'directory.secret'), 'mvp1-probe-directory-secret-32bytes', { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({
      listenHost: '0.0.0.0',
      listenPort: port,
      publicBaseUrl: `http://127.0.0.1:${port}`,
      zellijWebBaseUrl: 'https://127.0.0.1:8021',
      zellij: {
        managedBinaryFile: 'bin/zellij',
        webCertificateFile: 'certs/cert.pem',
        webPrivateKeyFile: 'certs/key.pem',
      },
      directoryIdSecretFile: 'directory.secret',
      viewerPortRange: { start: 18_000, end: 18_100 },
      viewerIdleTimeoutMinutes: 60,
      viewerMaxInstances: 10,
      projectMarkers: ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml'],
      allowedSessionCommands: ['codex'],
    }, null, 2));

    child = spawn(process.execPath, [
      path.join(projectRoot, 'dist/server.js'),
      '--config', configFile,
      '--workspace-root', workspace,
    ], {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-65_536); });
    child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-65_536); });
    child.once('exit', code => {
      if (code && code !== 0) process.stderr.write(output);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForServer(`${baseUrl}/api/health`);
    assert.equal(health.statusCode, 200);
    const page = await request(`${baseUrl}/`);
    assert.equal(page.statusCode, 200, page.body);
    assert.match(page.body, /<title>Terminal Web<\/title>/u);
    const ready = await request(`${baseUrl}/api/ready`);
    assert.equal(ready.statusCode, 200, ready.body);
    const repositories = await request(`${baseUrl}/api/repositories`);
    assert.equal(repositories.statusCode, 200, repositories.body);
    assert.equal(JSON.parse(repositories.body).entries[0].name, 'repository');
    process.stdout.write(`PASS: HTTP management service listened on 0.0.0.0:${port} and was reachable by IP\n`);
    process.stdout.write('PASS: page and API were accessible without user credentials\n');
    process.stdout.write('PASS: readiness and repository browsing worked through the HTTP endpoint\n');
  } finally {
    if (child) await stop(child);
    await revokeProbeToken(configFile);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
