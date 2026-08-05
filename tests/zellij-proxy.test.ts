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
    let loginBody = '';
    let resolveUpgrade: (() => void) | undefined;
    let xtermAssetRequests = 0;
    const xtermAsset = `export const payload = "${'x'.repeat(4096)}";`;
    const upgradeSeen = new Promise<void>(resolve => { resolveUpgrade = resolve; });
    const upstream = createServer((request, response) => {
      httpRequest = request;
      if (request.url === '/command/login' && request.method === 'POST') {
        let requestBody = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { requestBody += chunk; });
        request.on('end', () => {
          if (requestBody) {
            loginBody = requestBody;
            response.writeHead(200, { 'set-cookie': 'zellij-auth=test-session; Path=/; HttpOnly; SameSite=Strict' });
            response.end('{}');
          } else {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ path: request.url }));
          }
        });
        return;
      }
      if (request.url === '/session-name') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><head><base href="/" /></head><body>Zellij</body></html>');
        return;
      }
      if (request.url === '/assets/xterm.js') {
        xtermAssetRequests += 1;
        response.writeHead(200, { 'content-type': 'application/javascript' });
        response.end(xtermAsset);
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
      expect((await sessions.json()).sessions[0].webUrl).toBe(`https://192.0.2.10:8024/zellij/open/${sessionName}`);

      const openSession = await fetch(`http://127.0.0.1:${appPort}/zellij/open/${sessionName}`, {
        redirect: 'manual',
      });
      expect(openSession.status).toBe(302);
      expect(openSession.headers.get('location')).toBe(`/zellij/${sessionName}`);
      expect(openSession.headers.get('set-cookie')).toBe('zellij-auth=test-session; Path=/; HttpOnly; SameSite=Strict');
      expect(JSON.parse(loginBody)).toEqual({
        auth_token: '123e4567-e89b-42d3-a456-426614174000',
        remember_me: false,
      });

      const html = await fetch(`http://127.0.0.1:${appPort}/zellij/session-name`);
      expect(await html.text()).toContain('<base href="/zellij/" />');
      expect(httpRequest?.url).toBe('/session-name');

      const login = await fetch(`http://127.0.0.1:${appPort}/zellij/command/login`, { method: 'POST' });
      expect(await login.json()).toEqual({ path: '/command/login' });

      const asset = await fetch(`http://127.0.0.1:${appPort}/zellij/assets/xterm.js`, {
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(asset.headers.get('cache-control')).toBe('private, max-age=86400, immutable');
      expect(asset.headers.get('content-encoding')).toBe('gzip');
      const etag = asset.headers.get('etag');
      expect(etag).toBe('W/"zellij-0.44.3-xterm.js"');
      expect(await asset.text()).toBe(xtermAsset);

      const revalidatedAsset = await fetch(`http://127.0.0.1:${appPort}/zellij/assets/xterm.js`, {
        headers: { 'if-none-match': etag ?? '' },
      });
      expect(revalidatedAsset.status).toBe(304);
      expect(revalidatedAsset.headers.get('cache-control')).toBe('private, max-age=86400, immutable');
      expect(xtermAssetRequests).toBe(1);

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
