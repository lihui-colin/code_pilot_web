import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ReadinessResult } from '../src/domain/types.js';
import { OpenVSCodeService } from '../src/services/openvscode-service.js';
import { createTestConfig } from './helpers.js';

const temporaryDirectories: string[] = [];
const ready: ReadinessResult = {
  status: 'ready',
  checks: { workspaceRoot: true, state: true, directoryIdSecret: true, node: true, zellij: true, codeViewer: true },
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

describe('OpenVSCode same-origin proxy', () => {
  it('starts the OpenVSCode upstream lazily on the first request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-openvscode-lazy-'));
    temporaryDirectories.push(root);

    // A tiny stand-in executable that binds the configured port and echoes the
    // request path back, so the lazy-start path can be exercised without a
    // real OpenVSCode installation.
    const stubExecutable = path.join(root, 'fake-openvscode.mjs');
    await writeFile(stubExecutable, [
      '#!/usr/bin/env node',
      "import { createServer } from 'node:http';",
      "const portIndex = process.argv.indexOf('--port');",
      'const port = Number(process.argv[portIndex + 1]);',
      'createServer((request, response) => {',
      "  response.writeHead(200, { 'content-type': 'application/json' });",
      '  response.end(JSON.stringify({ started: true, path: request.url }));',
      "}).listen(port, '127.0.0.1');",
      '',
    ].join('\n'));
    await chmod(stubExecutable, 0o755);

    const freePort = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });

    const config = createTestConfig(root);
    config.openVSCodePort = freePort;
    config.openVSCodeExecutableFile = stubExecutable;
    const openVSCodeService = new OpenVSCodeService({
      executablePath: stubExecutable,
      port: freePort,
      workspaceRoot: root,
      pidFile: path.join(root, 'openvscode.pid'),
      logFile: path.join(root, 'openvscode.log'),
    });
    const app = await createApp(config, {
      readiness: ready,
      directoryIdSecret: null,
      staticRoot: false,
      https: false,
      logger: false,
      openVSCodeService,
    });

    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const appPort = (app.server.address() as AddressInfo).port;
      const first = await fetch(`http://127.0.0.1:${appPort}/openvscode/probe?value=1`);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ started: true, path: '/openvscode/probe?value=1' });
      const pid = Number((await readFile(path.join(root, 'openvscode.pid'), 'utf8')).trim());
      expect(Number.isInteger(pid) && pid > 1).toBe(true);
      const second = await fetch(`http://127.0.0.1:${appPort}/openvscode/probe?value=2`);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ started: true, path: '/openvscode/probe?value=2' });
    } finally {
      await app.close();
      await expect(readFile(path.join(root, 'openvscode.pid'), 'utf8')).rejects.toThrow();
    }
  });

  it('preserves the base path and proxies HTTP and WebSocket traffic', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-openvscode-proxy-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });

    let httpRequest: IncomingMessage | undefined;
    let upgradeRequest: IncomingMessage | undefined;
    let resolveUpgrade: (() => void) | undefined;
    const upgradeSeen = new Promise<void>(resolve => { resolveUpgrade = resolve; });
    const upstreamSockets = new Set<Duplex>();
    const upstream = createServer((request, response) => {
      httpRequest = request;
      if (request.url?.startsWith('/openvscode/?folder=')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><head><title>OpenVSCode Server</title></head><body>editor</body></html>');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: request.url }));
    });
    upstream.on('upgrade', (request, socket) => {
      upgradeRequest = request;
      upstreamSockets.add(socket);
      socket.once('close', () => upstreamSockets.delete(socket));
      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string') {
        socket.destroy();
        return;
      }
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
        '',
        '',
      ].join('\r\n'));
      resolveUpgrade?.();
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });

    const config = createTestConfig(root);
    config.openVSCodePort = (upstream.address() as AddressInfo).port;
    const app = await createApp(config, {
      readiness: ready,
      directoryIdSecret: null,
      staticRoot: false,
      https: false,
      logger: false,
    });

    let client: WebSocket | undefined;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const appPort = (app.server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${appPort}/openvscode/probe?value=1`);
      expect(await response.json()).toEqual({ path: '/openvscode/probe?value=1' });
      expect(httpRequest?.headers.host).toBe('192.0.2.10:8024');
      expect(httpRequest?.headers['x-forwarded-host']).toBe('192.0.2.10:8024');
      expect(httpRequest?.headers['x-forwarded-proto']).toBe('https');

      const editor = await fetch(`http://127.0.0.1:${appPort}/openvscode/?folder=${encodeURIComponent('/workspace/codepilot-web')}`);
      const editorHtml = await editor.text();
      expect(editorHtml).toContain('<title>codepilot-web - openvscode</title>');
      expect(editorHtml).toContain('<script src="/codepilot-html-title.js"></script>');
      expect(editorHtml).not.toContain('<script>(()=>');

      client = new WebSocket(`ws://127.0.0.1:${appPort}/openvscode/socket?value=2`);
      await new Promise<void>((resolve, reject) => {
        client?.addEventListener('open', () => resolve(), { once: true });
        client?.addEventListener('error', () => reject(new Error('WebSocket proxy connection failed')), { once: true });
      });
      await upgradeSeen;
      expect(upgradeRequest?.url).toBe('/openvscode/socket?value=2');
      expect(upgradeRequest?.headers.host).toBe('192.0.2.10:8024');
      expect(upgradeRequest?.headers.origin).toBe('https://192.0.2.10:8024');
    } finally {
      client?.close();
      await app.close();
      for (const socket of upstreamSockets) socket.destroy();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
