import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ReadinessResult } from '../src/domain/types.js';
import { createTestConfig } from './helpers.js';

const temporaryDirectories: string[] = [];
const ready: ReadinessResult = {
  status: 'ready',
  checks: { workspaceRoot: true, directoryIdSecret: true, node: true, zellij: true, codeViewer: true },
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

describe('OpenVSCode same-origin proxy', () => {
  it('preserves the base path and proxies HTTP and WebSocket traffic', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-openvscode-proxy-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });

    let httpRequest: IncomingMessage | undefined;
    let upgradeRequest: IncomingMessage | undefined;
    let resolveUpgrade: (() => void) | undefined;
    const upgradeSeen = new Promise<void>(resolve => { resolveUpgrade = resolve; });
    const upstreamSockets = new Set<Duplex>();
    const upstream = createServer((request, response) => {
      httpRequest = request;
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
    config.openVsCodePort = (upstream.address() as AddressInfo).port;
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
