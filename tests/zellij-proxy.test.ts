import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ReadinessResult } from '../src/domain/types.js';
import { createTestConfig } from './helpers.js';

const ready: ReadinessResult = {
  status: 'ready',
  checks: { workspaceRoot: true, directoryIdSecret: true, node: true, zellij: true, codeViewer: true },
};

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

describe('Zellij Web same-origin proxy', () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const upstreamSockets = new Set<Duplex>();

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const socket of upstreamSockets) socket.destroy();
    upstreamSockets.clear();
  });

  it('rewrites the HTML base and proxies HTTP and WebSocket paths', async () => {
    let httpRequest: IncomingMessage | undefined;
    let upgradeRequest: IncomingMessage | undefined;
    let resolveUpgrade: (() => void) | undefined;
    const upgradeSeen = new Promise<void>(resolve => { resolveUpgrade = resolve; });
    const upstream = createServer((request, response) => {
      httpRequest = request;
      if (request.url === '/session-name') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><head><base href="/" /></head><body>Zellij</body></html>');
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

    const config = createTestConfig('/workspace');
    const upstreamPort = (upstream.address() as AddressInfo).port;
    config.zellijWebPort = upstreamPort;
    const sessionName = 'managed-session';
    app = await createApp(config, {
      readiness: ready,
      directoryIdSecret: null,
      zellijWebUpstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      zellijAdapter: { listSessions: async () => `${sessionName}\n` },
      staticRoot: false,
      https: false,
      logger: false,
    });

    let client: WebSocket | undefined;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const appPort = (app.server.address() as AddressInfo).port;
      const sessions = await fetch(`http://127.0.0.1:${appPort}/api/sessions`);
      expect((await sessions.json()).sessions[0].webUrl).toBe(`https://192.0.2.10:8024/zellij/${sessionName}`);

      const html = await fetch(`http://127.0.0.1:${appPort}/zellij/session-name`);
      expect(await html.text()).toContain('<base href="/zellij/" />');
      expect(httpRequest?.url).toBe('/session-name');

      const login = await fetch(`http://127.0.0.1:${appPort}/zellij/command/login`, { method: 'POST' });
      expect(await login.json()).toEqual({ path: '/command/login' });

      client = new WebSocket(`ws://127.0.0.1:${appPort}/zellij/ws/terminal/${sessionName}`);
      await new Promise<void>((resolve, reject) => {
        client?.addEventListener('open', () => resolve(), { once: true });
        client?.addEventListener('error', () => reject(new Error('WebSocket proxy connection failed')), { once: true });
      });
      await upgradeSeen;
      expect(upgradeRequest?.url).toBe(`/ws/terminal/${sessionName}`);
    } finally {
      client?.close();
      for (const socket of upstreamSockets) socket.destroy();
      upstreamSockets.clear();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
