import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ReadinessResult } from '../src/domain/types.js';
import { createTestConfig } from './helpers.js';

const ready: ReadinessResult = {
  status: 'ready',
  checks: { workspaceRoot: true, state: true, directoryIdSecret: true, node: true, zellij: true, codeViewer: true },
};

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

async function openWebSocket(port: number, pathname: string, cookie: string): Promise<Duplex> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write([
    `GET ${pathname} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    `Cookie: ${cookie}`,
    '',
    '',
  ].join('\r\n'));
  await new Promise<void>((resolve, reject) => {
    socket.once('data', chunk => {
      if (chunk.toString('utf8').startsWith('HTTP/1.1 101')) resolve();
      else reject(new Error('WebSocket proxy connection failed'));
    });
    socket.once('error', reject);
  });
  return socket;
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
        if (request.headers.cookie !== 'zellij-auth=test-session') {
          response.writeHead(401, { 'content-type': 'text/plain' });
          response.end('missing session cookie');
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><head><base href="/" /></head><body><textarea class="xterm-helper-textarea"></textarea>Zellij</body></html>');
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

    let client: Duplex | undefined;
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
      expect(openSession.headers.get('set-cookie')).toBe(
        'codepilot_zellij_8024_zellij-auth=test-session; Path=/zellij; HttpOnly; SameSite=Strict',
      );
      expect(JSON.parse(loginBody)).toEqual({
        auth_token: '123e4567-e89b-42d3-a456-426614174000',
        remember_me: false,
      });

      const html = await fetch(`http://127.0.0.1:${appPort}/zellij/session-name`, {
        headers: { cookie: 'codepilot_zellij_8024_zellij-auth=test-session; codepilot_zellij_9024_zellij-auth=other-session' },
      });
      const htmlBody = await html.text();
      expect(htmlBody).toContain('<base href="/zellij/" />');
      expect(htmlBody).toContain('id="codepilot-zellij-shortcuts"');
      expect(htmlBody).toContain('data-expanded="false"');
      expect(htmlBody).toContain('data-sequence="16,110" data-hint="Ctrl+P N"');
      expect(htmlBody).toContain('data-sequence="16,120" data-hint="Ctrl+P X"');
      expect(htmlBody).not.toContain('Ctrl+O D');
      expect(htmlBody).not.toContain('Ctrl+C');
      expect(htmlBody.match(/data-sequence=/gu)).toHaveLength(2);
      expect(htmlBody).not.toContain('#terminal { height: calc');
      expect(htmlBody).toContain('border-radius: 50%');
      expect(htmlBody).toContain('translate(-3.6rem, -1.4rem)');
      expect(htmlBody).toContain('translate(-1.4rem, -3.6rem)');
      expect(htmlBody).not.toContain('@media');
      expect(htmlBody).toContain('<script src="/codepilot-zellij-shortcuts.js"></script>');
      const shortcutScriptResponse = await fetch(`http://127.0.0.1:${appPort}/codepilot-zellij-shortcuts.js`);
      const shortcutScript = await shortcutScriptResponse.text();
      expect(shortcutScriptResponse.headers.get('content-type')).toContain('application/javascript');
      expect(shortcutScript).toContain('window.__zjImeBypass.sendFn');
      const dom = new JSDOM(htmlBody, { runScripts: 'outside-only' });
      const sentSequences: string[] = [];
      Object.assign(dom.window, { __zjImeBypass: { sendFn: (sequence: string) => sentSequences.push(sequence) } });
      dom.window.eval(shortcutScript);
      const terminalInput = dom.window.document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
      const toggle = dom.window.document.querySelector<HTMLButtonElement>('.codepilot-shortcut-toggle');
      toggle?.click();
      expect(dom.window.document.querySelector('#codepilot-zellij-shortcuts')?.getAttribute('data-expanded')).toBe('true');
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      const shortcut = dom.window.document.querySelector<HTMLButtonElement>('[data-sequence="16,110"]');
      shortcut?.click();
      expect(dom.window.document.activeElement).toBe(terminalInput);
      expect(sentSequences).toEqual(['\x10', 'n']);
      expect(dom.window.document.querySelector('#codepilot-zellij-shortcuts')?.getAttribute('data-expanded')).toBe('false');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.getAttribute('aria-label')).toBe('展开快捷键盘');
      dom.window.close();
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

      client = await openWebSocket(
        appPort,
        `/zellij/ws/terminal/${sessionName}`,
        'codepilot_zellij_8024_zellij-auth=test-session; codepilot_zellij_9024_zellij-auth=other-session',
      );
      await upgradeSeen;
      expect(upgradeRequest?.url).toBe(`/ws/terminal/${sessionName}`);
      expect(upgradeRequest?.headers.cookie).toBe('zellij-auth=test-session');
    } finally {
      client?.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      upstreamSockets.clear();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
