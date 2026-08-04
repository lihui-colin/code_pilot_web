#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(process.argv[2] ?? process.cwd());
const zellijWebProbeBaseUrl = process.env.ZELLIJ_WEB_BASE_URL;
const results = [];

function withoutZellijEnvironment(environment) {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    if (name === 'ZELLIJ' || name.startsWith('ZELLIJ_')) delete sanitized[name];
  }
  return sanitized;
}

function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`${status.toUpperCase()}: ${name}${detail ? ` - ${detail}` : ''}`);
}

async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw lastError ?? new Error(`Timed out after ${timeoutMs}ms`);
}

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 15_000,
    maxBuffer: 1024 * 1024,
    shell: false,
    ...options,
  });
}

async function listSessions() {
  const { stdout } = await run('zellij', ['list-sessions', '--short'], {
    timeout: 5_000,
    env: withoutZellijEnvironment(process.env),
  });
  return stdout.split(/\r?\n/u).filter(Boolean);
}

async function probeZellij() {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-mvp0-zellij-'));
  const sessionName = `terminal_web_mvp0_${process.pid}`;
  const markerPath = path.join(tempDirectory, 'codex-started.json');
  const wrapperPath = path.join(tempDirectory, 'codex');
  const layoutPath = path.join(tempDirectory, 'codex.kdl');
  const originalSessions = await listSessions().catch(() => []);

  try {
    await writeFile(wrapperPath, `#!/usr/bin/env sh\nprintf '%s' "$PWD" > ${JSON.stringify(markerPath)}\nexec sleep "$1"\n`);
    await chmod(wrapperPath, 0o700);
    await writeFile(layoutPath, 'layout {\n    pane command="codex" {\n        args "300"\n    }\n}\n', { mode: 0o600 });

    await run('zellij', [
      '--layout',
      layoutPath,
      'attach',
      '--create-background',
      sessionName,
      'options',
      '--default-cwd',
      workspaceRoot,
    ], {
      env: withoutZellijEnvironment({
        ...process.env,
        PATH: `${tempDirectory}:${process.env.PATH ?? ''}`,
      }),
    });

    await waitFor(async () => (await listSessions()).includes(sessionName), 5_000);
    record('Zellij creates a background Session from a temporary KDL layout', 'pass', sessionName);

    const startedCwd = await waitFor(async () => {
      try {
        return readFile(markerPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    }, 5_000);
    assert.equal(startedCwd, workspaceRoot);
    record('The allowed codex command starts in the requested directory', 'pass', startedCwd);

    await probeZellijWebUrl(sessionName);

    await run('zellij', ['delete-session', '--force', sessionName]).catch(() => undefined);
    await waitFor(async () => !(await listSessions()).includes(sessionName), 5_000);
    const remainingSessions = await listSessions().catch(() => []);
    for (const existingSession of originalSessions) {
      assert.ok(remainingSessions.includes(existingSession), `Existing Session disappeared: ${existingSession}`);
    }
    record('Zellij deletes only the target Session', 'pass');
  } finally {
    await run('zellij', ['delete-session', '--force', sessionName]).catch(() => undefined);
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = url instanceof URL ? url : new URL(url);
    const transport = requestUrl.protocol === 'https:' ? https : http;
    const outgoingRequest = transport.request(requestUrl, {
      method: options.method ?? 'GET',
      headers: options.headers,
      rejectUnauthorized: options.rejectUnauthorized ?? true,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    outgoingRequest.once('error', reject);
    outgoingRequest.end(options.body);
  });
}

function firstResponseChunk(url, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const requestUrl = url instanceof URL ? url : new URL(url);
    const transport = requestUrl.protocol === 'https:' ? https : http;
    const outgoingRequest = transport.get(requestUrl, response => {
      response.once('data', chunk => {
        outgoingRequest.destroy();
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: chunk,
        });
      });
    });
    outgoingRequest.setTimeout(timeoutMs, () => outgoingRequest.destroy(new Error(`Timed out after ${timeoutMs}ms`)));
    outgoingRequest.once('error', reject);
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function rewriteLocation(location, upstreamBaseUrl, viewerPrefix) {
  const resolved = new URL(location, `${upstreamBaseUrl}/`);
  if (resolved.origin !== new URL(upstreamBaseUrl).origin) return location;
  return `${viewerPrefix}${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function rewriteCookiePath(cookie, viewerPrefix) {
  if (/;\s*Path=/iu.test(cookie)) {
    return cookie.replace(/;\s*Path=[^;]*/iu, `; Path=${viewerPrefix}/`);
  }
  return `${cookie}; Path=${viewerPrefix}/`;
}

async function startPrefixProxy(upstreamBaseUrl) {
  const upstream = new URL(upstreamBaseUrl);
  const viewerPrefix = '/viewer/viewer_mvp0';
  const server = http.createServer((incomingRequest, outgoingResponse) => {
    if (!incomingRequest.url?.startsWith(`${viewerPrefix}/`)) {
      outgoingResponse.writeHead(404).end();
      return;
    }

    const upstreamPath = incomingRequest.url.slice(viewerPrefix.length) || '/';
    const headers = { ...incomingRequest.headers, host: upstream.host };
    if (headers.origin) headers.origin = upstream.origin;
    const upstreamRequest = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: upstreamPath,
      method: incomingRequest.method,
      headers,
    }, upstreamResponse => {
      const responseHeaders = { ...upstreamResponse.headers };
      if (responseHeaders.location) {
        responseHeaders.location = rewriteLocation(responseHeaders.location, upstreamBaseUrl, viewerPrefix);
      }
      if (responseHeaders['set-cookie']) {
        responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(cookie => rewriteCookiePath(cookie, viewerPrefix));
      }
      outgoingResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(outgoingResponse);
    });
    upstreamRequest.once('error', () => outgoingResponse.destroy());
    incomingRequest.pipe(upstreamRequest);
  });

  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    viewerPrefix,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function probeCodeViewer() {
  const port = await getFreePort();
  const expectedUrl = `http://127.0.0.1:${port}`;
  const child = spawn('code-viewer', ['--cwd', workspaceRoot, '--port', String(port)], {
    cwd: workspaceRoot,
    env: process.env,
    detached: false,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-65_536); });
  child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-65_536); });

  let proxy;
  try {
    const listenUrl = await waitFor(() => {
      const match = output.match(/^GDP_LISTEN_URL=(.+)$/mu);
      if (match) return match[1].trim().replace(/\/$/u, '');
      if (child.exitCode !== null) throw new Error(`code-viewer exited with ${child.exitCode}`);
      return false;
    }, 15_000);
    assert.equal(listenUrl, expectedUrl);
    record('code-viewer reports the explicitly allocated localhost port', 'pass', listenUrl);

    const rootResponse = await waitFor(async () => {
      const response = await request(expectedUrl);
      return response.statusCode >= 200 && response.statusCode <= 399 ? response : false;
    }, 15_000, 200);
    record('code-viewer root path is a usable health check', 'pass', `HTTP ${rootResponse.statusCode}`);

    const html = rootResponse.body.toString('utf8');
    const assetPaths = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gu)]
      .map(match => match[1])
      .filter(value => !value.startsWith('data:') && !value.startsWith('http'));
    const rootRelativeAssets = assetPaths.filter(value => value.startsWith('/'));
    proxy = await startPrefixProxy(expectedUrl);

    const prefixedRoot = await request(`${proxy.baseUrl}${proxy.viewerPrefix}/`);
    assert.ok(prefixedRoot.statusCode >= 200 && prefixedRoot.statusCode <= 399);
    for (const assetPath of rootRelativeAssets.slice(0, 10)) {
      const assetResponse = await request(`${proxy.baseUrl}${proxy.viewerPrefix}${assetPath}`);
      assert.ok(assetResponse.statusCode >= 200 && assetResponse.statusCode <= 399, `${assetPath} returned ${assetResponse.statusCode}`);
    }
    record('Static resources can be transported through a prefix-stripping proxy', 'pass', `${Math.min(rootRelativeAssets.length, 10)} paths checked`);

    if (rootRelativeAssets.length === 0) {
      record('code-viewer HTML keeps browser navigation inside the viewer prefix', 'pass');
    } else {
      const escapedResponse = await request(new URL(rootRelativeAssets[0], proxy.baseUrl));
      assert.equal(escapedResponse.statusCode, 404);
      record(
        'code-viewer HTML keeps browser navigation inside the viewer prefix',
        'fail',
        `${rootRelativeAssets.length} root-relative URLs escape ${proxy.viewerPrefix}`,
      );
    }

    const appResponse = await request(`${proxy.baseUrl}${proxy.viewerPrefix}/app.js`);
    assert.ok(appResponse.statusCode >= 200 && appResponse.statusCode <= 399);
    const appSource = appResponse.body.toString('utf8');
    const eventStreamResponse = await firstResponseChunk(`${proxy.baseUrl}${proxy.viewerPrefix}/events`);
    assert.equal(eventStreamResponse.statusCode, 200);
    assert.match(String(eventStreamResponse.headers['content-type']), /^text\/event-stream/iu);
    record('code-viewer event streaming works through the viewer prefix', 'pass', 'Server-Sent Events /events');

    if (/new\s+WebSocket\s*\(/u.test(appSource)) {
      record('code-viewer advertises a WebSocket endpoint that can be upgrade-probed', 'pass');
    } else {
      assert.match(appSource, /new\s+EventSource\s*\(\s*["']\/events["']\s*\)/u);
      record(
        'code-viewer advertises a WebSocket endpoint that can be upgrade-probed',
        'fail',
        '0.10.0 uses Server-Sent Events and exposes no WebSocket endpoint',
      );
    }

    assert.equal(rewriteLocation('/history?ref=HEAD', expectedUrl, proxy.viewerPrefix), `${proxy.viewerPrefix}/history?ref=HEAD`);
    assert.equal(rewriteCookiePath('session=test; Path=/; HttpOnly', proxy.viewerPrefix), `session=test; Path=${proxy.viewerPrefix}/; HttpOnly`);
    record('Location and Cookie Path rewriting stays inside the viewer prefix', 'pass');
  } finally {
    if (proxy) await proxy.close();
    await stopProcess(child);
  }
}

async function probeZellijWebUrl(sessionName) {
  if (!zellijWebProbeBaseUrl) {
    record('Zellij Web Session URL routes to the encoded Session path', 'skip', 'set ZELLIJ_WEB_BASE_URL to probe the running service');
    return;
  }

  const sessionUrl = new URL(encodeURIComponent(sessionName), `${zellijWebProbeBaseUrl.replace(/\/$/u, '')}/`);
  const response = await request(sessionUrl, {
    rejectUnauthorized: process.env.ZELLIJ_WEB_INSECURE !== '1',
  });
  assert.ok(response.statusCode >= 200 && response.statusCode <= 399, `Unexpected HTTP ${response.statusCode}`);
  record('Zellij Web Session URL routes to the encoded Session path', 'pass', `${sessionUrl.pathname} -> HTTP ${response.statusCode}`);
}

async function probeVersions() {
  const nodeVersion = process.versions.node;
  if (nodeVersion.startsWith('26.')) record('Node.js version matches the 26.x baseline', 'pass', nodeVersion);
  else record('Node.js version matches the 26.x baseline', 'fail', nodeVersion);

  const { stdout: zellijVersion } = await run('zellij', ['--version'], {
    env: withoutZellijEnvironment(process.env),
  });
  assert.equal(zellijVersion.trim(), 'zellij 0.44.3');
  record('Zellij version matches the 0.44.3 baseline', 'pass', zellijVersion.trim());

  const { stdout: codeViewerVersion } = await run('code-viewer', ['--version']);
  assert.equal(codeViewerVersion.trim(), '0.10.0');
  record('code-viewer version matches the 0.10.0 baseline', 'pass', codeViewerVersion.trim());
}

async function captureProbe(name, probe) {
  try {
    await probe();
  } catch (error) {
    record(name, 'fail', error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  await captureProbe('External tool version probe', probeVersions);
  await captureProbe('Zellij integration probe', probeZellij);
  await captureProbe('code-viewer integration probe', probeCodeViewer);

  const failures = results.filter(result => result.status === 'fail');
  const skipped = results.filter(result => result.status === 'skip');
  console.log(`\nMVP-0 probe summary: ${results.length - failures.length - skipped.length} passed, ${skipped.length} skipped, ${failures.length} failed.`);
  if (failures.length || skipped.length) process.exitCode = 1;
}

main().catch(error => {
  record('MVP-0 probe execution', 'fail', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
