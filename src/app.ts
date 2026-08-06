import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCompress from '@fastify/compress';
import fastifyHttpProxy from '@fastify/http-proxy';
import fastifyReplyFrom from '@fastify/reply-from';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import type { AppConfig } from './config.js';
import type { ReadinessResult } from './domain/types.js';
import { ApiError } from './errors.js';
import { registerCodexRoutes } from './routes/codex.js';
import { emptyBodySchema, noBodySchema, repositoryIdSchema, repositoryParamsSchema } from './routes/schemas.js';
import { CodexChatService, SpawnCodexAppServerAdapter, type CodexChatServiceLike } from './services/codex-chat-service.js';
import { RepositoryService } from './services/repository-service.js';
import type { ServiceRestarter } from './services/service-restarter.js';
import { SpawnViewerProcessAdapter, ViewerManager } from './services/viewer-manager.js';
import { proxyViewerRequest, viewerIdFromCookie } from './services/viewer-proxy.js';
import { ZELLIJ_VERSION } from './services/zellij-installer.js';
import { ExecFileZellijAdapter, repositorySessionNames, ZellijService, type ManagedSessionMetadata } from './services/zellij-service.js';
import type { ZellijTokenService } from './services/zellij-token-service.js';

const repositoryQuerySchema = z.object({}).strict();
const folderIdSchema = z.string().regex(/^folder_[A-Za-z0-9_-]{43}$/u);
const repositoryFolderQuerySchema = z.object({
  directoryId: folderIdSchema.optional(),
  initialPath: z.string().trim().min(1).max(512)
    .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._~+\-\/]+$/u)
    .optional(),
}).strict().refine(value => !(value.directoryId && value.initialPath), 'directoryId and initialPath are mutually exclusive');
const addManualRepositorySchema = z.object({ directoryId: folderIdSchema }).strict();
const createSessionSchema = z.object({
  repositoryId: repositoryIdSchema,
  command: z.literal('codex'),
}).strict();
const sessionParamsSchema = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) }).strict();
const createViewerSchema = z.object({ repositoryId: repositoryIdSchema }).strict();
const ZELLIJ_WEB_ASSET_CACHE_CONTROL = 'private, max-age=86400, immutable';
const ZELLIJ_WEB_ASSET_NAMES = new Set([
  'addon-clipboard.js',
  'addon-fit.js',
  'addon-web-links.js',
  'addon-webgl.js',
  'auth.js',
  'connection.js',
  'favicon.ico',
  'index.js',
  'input.js',
  'keyboard.js',
  'links.js',
  'modals.js',
  'style.css',
  'terminal.js',
  'utils.js',
  'websockets.js',
  'xterm.css',
  'xterm.js',
]);
const ZELLIJ_SHORTCUTS_SCRIPT_PATH = '/codepilot-zellij-shortcuts.js';
const ZELLIJ_SHORTCUTS_SCRIPT = `(() => {
  const toolbar = document.getElementById('codepilot-zellij-shortcuts');
  if (!toolbar) return;
  const storageKey = 'codepilot-zellij-shortcuts-position';
  const edgeGap = 8;
  let dragState = null;
  let dragFrame = 0;
  let pendingDragPoint = null;
  let idleTimer = 0;
  let toolbarSide = 'right';
  let toolbarTopRatio = 1;
  let toolbarScale = 1;
  let suppressToggleClick = false;
  const scheduleFrame = window.requestAnimationFrame?.bind(window) || (callback => window.setTimeout(callback, 16));
  const cancelFrame = window.cancelAnimationFrame?.bind(window) || window.clearTimeout.bind(window);
  const blurEditable = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]')) active.blur();
  };
  const wakeToolbar = () => {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = 0;
    toolbar.dataset.idle = 'false';
  };
  const scheduleIdle = () => {
    wakeToolbar();
    if (toolbar.dataset.expanded === 'true') return;
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      if (toolbar.dataset.expanded !== 'true' && !dragState) {
        snapToolbarToEdge(true);
        toolbar.dataset.idle = 'true';
      }
    }, 3000);
  };
  const sendSequence = sequence => {
    const sendFunction = window.__zjImeBypass && window.__zjImeBypass.sendFn;
    if (typeof sendFunction === 'function') sendFunction(sequence);
  };
  const updateToolbarScale = () => {
    const visualScale = window.visualViewport && Number.isFinite(window.visualViewport.scale)
      ? window.visualViewport.scale
      : 1;
    const screenWidth = window.screen && Number.isFinite(window.screen.width) ? window.screen.width : window.innerWidth;
    const desktopModeRatio = navigator.maxTouchPoints > 0 && screenWidth > 0 && window.innerWidth > screenWidth * 1.4
      ? window.innerWidth / screenWidth
      : 1;
    toolbarScale = Math.max(1, Math.min(2.5, visualScale < .95 ? 1 / visualScale : desktopModeRatio));
    toolbar.style.setProperty('--shortcut-scale', String(toolbarScale));
  };
  const placeToolbar = (left, top, persist) => {
    const width = toolbar.offsetWidth || 45;
    const height = toolbar.offsetHeight || 45;
    const radius = 96 * toolbarScale;
    const boundedLeft = Math.max(edgeGap, Math.min(left, window.innerWidth - width - edgeGap));
    const boundedTop = Math.max(edgeGap, Math.min(top, window.innerHeight - height - edgeGap));
    const upperSpace = Math.max(0, boundedTop - edgeGap);
    const lowerSpace = Math.max(0, window.innerHeight - boundedTop - height - edgeGap);
    const minimumAngle = -Math.asin(Math.min(1, upperSpace / radius)) * 180 / Math.PI;
    const maximumAngle = Math.asin(Math.min(1, lowerSpace / radius)) * 180 / Math.PI;
    const arcCenter = Math.max(minimumAngle + 45, Math.min(0, maximumAngle - 45));
    const arcAngles = [-45, -15, 15, 45].map(offset => (arcCenter + offset) * Math.PI / 180);
    toolbar.style.left = boundedLeft + 'px';
    toolbar.style.top = boundedTop + 'px';
    toolbar.style.right = 'auto';
    toolbar.style.bottom = 'auto';
    const direction = boundedLeft + width / 2 < window.innerWidth / 2 ? 1 : -1;
    const availableHeight = Math.max(1, window.innerHeight - height - edgeGap * 2);
    toolbarSide = direction === 1 ? 'left' : 'right';
    toolbarTopRatio = Math.max(0, Math.min(1, (boundedTop - edgeGap) / availableHeight));
    toolbar.style.setProperty('--shortcut-x', String(direction));
    arcAngles.forEach((angle, index) => {
      toolbar.style.setProperty('--shortcut-' + (index + 1) + '-x', Math.round(Math.cos(angle) * radius * 100) / 100 + 'px');
      toolbar.style.setProperty('--shortcut-' + (index + 1) + '-y', Math.round(Math.sin(angle) * radius * 100) / 100 + 'px');
    });
    if (persist) {
      try { window.localStorage.setItem(storageKey, JSON.stringify({ side: toolbarSide, topRatio: toolbarTopRatio })); } catch {}
    }
  };
  const snapToolbarToEdge = persist => {
    const rect = toolbar.getBoundingClientRect();
    const width = rect.width || toolbar.offsetWidth || 45;
    const snappedLeft = rect.left + width / 2 < window.innerWidth / 2
      ? edgeGap
      : window.innerWidth - width - edgeGap;
    placeToolbar(snappedLeft, rect.top, persist);
  };
  const setExpanded = expanded => {
    wakeToolbar();
    toolbar.dataset.expanded = String(expanded);
    const toggle = toolbar.querySelector('.codepilot-shortcut-toggle');
    if (toggle instanceof HTMLButtonElement) {
      toggle.setAttribute('aria-label', expanded ? '收起快捷键盘' : '展开快捷键盘');
      toggle.setAttribute('aria-expanded', String(expanded));
    }
    if (!expanded) scheduleIdle();
  };
  const stopDragging = event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    if (dragFrame) cancelFrame(dragFrame);
    dragFrame = 0;
    if (pendingDragPoint) {
      placeToolbar(pendingDragPoint.left, pendingDragPoint.top, false);
      pendingDragPoint = null;
    }
    if (dragState.moved) {
      suppressToggleClick = true;
      snapToolbarToEdge(true);
    }
    dragState = null;
    window.removeEventListener('pointermove', moveToolbar);
    window.removeEventListener('pointerup', stopDragging);
    window.removeEventListener('pointercancel', stopDragging);
    scheduleIdle();
  };
  const moveToolbar = event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const deltaX = event.clientX - dragState.pointerX;
    const deltaY = event.clientY - dragState.pointerY;
    if (!dragState.moved && Math.hypot(deltaX, deltaY) < 5) return;
    if (!dragState.moved) setExpanded(false);
    dragState.moved = true;
    pendingDragPoint = { left: dragState.left + deltaX, top: dragState.top + deltaY };
    if (!dragFrame) {
      dragFrame = scheduleFrame(() => {
        dragFrame = 0;
        if (!pendingDragPoint) return;
        placeToolbar(pendingDragPoint.left, pendingDragPoint.top, false);
        pendingDragPoint = null;
      });
    }
  };
  toolbar.addEventListener('pointerdown', event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!(button instanceof HTMLButtonElement)) return;
    event.preventDefault();
    wakeToolbar();
    blurEditable();
    if (!button.classList.contains('codepilot-shortcut-toggle')) return;
    const rect = toolbar.getBoundingClientRect();
    dragState = { pointerId: event.pointerId, pointerX: event.clientX, pointerY: event.clientY, left: rect.left, top: rect.top, moved: false };
    button.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', moveToolbar);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
  });
  toolbar.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!(button instanceof HTMLButtonElement)) return;
    wakeToolbar();
    blurEditable();
    if (button.classList.contains('codepilot-shortcut-toggle')) {
      if (suppressToggleClick) {
        suppressToggleClick = false;
        return;
      }
      setExpanded(toolbar.dataset.expanded !== 'true');
      return;
    }
    const sequence = button.dataset.sequence;
    if (sequence) {
      for (const value of sequence.split(',')) sendSequence(String.fromCharCode(Number(value)));
      if (button.dataset.keepExpanded !== 'true') setExpanded(false);
    }
  });
  document.addEventListener('pointerdown', event => {
    const target = event.target;
    if (target instanceof Node && !toolbar.contains(target) && toolbar.dataset.expanded === 'true') setExpanded(false);
  });
  try {
    updateToolbarScale();
    const saved = JSON.parse(window.localStorage.getItem(storageKey) || 'null');
    const width = toolbar.offsetWidth || 45;
    const height = toolbar.offsetHeight || 45;
    if (saved && (saved.side === 'left' || saved.side === 'right') && Number.isFinite(saved.topRatio)) {
      const left = saved.side === 'left' ? edgeGap : window.innerWidth - width - edgeGap;
      const top = edgeGap + Math.max(0, Math.min(1, saved.topRatio)) * Math.max(1, window.innerHeight - height - edgeGap * 2);
      placeToolbar(left, top, false);
    } else if (saved && Number.isFinite(saved.top)) {
      placeToolbar(window.innerWidth - width - edgeGap, saved.top, true);
    } else {
      placeToolbar(window.innerWidth - width - edgeGap, window.innerHeight - height - edgeGap, false);
    }
  } catch {}
  window.addEventListener('resize', () => {
    updateToolbarScale();
    const width = toolbar.offsetWidth || 45;
    const height = toolbar.offsetHeight || 45;
    const availableHeight = Math.max(1, window.innerHeight - height - edgeGap * 2);
    const left = toolbarSide === 'left' ? edgeGap : window.innerWidth - width - edgeGap;
    placeToolbar(left, edgeGap + toolbarTopRatio * availableHeight, true);
  });
  window.visualViewport?.addEventListener('resize', () => window.dispatchEvent(new Event('resize')));
  toolbar.dataset.idle = 'true';
})();`;
const ZELLIJ_SHORTCUTS = `
<style id="codepilot-zellij-shortcuts-style">
  #codepilot-zellij-shortcuts { --shortcut-scale: 1; --shortcut-size: calc(2.8rem * var(--shortcut-scale)); --shortcut-x: -1; --shortcut-1-x: 4.24rem; --shortcut-1-y: -4.24rem; --shortcut-2-x: 5.8rem; --shortcut-2-y: -1.55rem; --shortcut-3-x: 5.8rem; --shortcut-3-y: 1.55rem; --shortcut-4-x: 4.24rem; --shortcut-4-y: 4.24rem; position: fixed; right: max(.8rem, env(safe-area-inset-right, 0px)); bottom: max(.8rem, env(safe-area-inset-bottom, 0px)); z-index: 2147483647; width: var(--shortcut-size); height: var(--shortcut-size); pointer-events: none; }
  #codepilot-zellij-shortcuts button { position: absolute; display: grid; place-items: center; width: var(--shortcut-size); height: var(--shortcut-size); padding: 0; border: 1px solid #617a72; border-radius: 50%; color: #eff8f5; background: rgba(27, 44, 39, .97); box-shadow: 0 .35rem 1rem rgba(0, 0, 0, .35); font: 700 calc(.78rem * var(--shortcut-scale)) ui-monospace, SFMono-Regular, Consolas, monospace; touch-action: manipulation; pointer-events: auto; transition: transform .18s ease, opacity .14s ease, background .14s ease; }
  #codepilot-zellij-shortcuts button:active { background: #45635a; }
  #codepilot-zellij-shortcuts .codepilot-shortcut-toggle { right: 0; bottom: 0; z-index: 2; color: #07110f; border-color: #8aebca; background: #73e1bd; box-shadow: 0 .18rem .35rem rgba(0, 0, 0, .48), 0 .75rem 1.6rem rgba(0, 0, 0, .42), 0 0 1.15rem rgba(115, 225, 189, .3), inset 0 .12rem .18rem rgba(255, 255, 255, .38), inset 0 -.16rem .22rem rgba(15, 92, 70, .3); font-size: calc(1.15rem * var(--shortcut-scale)); touch-action: none; will-change: left, top, transform; transition: transform .18s ease, opacity .18s ease, background .14s ease; }
  #codepilot-zellij-shortcuts[data-idle="true"] .codepilot-shortcut-toggle { opacity: .32; transform: translateX(calc(var(--shortcut-x) * var(--shortcut-size) * -.84)); box-shadow: 0 0 .35rem rgba(0, 0, 0, .22); }
  #codepilot-zellij-shortcuts .codepilot-shortcut-toggle:active { box-shadow: 0 .1rem .2rem rgba(0, 0, 0, .42), 0 .35rem .8rem rgba(0, 0, 0, .36), 0 0 .8rem rgba(115, 225, 189, .22), inset 0 .16rem .3rem rgba(15, 92, 70, .38); }
  #codepilot-zellij-shortcuts .codepilot-ring-action { right: 0; bottom: 0; opacity: 0; transform: translate(0, 0) scale(.72); }
  #codepilot-zellij-shortcuts .codepilot-ring-action::after { content: attr(data-hint); position: absolute; top: calc(100% + .18rem); color: #b7cbc5; font: 600 .58rem ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
  #codepilot-zellij-shortcuts[data-expanded="true"] .codepilot-ring-action { opacity: 1; }
  #codepilot-zellij-shortcuts[data-expanded="true"] .codepilot-ring-action:nth-of-type(2) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-1-x)), var(--shortcut-1-y)) scale(1); }
  #codepilot-zellij-shortcuts[data-expanded="true"] .codepilot-ring-action:nth-of-type(3) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-2-x)), var(--shortcut-2-y)) scale(1); }
  #codepilot-zellij-shortcuts[data-expanded="true"] .codepilot-ring-action:nth-of-type(4) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-3-x)), var(--shortcut-3-y)) scale(1); }
  #codepilot-zellij-shortcuts[data-expanded="true"] .codepilot-ring-action:nth-of-type(5) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-4-x)), var(--shortcut-4-y)) scale(1); }
  #codepilot-zellij-shortcuts[data-expanded="true"] .codepilot-shortcut-toggle { opacity: 1; transform: rotate(45deg); }
</style>
<div id="codepilot-zellij-shortcuts" role="toolbar" aria-label="终端快捷键盘" data-expanded="false" data-idle="true">
  <button type="button" tabindex="-1" class="codepilot-shortcut-toggle" aria-label="展开快捷键盘" aria-expanded="false">+</button>
  <button type="button" tabindex="-1" class="codepilot-ring-action" data-sequence="16,110" data-hint="Ctrl+P N" aria-label="发送 Ctrl+P N">N</button>
  <button type="button" tabindex="-1" class="codepilot-ring-action" data-sequence="16,120" data-hint="Ctrl+P X" aria-label="发送 Ctrl+P X">X</button>
  <button type="button" tabindex="-1" class="codepilot-ring-action" data-sequence="3" data-hint="Ctrl+C" aria-label="发送 Ctrl+C">C</button>
  <button type="button" tabindex="-1" class="codepilot-ring-action" data-sequence="9" data-keep-expanded="true" data-hint="Tab" aria-label="发送 Tab">Tab</button>
</div>
<script src="${ZELLIJ_SHORTCUTS_SCRIPT_PATH}"></script>`;

function viewerLaunchHtml(repositoryId: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在打开 code-viewer</title></head>
<body style="margin:0;display:grid;min-height:100vh;place-items:center;color:#d7fff3;background:#07110f;font:16px system-ui,sans-serif">
<p id="status">正在启动 code-viewer…</p>
<script>(()=>{const repositoryId=${JSON.stringify(repositoryId)};fetch('/api/viewers',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({repositoryId})}).then(async response=>{if(!response.ok)throw new Error();return response.json()}).then(viewer=>{if(typeof viewer.webUrl!=='string'||!viewer.webUrl)throw new Error();window.location.replace(viewer.webUrl)}).catch(()=>{document.getElementById('status').textContent='code-viewer 启动失败，请关闭此页面后重试。'})})();</script>
</body>
</html>`;
}

function zellijWebAssetEtag(pathname: string): string | null {
  const match = /^\/zellij\/assets\/([A-Za-z0-9._-]+)$/u.exec(pathname);
  const assetName = match?.[1];
  if (!assetName || !ZELLIJ_WEB_ASSET_NAMES.has(assetName)) return null;
  return `W/"zellij-${ZELLIJ_VERSION}-${assetName}"`;
}

function openVSCodeWebUrl(config: AppConfig, repositoryRealPath: string): string {
  const url = new URL(config.publicBaseUrl);
  url.pathname = '/openvscode/';
  url.search = '';
  url.searchParams.set('folder', repositoryRealPath);
  url.hash = '';
  return url.toString();
}

function zellijCookiePrefix(publicBaseUrl: string): string {
  const url = new URL(publicBaseUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `codepilot_zellij_${port}_`;
}

function rewriteZellijSetCookies(cookies: readonly string[], cookiePrefix: string): string[] {
  return cookies.map(cookie => {
    const parts = cookie.split(';');
    const cookiePair = parts[0];
    if (!cookiePair) return cookie;
    const separator = cookiePair.indexOf('=');
    if (separator <= 0) return cookie;
    parts[0] = `${cookiePrefix}${cookiePair.slice(0, separator)}${cookiePair.slice(separator)}`;
    const pathIndex = parts.findIndex(part => /^\s*path=/iu.test(part));
    if (pathIndex >= 0) parts[pathIndex] = ' Path=/zellij';
    else parts.push(' Path=/zellij');
    return parts.join(';');
  });
}

function upstreamZellijCookie(cookie: string | undefined, cookiePrefix: string): string | undefined {
  const translated = cookie?.split(';').map(part => part.trim()).flatMap(part => {
    const separator = part.indexOf('=');
    if (separator <= 0) return [];
    const name = part.slice(0, separator);
    if (!name.startsWith(cookiePrefix)) return [];
    return [`${name.slice(cookiePrefix.length)}${part.slice(separator)}`];
  });
  return translated?.length ? translated.join('; ') : undefined;
}

function rewriteZellijRequestHeaders(headers: IncomingHttpHeaders, cookiePrefix: string): IncomingHttpHeaders {
  const rewritten = { ...headers };
  const cookie = upstreamZellijCookie(typeof headers.cookie === 'string' ? headers.cookie : undefined, cookiePrefix);
  if (cookie) rewritten.cookie = cookie;
  else delete rewritten.cookie;
  return rewritten;
}

async function requestZellijWebLogin(destination: string, token: string) {
  const url = new URL(destination);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = JSON.stringify({ auth_token: token, remember_me: false });
  return new Promise<{ statusCode: number; cookies: string[] }>((resolve, reject) => {
    const upstream = request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      rejectUnauthorized: false,
    }, response => {
      response.resume();
      response.once('error', reject);
      response.once('end', () => {
        const setCookie = response.headers['set-cookie'];
        resolve({
          statusCode: response.statusCode ?? 502,
          cookies: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
        });
      });
    });
    upstream.once('error', reject);
    upstream.end(body);
  });
}

async function proxyZellijHtml(destination: string, cookie: string | undefined, cookiePrefix: string) {
  const url = new URL(destination);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstreamCookie = upstreamZellijCookie(cookie, cookiePrefix);
  return new Promise<{ statusCode: number; headers: Record<string, string | string[]>; body: string }>((resolve, reject) => {
    const upstream = request(url, {
      headers: upstreamCookie ? { cookie: upstreamCookie } : undefined,
      rejectUnauthorized: false,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.destroy(new Error('Zellij Web HTML response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !['connection', 'content-length', 'keep-alive', 'transfer-encoding'].includes(name)) {
            headers[name] = value;
          }
        }
        resolve({
          statusCode: response.statusCode ?? 502,
          headers,
          body: Buffer.concat(chunks).toString('utf8')
            .replace('<base href="/" />', '<base href="/zellij/" />')
            .replace('</body>', `${ZELLIJ_SHORTCUTS}</body>`),
        });
      });
    });
    upstream.once('error', reject);
    upstream.end();
  });
}

export interface AppDependencies {
  readiness: ReadinessResult;
  directoryIdSecret: Buffer | null;
  zellijExecutablePath?: string;
  zellijWebUpstreamUrl?: string;
  codeViewerExecutablePath?: string;
  codexExecutablePath?: string;
  zellijAdapter?: ConstructorParameters<typeof ZellijService>[0];
  managedSessions?: Map<string, ManagedSessionMetadata>;
  persistManagedSessions?: (sessions: ReadonlyMap<string, ManagedSessionMetadata>) => Promise<void>;
  manualRepositoryPaths?: readonly string[];
  persistManualRepositoryPaths?: (paths: readonly string[]) => Promise<void>;
  viewerManager?: ViewerManager;
  zellijTokenService?: ZellijTokenService;
  serviceRestarter?: ServiceRestarter;
  codexChatService?: CodexChatServiceLike;
  staticRoot?: string | false;
  https?: false;
  logger?: boolean;
}

export async function createApp(config: AppConfig, dependencies: AppDependencies) {
  const logger = dependencies.logger ?? true;
  const https = dependencies.https === false ? undefined : {
    cert: readFileSync(config.zellijWebCertificateFile),
    key: readFileSync(config.zellijWebPrivateKeyFile),
  };
  const fastifyOptions = { logger, bodyLimit: 64 * 1024 };
  const app = (https
    ? Fastify({ ...fastifyOptions, https })
    : Fastify(fastifyOptions)) as unknown as FastifyInstance;
  await app.register(fastifyCompress, {
    encodings: ['gzip'],
    global: true,
    globalDecompression: false,
    threshold: 1024,
  });
  await app.register(fastifyReplyFrom, {
    base: `http://127.0.0.1:${config.viewerPortRange.start}`,
    disableRequestLogging: true,
  });
  app.get(ZELLIJ_SHORTCUTS_SCRIPT_PATH, async (_request, reply) => reply
    .type('application/javascript; charset=utf-8')
    .header('cache-control', 'no-cache')
    .send(ZELLIJ_SHORTCUTS_SCRIPT));
  app.get('/viewer-launch/:repositoryId', async (request, reply) => {
    const params = repositoryParamsSchema.parse(request.params);
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(viewerLaunchHtml(params.repositoryId));
  });
  const zellijProxyUpstream = dependencies.zellijWebUpstreamUrl ?? `https://127.0.0.1:${config.zellijWebPort}`;
  const zellijBrowserCookiePrefix = zellijCookiePrefix(config.publicBaseUrl);
  await app.register(fastifyHttpProxy, {
    upstream: zellijProxyUpstream,
    prefix: '/zellij',
    rewritePrefix: '',
    websocket: true,
    disableRequestLogging: true,
    undici: { connect: { rejectUnauthorized: false } },
    wsClientOptions: {
      rejectUnauthorized: false,
      rewriteRequestHeaders: (headers: IncomingHttpHeaders, request?: { headers?: IncomingHttpHeaders }) => rewriteZellijRequestHeaders(
        { ...headers, cookie: request?.headers?.cookie },
        zellijBrowserCookiePrefix,
      ),
    },
    preValidation: async (request, reply) => {
      if (request.method !== 'GET') return;
      const pathname = new URL(request.raw.url ?? '/', config.publicBaseUrl).pathname;
      const etag = zellijWebAssetEtag(pathname);
      if (!etag) return;
      const ifNoneMatch = request.headers['if-none-match'];
      if (ifNoneMatch === '*' || ifNoneMatch?.split(',').map(value => value.trim()).includes(etag)) {
        return reply.code(304).headers({
          'cache-control': ZELLIJ_WEB_ASSET_CACHE_CONTROL,
          etag,
        }).send();
      }
    },
    replyOptions: {
      rewriteRequestHeaders: (_request, headers) => rewriteZellijRequestHeaders(headers, zellijBrowserCookiePrefix),
      rewriteHeaders: (headers, request) => {
        const pathname = new URL(request?.raw.url ?? '/', config.publicBaseUrl).pathname;
        const etag = request?.method === 'GET' ? zellijWebAssetEtag(pathname) : null;
        const rewritten = { ...headers };
        const setCookie = headers['set-cookie'];
        if (setCookie) {
          rewritten['set-cookie'] = rewriteZellijSetCookies(
            Array.isArray(setCookie) ? setCookie : [setCookie],
            zellijBrowserCookiePrefix,
          );
        }
        if (etag) Object.assign(rewritten, { 'cache-control': ZELLIJ_WEB_ASSET_CACHE_CONTROL, etag });
        return rewritten;
      },
    },
    handler: async (request, reply, destination, options) => {
      const pathname = new URL(request.raw.url ?? '/', config.publicBaseUrl).pathname;
      const loginPath = pathname.match(/^\/zellij\/open\/([A-Za-z0-9_-]{1,64})\/?$/u);
      if (request.method === 'GET' && loginPath?.[1]) {
        const token = dependencies.zellijTokenService?.get() ?? config.zellijWebToken;
        if (!token) throw new ApiError(503, 'SERVICE_NOT_READY', 'Zellij Web login is not ready');
        const login = await requestZellijWebLogin(
          new URL('/command/login', zellijProxyUpstream).toString(),
          token.value,
        );
        if (login.statusCode !== 200 || login.cookies.length === 0) {
          throw new ApiError(502, 'ZELLIJ_WEB_LOGIN_FAILED', 'Zellij Web login failed');
        }
        return reply.code(302).headers({
          location: `/zellij/${encodeURIComponent(loginPath[1])}`,
          'set-cookie': rewriteZellijSetCookies(login.cookies, zellijBrowserCookiePrefix),
        }).send();
      }
      if (request.method === 'GET' && (/^\/zellij\/?$/u.test(pathname) || /^\/zellij\/[A-Za-z0-9_-]{1,64}\/?$/u.test(pathname))) {
        const response = await proxyZellijHtml(
          new URL(destination, `${zellijProxyUpstream}/`).toString(),
          request.headers.cookie,
          zellijBrowserCookiePrefix,
        );
        return reply.code(response.statusCode).headers(response.headers).send(response.body);
      }
      return reply.from(destination, options);
    },
  });
  const openVSCodePublicUrl = new URL(config.publicBaseUrl);
  await app.register(fastifyHttpProxy, {
    upstream: `http://127.0.0.1:${config.openVSCodePort}`,
    prefix: '/openvscode',
    rewritePrefix: '/openvscode',
    websocket: true,
    disableRequestLogging: true,
    replyOptions: {
      rewriteRequestHeaders: (_request, headers) => ({
        ...headers,
        host: openVSCodePublicUrl.host,
        'x-forwarded-host': openVSCodePublicUrl.host,
        'x-forwarded-proto': 'https',
      }),
    },
    wsClientOptions: {
      headers: {
        host: openVSCodePublicUrl.host,
        origin: config.publicBaseUrl,
      },
    },
  });
  const repositoryService = dependencies.directoryIdSecret
    ? new RepositoryService(
      config.workspaceRootRealPath,
      dependencies.directoryIdSecret,
      config.projectMarkers,
      app.log,
      dependencies.manualRepositoryPaths,
      dependencies.persistManualRepositoryPaths,
    )
    : null;
  const zellijService = new ZellijService(
    dependencies.zellijAdapter ?? new ExecFileZellijAdapter(dependencies.zellijExecutablePath),
    new URL('/zellij/open/', config.publicBaseUrl).toString().replace(/\/$/u, ''),
    app.log,
    dependencies.managedSessions ?? new Map(),
    path.join(path.dirname(config.directoryIdSecretFile), 'layouts'),
    dependencies.persistManagedSessions,
  );
  const viewerManager = dependencies.viewerManager ?? new ViewerManager(
    new SpawnViewerProcessAdapter(dependencies.codeViewerExecutablePath),
    config.viewerPortRange.start,
    config.publicBaseUrl,
  );
  const codexChatService = dependencies.codexChatService ?? new CodexChatService(
    new SpawnCodexAppServerAdapter(dependencies.codexExecutablePath),
  );

  const requireSameOrigin = (origin: string | undefined) => {
    if (origin !== config.publicBaseUrl) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  };

  app.addHook('preHandler', async request => {
    if ((request.method === 'POST' || request.method === 'DELETE') && dependencies.readiness.status !== 'ready') {
      throw new ApiError(503, 'SERVICE_NOT_READY', 'Write operations are not ready');
    }
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async (_request, reply) => {
    if (dependencies.readiness.status !== 'ready') reply.code(503);
    return dependencies.readiness;
  });
  app.get('/api/sessions', async () => {
    try {
      return { sessions: await zellijService.listSessions() };
    } catch {
      throw new ApiError(502, 'ZELLIJ_UNAVAILABLE', 'Zellij sessions are temporarily unavailable');
    }
  });
  app.get('/api/zellij-token', async () => ({
    token: dependencies.zellijTokenService?.get() ?? config.zellijWebToken,
  }));
  app.get('/api/repositories', async request => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Repository browsing is not ready');
    repositoryQuerySchema.parse(request.query);
    const listing = await repositoryService.list();
    let sessions = [] as Awaited<ReturnType<ZellijService['listSessions']>>;
    try {
      sessions = await zellijService.listSessions();
    } catch {
      app.log.warn('Zellij sessions were unavailable while listing repositories');
    }
    const sessionsByName = new Map(sessions.map(session => [session.name, session]));
    const sessionNamesByRepositoryId = repositorySessionNames(listing.entries);
    const entries = await Promise.all(listing.entries.map(async entry => {
      const viewer = viewerManager.currentFor(entry.id);
      const sessionName = sessionNamesByRepositoryId.get(entry.id)!;
      const session = sessionsByName.get(sessionName);
      const repository = entry.kind === 'repository'
        ? await repositoryService.resolveRepository(entry.id)
        : null;
      return {
        ...entry,
        openVSCodeUrl: repository ? openVSCodeWebUrl(config, repository.realPath) : null,
        viewer: viewer ? { id: viewer.id, status: viewer.status, webUrl: viewer.webUrl } : null,
        session: session ? { name: session.name, status: session.status, webUrl: session.webUrl } : null,
      };
    }));
    return {
      ...listing,
      entries,
    };
  });
  app.get('/api/repository-folders', async request => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Repository browsing is not ready');
    const query = repositoryFolderQuerySchema.parse(request.query);
    return repositoryService.listFolders(query.directoryId, query.initialPath);
  });
  app.get('/api/repositories/:repositoryId/files', async request => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Repository browsing is not ready');
    repositoryQuerySchema.parse(request.query);
    const params = repositoryParamsSchema.parse(request.params);
    return repositoryService.listContextFiles(params.repositoryId);
  });
  app.post('/api/repositories', async (request, reply) => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Repository browsing is not ready');
    requireSameOrigin(request.headers.origin);
    const body = addManualRepositorySchema.parse(request.body);
    const repositoryId = await repositoryService.addManualRepository(body.directoryId);
    await reply.code(201).send({ repositoryId });
  });
  app.delete('/api/repositories/:repositoryId', async (request, reply) => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Repository browsing is not ready');
    requireSameOrigin(request.headers.origin);
    noBodySchema.parse(request.body);
    const params = repositoryParamsSchema.parse(request.params);
    await repositoryService.validateManualRepository(params.repositoryId);
    await zellijService.deleteSessionsForRepository(params.repositoryId);
    await viewerManager.stopFor(params.repositoryId);
    if (codexChatService.cleanupRepository) {
      await codexChatService.cleanupRepository(params.repositoryId);
    } else {
      try {
        codexChatService.stopConversation(params.repositoryId);
      } catch {
        // No active Codex turn is also a clean state.
      }
      await codexChatService.clearConversation(params.repositoryId);
    }
    await repositoryService.removeManualRepository(params.repositoryId);
    await reply.code(204).send();
  });
  app.post('/api/sessions', async (request, reply) => {
    if (!repositoryService || dependencies.readiness.status !== 'ready') {
      throw new ApiError(503, 'SERVICE_NOT_READY', 'Session creation is not ready');
    }
    requireSameOrigin(request.headers.origin);
    const body = createSessionSchema.parse(request.body);
    const listing = await repositoryService.list();
    const entry = listing.entries.find(candidate => candidate.id === body.repositoryId);
    if (!entry) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    const sessionName = repositorySessionNames(listing.entries).get(entry.id)!;
    const repository = await repositoryService.resolveRepository(body.repositoryId);
    const result = await zellijService.ensureRepositorySession(
      sessionName,
      body.repositoryId,
      repository.relativePath,
      repository.realPath,
    );
    await reply.code(result.created ? 201 : 200).send(result.session);
  });
  app.delete('/api/sessions/:name', async (request, reply) => {
    if (dependencies.readiness.status !== 'ready') {
      throw new ApiError(503, 'SERVICE_NOT_READY', 'Session deletion is not ready');
    }
    requireSameOrigin(request.headers.origin);
    noBodySchema.parse(request.body);
    const params = sessionParamsSchema.parse(request.params);
    await zellijService.deleteSession(params.name);
    await reply.code(204).send();
  });
  app.post('/api/viewers', async (request, reply) => {
    if (!repositoryService || dependencies.readiness.status !== 'ready') {
      throw new ApiError(503, 'SERVICE_NOT_READY', 'Code browsing is not ready');
    }
    requireSameOrigin(request.headers.origin);
    const body = createViewerSchema.parse(request.body);
    const repository = await repositoryService.resolveRepository(body.repositoryId);
    const result = await viewerManager.create(body.repositoryId, repository.realPath);
    await reply.code(result.created ? 201 : 200).send(result.instance);
  });
  registerCodexRoutes(app, {
    repositoryService,
    codexChatService,
    appearance: config.codexChatAppearance,
    requireSameOrigin,
  });
  app.post('/api/zellij-token/regenerate', async (request, reply) => {
    requireSameOrigin(request.headers.origin);
    emptyBodySchema.parse(request.body ?? {});
    if (!dependencies.zellijTokenService) {
      throw new ApiError(503, 'SERVICE_NOT_READY', 'Zellij Web token management is not ready');
    }
    const token = await dependencies.zellijTokenService.regenerate();
    await reply.code(201).send({ token });
  });
  app.post('/api/services/restart', async (request, reply) => {
    requireSameOrigin(request.headers.origin);
    emptyBodySchema.parse(request.body ?? {});
    if (!dependencies.serviceRestarter) {
      throw new ApiError(503, 'SERVICE_NOT_READY', 'Service restart is not available');
    }
    await dependencies.serviceRestarter.restart();
    await reply.code(202).send({ status: 'restarting' });
  });
  app.delete('/api/zellij-token', async (request, reply) => {
    requireSameOrigin(request.headers.origin);
    if (!dependencies.zellijTokenService) {
      throw new ApiError(503, 'SERVICE_NOT_READY', 'Zellij Web token management is not ready');
    }
    if (!(await dependencies.zellijTokenService.delete())) {
      throw new ApiError(404, 'ZELLIJ_TOKEN_NOT_FOUND', 'Zellij Web token does not exist');
    }
    await reply.code(204).send();
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      await reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Request validation failed', requestId: request.id },
      });
      return;
    }
    if (error instanceof ApiError) {
      await reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
      return;
    }
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      && typeof error.statusCode === 'number' ? error.statusCode : null;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      await reply.code(statusCode).send({
        error: { code: 'INVALID_REQUEST', message: 'Request validation failed', requestId: request.id },
      });
      return;
    }
    request.log.error({ err: error }, 'request failed');
    await reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed', requestId: request.id },
    });
  });

  const defaultStaticRoot = fileURLToPath(new URL('./web', import.meta.url));
  const staticRoot = dependencies.staticRoot === false ? null : (dependencies.staticRoot ?? defaultStaticRoot);
  if (staticRoot && existsSync(path.join(staticRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
    app.all('/*', async (request, reply) => {
      const requestUrl = new URL(request.raw.url ?? '/', config.publicBaseUrl);
      const prefixed = requestUrl.pathname.match(/^\/viewer\/(viewer_[A-Za-z0-9_-]{22})(\/.*)?$/u);
      if (prefixed?.[1]) {
        return proxyViewerRequest(
          request,
          reply,
          viewerManager,
          prefixed[1],
          `${prefixed[2] ?? '/'}${requestUrl.search}`,
        );
      }
      const managementPage = requestUrl.pathname === '/' || requestUrl.pathname === '/codex-chat';
      const cookieViewerId = viewerIdFromCookie(request.headers.cookie);
      const managementApi = requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/');
      if (!managementPage && !managementApi && cookieViewerId && cookieViewerId === viewerManager.activeViewerId()) {
        return proxyViewerRequest(request, reply, viewerManager, cookieViewerId, `${requestUrl.pathname}${requestUrl.search}`);
      }
      if (managementApi) {
        await reply.code(404).send();
        return;
      }
      if (request.method === 'GET') {
        await reply.sendFile('index.html');
        return;
      }
      await reply.code(404).send();
    });
  }

  app.addHook('onClose', async () => {
    await Promise.all([viewerManager.close(), codexChatService.close()]);
  });

  return app;
}
