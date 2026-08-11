import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
            response.writeHead(200, { 'set-cookie': 'zellij-auth=test-session; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=2419200' });
            response.end('{}');
          } else {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ path: request.url }));
          }
        });
        return;
      }
      if (request.url === '/session-name' || request.url === '/managed-session') {
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
      managedSessions: new Map([[sessionName, {
        repositoryId: `dir_${'a'.repeat(43)}`,
        relativePath: 'projects/codepilot-web',
        createdAt: '2026-08-07T00:00:00.000Z',
        command: 'codex',
      }]]),
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
        'codepilot_zellij_8024_zellij-auth=test-session; Path=/zellij; HttpOnly; SameSite=Strict; Secure; Max-Age=2419200',
      );
      expect(JSON.parse(loginBody)).toEqual({
        auth_token: '123e4567-e89b-42d3-a456-426614174000',
        remember_me: true,
      });

      const refreshWithoutCookie = await fetch(`http://127.0.0.1:${appPort}/zellij/${sessionName}`, { redirect: 'manual' });
      expect(refreshWithoutCookie.status).toBe(302);
      expect(refreshWithoutCookie.headers.get('location')).toBe(`/zellij/open/${sessionName}`);

      const html = await fetch(`http://127.0.0.1:${appPort}/zellij/session-name`, {
        headers: { cookie: 'codepilot_zellij_8024_zellij-auth=test-session; codepilot_zellij_9024_zellij-auth=other-session' },
      });
      const htmlBody = await html.text();
      expect(htmlBody).toContain('<base href="/zellij/" />');
      expect(htmlBody).toContain('<title>session-name - Zellij</title>');
      expect(htmlBody).toContain('<script src="/codepilot-html-title.js"></script>');
      expect(htmlBody).not.toContain('<script>(()=>');
      const titleScriptResponse = await fetch(`http://127.0.0.1:${appPort}/codepilot-html-title.js`);
      expect(titleScriptResponse.headers.get('content-type')).toContain('application/javascript');
      expect(await titleScriptResponse.text()).toContain('MutationObserver');

      const managedHtml = await fetch(`http://127.0.0.1:${appPort}/zellij/${sessionName}`, {
        headers: { cookie: 'codepilot_zellij_8024_zellij-auth=test-session' },
      });
      expect(await managedHtml.text()).toContain('<title>codepilot-web - Zellij</title>');
      expect(htmlBody).toContain('id="codepilot-zellij-shortcuts"');
      expect(htmlBody).toContain('data-expanded="false"');
      expect(htmlBody).toContain('data-idle="true"');
      expect(htmlBody).toContain('data-sequence="16,110" data-hint="Ctrl+P N"');
      expect(htmlBody).toContain('data-sequence="16,120" data-confirm="Ctrl+P X 会关闭当前 Zellij 面板，是否继续？" data-hint="Ctrl+P X"');
      expect(htmlBody).toContain('aria-label="关闭当前 Zellij 面板（需确认）"');
      expect(htmlBody).not.toContain('id="codepilot-shortcut-confirmation"');
      expect(htmlBody).toContain('data-sequence="3" data-hint="Ctrl+C"');
      expect(htmlBody).toContain('data-sequence="9" data-keep-expanded="true" data-hint="Tab"');
      expect(htmlBody).toContain('data-key="ArrowUp" data-sequence="27,91,65" data-keep-expanded="true"');
      expect(htmlBody).toContain('data-key="ArrowDown" data-sequence="27,91,66" data-keep-expanded="true"');
      expect(htmlBody).toContain('id="codepilot-zellij-shortcuts-arrows"');
      expect(htmlBody).toContain('data-storage-key="codepilot-zellij-shortcuts-position-v2"');
      expect(htmlBody).toContain('data-storage-key="codepilot-zellij-shortcuts-position-v2-arrows"');
      expect(htmlBody).toContain('data-initial-side="left" data-no-auto-collapse="true"');
      expect(htmlBody).toContain('data-key="ArrowLeft" data-sequence="27,91,68" data-keep-expanded="true"');
      expect(htmlBody).toContain('data-key="ArrowRight" data-sequence="27,91,67" data-keep-expanded="true"');
      expect(htmlBody).toContain('aria-label="发送左方向键"');
      expect(htmlBody).toContain('aria-label="发送右方向键"');
      const arrowsHtml = htmlBody.slice(
        htmlBody.indexOf('id="codepilot-zellij-shortcuts-arrows"'),
        htmlBody.indexOf('<script src="/codepilot-zellij-shortcuts.js"></script>'),
      );
      expect(arrowsHtml.match(/data-key="Arrow(Up|Down|Left|Right)"/gu)).toHaveLength(4);
      expect(htmlBody).not.toContain('Ctrl+O D');
      expect(htmlBody.match(/data-sequence=/gu)).toHaveLength(10);
      expect(htmlBody).not.toContain('#terminal { height: calc');
      expect(htmlBody).toContain('height: 100dvh !important');
      expect(htmlBody).toContain('border-radius: 50%');
      expect(htmlBody).toContain('0 .75rem 1.6rem rgba(0, 0, 0, .42)');
      expect(htmlBody).toContain('inset 0 -.16rem .22rem rgba(15, 92, 70, .3)');
      expect(htmlBody).toContain('var(--shortcut-1-x)), var(--shortcut-1-y)) scale(1)');
      expect(htmlBody).toContain('var(--shortcut-2-x)), var(--shortcut-2-y)) scale(1)');
      expect(htmlBody).toContain('var(--shortcut-3-x)), var(--shortcut-3-y)) scale(1)');
      expect(htmlBody).toContain('var(--shortcut-4-x)), var(--shortcut-4-y)) scale(1)');
      expect(htmlBody).toContain('var(--shortcut-5-x)), var(--shortcut-5-y)) scale(1)');
      expect(htmlBody).toContain('var(--shortcut-6-x)), var(--shortcut-6-y)) scale(1)');
      expect(htmlBody).not.toContain('7.4rem');
      expect(htmlBody).not.toContain('@media');
      expect(htmlBody).toContain('<script src="/codepilot-zellij-shortcuts.js"></script>');
      const shortcutScriptResponse = await fetch(`http://127.0.0.1:${appPort}/codepilot-zellij-shortcuts.js`);
      const shortcutScript = await shortcutScriptResponse.text();
      expect(shortcutScriptResponse.headers.get('content-type')).toContain('application/javascript');
      expect(shortcutScript).toContain('window.__zjImeBypass.sendFn');
      expect(shortcutScript).not.toContain("new KeyboardEvent('keydown'");
      expect(shortcutScript).toContain("toolbar.dataset.idle = 'true'");
      expect(shortcutScript).toContain('snapToolbarToEdge(true)');
      expect(shortcutScript).toContain("toolbar.style.setProperty('--shortcut-scale'");
      expect(shortcutScript).toContain("toolbar.style.setProperty('--shortcut-size', 2.8 * toolbarScale + 'rem')");
      expect(shortcutScript).not.toContain('terminal.options.fontSize =');
      expect(shortcutScript).toContain('class CodepilotShortcutBall');
      expect(shortcutScript).toContain('new CodepilotShortcutBall(toolbar)');
      expect(shortcutScript).toContain('const updateSoftKeyboardState = () =>');
      expect(shortcutScript).toContain("document.addEventListener('focusout', scheduleViewportRecovery)");
      expect(shortcutScript).toContain("!active.classList.contains('xterm-helper-textarea')");
      expect(shortcutScript).toContain('terminalWasFocused && !isTerminalFocused()');
      expect(shortcutScript).toContain('}, 3000)');
      const dom = new JSDOM(htmlBody, { runScripts: 'outside-only', url: 'https://codepilot.test/zellij/session-name' });
      const sentSequences: string[] = [];
      const terminal = { options: { fontSize: 15 } };
      const confirm = vi.fn<() => boolean>();
      Object.assign(dom.window, {
        __zjImeBypass: { sendFn: (sequence: string) => sentSequences.push(sequence) },
        confirm,
        term: terminal,
      });
      Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { configurable: true, value: 0 });
      dom.window.eval(shortcutScript);
      const terminalInput = dom.window.document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
      const toolbar = dom.window.document.querySelector<HTMLElement>('#codepilot-zellij-shortcuts');
      const arrowsToolbar = dom.window.document.querySelector<HTMLElement>('#codepilot-zellij-shortcuts-arrows');
      const toggle = dom.window.document.querySelector<HTMLButtonElement>('.codepilot-shortcut-toggle');
      expect(toolbar?.style.left).toBe('971px');
      expect(toolbar?.style.top).toBe('361.5px');
      expect(arrowsToolbar?.style.left).toBe('8px');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-x')).toBe('1');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-1-x')).toBe('47.07px');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-1-y')).toBe('-76.25px');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-2-x')).toBe('65.18px');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-2-y')).toBe('-26.48px');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-3-x')).toBe('65.18px');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-3-y')).toBe('26.48px');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-4-x')).toBe('47.07px');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-4-y')).toBe('76.25px');
      Object.defineProperty(arrowsToolbar, 'offsetWidth', { configurable: true, value: 45 });
      Object.defineProperty(arrowsToolbar, 'offsetHeight', { configurable: true, value: 45 });
      arrowsToolbar!.getBoundingClientRect = () => {
        const left = Number.parseFloat(arrowsToolbar?.style.left || '8');
        const top = Number.parseFloat(arrowsToolbar?.style.top || '361.5');
        return { left, top, right: left + 45, bottom: top + 45, width: 45, height: 45, x: left, y: top, toJSON: () => ({}) };
      };
      const arrowsToggle = dom.window.document.querySelector<HTMLButtonElement>('#codepilot-zellij-shortcuts-arrows .codepilot-shortcut-toggle');
      arrowsToggle?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 390 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 900, clientY: 390 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 900, clientY: 390 }));
      expect(arrowsToolbar?.style.left).toBe('971px');
      expect(arrowsToolbar?.style.getPropertyValue('--shortcut-x')).toBe('-1');
      expect(JSON.parse(dom.window.localStorage.getItem('codepilot-zellij-shortcuts-position-v2-arrows') || '{}')).toMatchObject({ side: 'right' });
      const clickToggle = () => {
        toggle?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
        toggle?.click();
      };
      clickToggle();
      expect(dom.window.document.querySelector('#codepilot-zellij-shortcuts')?.getAttribute('data-expanded')).toBe('true');
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      clickToggle();
      expect(toolbar?.getAttribute('data-expanded')).toBe('false');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      clickToggle();
      dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
      expect(toolbar?.getAttribute('data-expanded')).toBe('false');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      toolbar!.dataset.idle = 'true';
      dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
      expect(toolbar?.getAttribute('data-idle')).toBe('true');
      // The direction-key ball starts expanded and never auto-collapses.
      expect(arrowsToolbar?.getAttribute('data-expanded')).toBe('true');
      expect(arrowsToolbar?.getAttribute('data-idle')).toBe('false');
      expect(arrowsToggle?.getAttribute('aria-expanded')).toBe('true');
      const clickArrowsToggle = () => {
        arrowsToggle?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
        arrowsToggle?.click();
      };
      clickArrowsToggle(); // consumes the stale suppressToggleClick from the drag test
      clickArrowsToggle(); // manual collapse is still allowed
      expect(arrowsToolbar?.getAttribute('data-expanded')).toBe('false');
      expect(arrowsToggle?.getAttribute('aria-expanded')).toBe('false');
      clickArrowsToggle(); // manual re-expand
      expect(arrowsToolbar?.getAttribute('data-expanded')).toBe('true');
      // Clicking outside must not collapse the direction-key ball.
      dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
      expect(arrowsToolbar?.getAttribute('data-expanded')).toBe('true');
      expect(arrowsToggle?.getAttribute('aria-expanded')).toBe('true');
      expect(arrowsToolbar?.getAttribute('data-idle')).toBe('false');
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
      clickToggle();
      const shortcut = dom.window.document.querySelector<HTMLButtonElement>('[data-sequence="16,110"]');
      terminalInput?.focus();
      expect(dom.window.document.activeElement).toBe(terminalInput);
      shortcut?.click();
      expect(dom.window.document.activeElement).toBe(terminalInput);
      expect(sentSequences).toEqual(['\x10n']);
      expect(dom.window.document.querySelector('#codepilot-zellij-shortcuts')?.getAttribute('data-expanded')).toBe('false');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.getAttribute('aria-label')).toBe('展开快捷键盘');
      clickToggle();
      const closePane = dom.window.document.querySelector<HTMLButtonElement>('[data-sequence="16,120"]');
      confirm.mockReturnValueOnce(false);
      closePane?.click();
      expect(confirm).toHaveBeenLastCalledWith('Ctrl+P X 会关闭当前 Zellij 面板，是否继续？');
      expect(sentSequences).toEqual(['\x10n']);
      expect(toolbar?.getAttribute('data-expanded')).toBe('true');
      confirm.mockReturnValueOnce(true);
      closePane?.click();
      expect(sentSequences).toEqual(['\x10n', '\x10x']);
      expect(toolbar?.getAttribute('data-expanded')).toBe('false');
      clickToggle();
      const interrupt = dom.window.document.querySelector<HTMLButtonElement>('[data-sequence="3"]');
      interrupt?.click();
      expect(sentSequences).toEqual(['\x10n', '\x10x', '\x03']);
      clickToggle();
      const tab = dom.window.document.querySelector<HTMLButtonElement>('[data-sequence="9"]');
      tab?.click();
      tab?.click();
      expect(sentSequences).toEqual(['\x10n', '\x10x', '\x03', '\t', '\t']);
      expect(toolbar?.getAttribute('data-expanded')).toBe('true');
      const arrowUp = dom.window.document.querySelector<HTMLButtonElement>('[data-key="ArrowUp"]');
      const arrowDown = dom.window.document.querySelector<HTMLButtonElement>('[data-key="ArrowDown"]');
      Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { configurable: true, value: 1 });
      terminalInput?.focus();
      expect(dom.window.document.activeElement).toBe(terminalInput);
      arrowUp?.click();
      arrowDown?.click();
      expect(sentSequences).toEqual(['\x10n', '\x10x', '\x03', '\t', '\t', '\x1b[A', '\x1b[B']);
      expect(dom.window.document.activeElement).toBe(terminalInput);
      expect(toolbar?.getAttribute('data-expanded')).toBe('true');
      const arrowLeft = dom.window.document.querySelector<HTMLButtonElement>('[data-key="ArrowLeft"]');
      const arrowRight = dom.window.document.querySelector<HTMLButtonElement>('[data-key="ArrowRight"]');
      arrowLeft?.click();
      arrowRight?.click();
      expect(sentSequences).toEqual(['\x10n', '\x10x', '\x03', '\t', '\t', '\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']);
      expect(dom.window.document.activeElement).toBe(terminalInput);
      expect(toolbar?.getAttribute('data-expanded')).toBe('true');
      // If a mobile browser steals terminal focus during the tap despite
      // pointerdown preventDefault, sendSequence must restore it so the Codex
      // TUI input stays editable.
      const focusSpy = vi.fn(() => terminalInput?.focus());
      Object.assign(dom.window, { term: { focus: focusSpy } });
      terminalInput?.focus();
      arrowUp?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
      terminalInput?.blur();
      expect(dom.window.document.activeElement).not.toBe(terminalInput);
      arrowUp?.click();
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(dom.window.document.activeElement).toBe(terminalInput);
      expect(sentSequences.at(-1)).toBe('\x1b[A');
      Object.assign(dom.window, { term: terminal });
      Object.defineProperty(toolbar, 'offsetWidth', { configurable: true, value: 45 });
      Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, value: 45 });
      toolbar!.getBoundingClientRect = () => {
        const left = Number.parseFloat(toolbar?.style.left || '900');
        const top = Number.parseFloat(toolbar?.style.top || '700');
        return { left, top, right: left + 45, bottom: top + 45, width: 45, height: 45, x: left, y: top, toJSON: () => ({}) };
      };
      toggle?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 990, clientY: 380 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 220, clientY: 193.5 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 220, clientY: 193.5 }));
      expect(toolbar?.style.left).toBe('8px');
      expect(toolbar?.style.top).toBe('175px');
      expect(toolbar?.style.getPropertyValue('--shortcut-x')).toBe('1');
      expect(toolbar?.style.getPropertyValue('--shortcut-idle-translate')).toBe('-37.8px');
      expect(toolbar?.style.getPropertyValue('--shortcut-1-x')).toBe('13.03px');
      expect(toolbar?.style.getPropertyValue('--shortcut-1-y')).toBe('-116.82px');
      expect(toolbar?.style.getPropertyValue('--shortcut-2-x')).toBe('47.07px');
      expect(toolbar?.style.getPropertyValue('--shortcut-2-y')).toBe('-76.25px');
      expect(toolbar?.style.getPropertyValue('--shortcut-3-x')).toBe('65.18px');
      expect(toolbar?.style.getPropertyValue('--shortcut-3-y')).toBe('-26.48px');
      expect(toolbar?.style.getPropertyValue('--shortcut-4-x')).toBe('65.18px');
      expect(toolbar?.style.getPropertyValue('--shortcut-4-y')).toBe('26.48px');
      expect(toolbar?.style.getPropertyValue('--shortcut-5-x')).toBe('47.07px');
      expect(toolbar?.style.getPropertyValue('--shortcut-5-y')).toBe('76.25px');
      expect(toolbar?.style.getPropertyValue('--shortcut-6-x')).toBe('13.03px');
      expect(toolbar?.style.getPropertyValue('--shortcut-6-y')).toBe('116.82px');
      const savedPosition = JSON.parse(dom.window.localStorage.getItem('codepilot-zellij-shortcuts-position-v2') || '{}') as { side: string; topRatio: number };
      expect(savedPosition).toMatchObject({ side: 'left' });
      Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 1000 });
      dom.window.dispatchEvent(new dom.window.Event('resize'));
      expect(Number.parseFloat(toolbar?.style.top || '')).toBeCloseTo(8 + savedPosition.topRatio * (1000 - 45 - 16), 2);
      const resizedTop = Number.parseFloat(toolbar?.style.top || '0');
      toggle?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: resizedTop + 10 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 18 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 20, clientY: 18 }));
      expect(toolbar?.style.top).toBe('124.82px');
      expect(toolbar?.style.getPropertyValue('--shortcut-1-x')).toBe('13.03px');
      expect(toolbar?.style.getPropertyValue('--shortcut-1-y')).toBe('-116.82px');
      expect(toolbar?.style.getPropertyValue('--shortcut-6-x')).toBe('13.03px');
      expect(toolbar?.style.getPropertyValue('--shortcut-6-y')).toBe('116.82px');
      dom.window.localStorage.setItem('codepilot-zellij-shortcuts-mobile-width', '400');
      Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1000 });
      Object.defineProperty(dom.window, 'devicePixelRatio', { configurable: true, value: 2 });
      dom.window.dispatchEvent(new dom.window.Event('resize'));
      expect(toolbar?.style.getPropertyValue('--shortcut-scale')).toBe('2.5');
      expect(toolbar?.style.getPropertyValue('--shortcut-size')).toBe('7rem');
      expect(toolbar?.style.getPropertyValue('--shortcut-1-x')).toBe('32.56px');
      expect(terminal.options.fontSize).toBe(15);
      dom.window.close();
      expect(httpRequest?.url).toBe('/managed-session');

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
