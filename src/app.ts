import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyHttpProxy from '@fastify/http-proxy';
import fastifyReplyFrom from '@fastify/reply-from';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import type { AppConfig } from './config.js';
import type { CodexConversationStreamEvent, ReadinessResult } from './domain/types.js';
import { ApiError } from './errors.js';
import { CodexChatService, SpawnCodexAppServerAdapter, type CodexChatServiceLike } from './services/codex-chat-service.js';
import { RepositoryService } from './services/repository-service.js';
import type { ServiceRestarter } from './services/service-restarter.js';
import { SpawnViewerProcessAdapter, ViewerManager } from './services/viewer-manager.js';
import { proxyViewerRequest, viewerIdFromCookie } from './services/viewer-proxy.js';
import { ExecFileZellijAdapter, repositorySessionName, ZellijService, type ManagedSessionMetadata } from './services/zellij-service.js';
import type { ZellijTokenService } from './services/zellij-token-service.js';

const repositoryQuerySchema = z.object({}).strict();
const repositoryIdSchema = z.string().regex(/^dir_[A-Za-z0-9_-]{43}$/u);
const folderIdSchema = z.string().regex(/^folder_[A-Za-z0-9_-]{43}$/u);
const repositoryFolderQuerySchema = z.object({ directoryId: folderIdSchema.optional() }).strict();
const addManualRepositorySchema = z.object({ directoryId: folderIdSchema }).strict();
const repositoryParamsSchema = z.object({ repositoryId: repositoryIdSchema }).strict();
const contextFileIdSchema = z.string().regex(/^file_[A-Za-z0-9_-]{43}$/u);
const createSessionSchema = z.object({
  repositoryId: repositoryIdSchema,
  command: z.literal('codex'),
}).strict();
const sessionParamsSchema = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) }).strict();
const createViewerSchema = z.object({ repositoryId: repositoryIdSchema }).strict();
const codexChatSchema = z.object({
  repositoryId: repositoryIdSchema,
  conversationId: z.uuid().optional(),
  contextFileIds: z.array(contextFileIdSchema).max(8).refine(
    fileIds => new Set(fileIds).size === fileIds.length,
    'context file IDs must be unique',
  ).optional(),
  message: z.string().trim().min(1).max(20_000),
}).strict();
const emptyBodySchema = z.object({}).strict();
const noBodySchema = z.undefined();

function openVSCodeWebUrl(config: AppConfig, repositoryRealPath: string): string {
  const url = new URL(config.publicBaseUrl);
  url.pathname = '/openvscode/';
  url.search = '';
  url.searchParams.set('folder', repositoryRealPath);
  url.hash = '';
  return url.toString();
}

async function proxyZellijHtml(destination: string, cookie: string | undefined) {
  const url = new URL(destination);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<{ statusCode: number; headers: Record<string, string | string[]>; body: string }>((resolve, reject) => {
    const upstream = request(url, {
      headers: cookie ? { cookie } : undefined,
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
          body: Buffer.concat(chunks).toString('utf8').replace('<base href="/" />', '<base href="/zellij/" />'),
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
  const app = (https
    ? Fastify({ logger, https })
    : Fastify({ logger })) as unknown as FastifyInstance;
  await app.register(fastifyReplyFrom, {
    base: `http://127.0.0.1:${config.viewerPortRange.start}`,
    disableRequestLogging: true,
  });
  const zellijProxyUpstream = dependencies.zellijWebUpstreamUrl ?? `https://127.0.0.1:${config.zellijWebPort}`;
  await app.register(fastifyHttpProxy, {
    upstream: zellijProxyUpstream,
    prefix: '/zellij',
    rewritePrefix: '',
    websocket: true,
    disableRequestLogging: true,
    undici: { connect: { rejectUnauthorized: false } },
    wsClientOptions: { rejectUnauthorized: false },
    handler: async (request, reply, destination, options) => {
      const pathname = new URL(request.raw.url ?? '/', config.publicBaseUrl).pathname;
      if (request.method === 'GET' && (/^\/zellij\/?$/u.test(pathname) || /^\/zellij\/[A-Za-z0-9_-]{1,64}\/?$/u.test(pathname))) {
        const response = await proxyZellijHtml(new URL(destination, `${zellijProxyUpstream}/`).toString(), request.headers.cookie);
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
    new URL('/zellij/', config.publicBaseUrl).toString().replace(/\/$/u, ''),
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
    const sessionBaseNameCounts = new Map<string, number>();
    for (const entry of listing.entries) {
      const baseName = repositorySessionName(entry.name, entry.id);
      sessionBaseNameCounts.set(baseName, (sessionBaseNameCounts.get(baseName) ?? 0) + 1);
    }
    const entries = await Promise.all(listing.entries.map(async entry => {
      const repository = await repositoryService.resolveRepository(entry.id);
      const viewer = viewerManager.currentFor(entry.id);
      const baseName = repositorySessionName(entry.name, entry.id);
      const sessionName = repositorySessionName(entry.name, entry.id, (sessionBaseNameCounts.get(baseName) ?? 0) > 1);
      const session = sessionsByName.get(sessionName);
      return {
        ...entry,
        openVSCodeUrl: openVSCodeWebUrl(config, repository.realPath),
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
    return repositoryService.listFolders(query.directoryId);
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
    const baseName = repositorySessionName(entry.name, entry.id);
    const duplicateName = listing.entries.filter(candidate => (
      repositorySessionName(candidate.name, candidate.id) === baseName
    )).length > 1;
    const repository = await repositoryService.resolveRepository(body.repositoryId);
    const result = await zellijService.ensureRepositorySession(
      repositorySessionName(entry.name, entry.id, duplicateName),
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
  app.get('/api/codex/status', async () => codexChatService.status());
  app.get('/api/codex/appearance', async () => config.codexChatAppearance);
  app.get('/api/codex/conversations/:repositoryId', async request => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Codex chat is not ready');
    const params = repositoryParamsSchema.parse(request.params);
    await repositoryService.resolveRepository(params.repositoryId);
    return { conversation: codexChatService.getConversation(params.repositoryId) };
  });
  app.get('/api/codex/conversations/:repositoryId/events', async (request, reply) => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Codex chat is not ready');
    const params = repositoryParamsSchema.parse(request.params);
    await repositoryService.resolveRepository(params.repositoryId);
    if (!codexChatService.subscribe) {
      return { conversation: codexChatService.getConversation(params.repositoryId) };
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    const send = (event: CodexConversationStreamEvent) => {
      if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = codexChatService.subscribe(params.repositoryId, send);
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    response.once('close', cleanup);
  });
  app.post('/api/codex/messages', async (request, reply) => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Codex chat is not ready');
    requireSameOrigin(request.headers.origin);
    const body = codexChatSchema.parse(request.body);
    const repository = await repositoryService.resolveRepository(body.repositoryId);
    const codexStatus = await codexChatService.status();
    if (!codexStatus.available) {
      throw new ApiError(503, 'CODEX_CLI_UNAVAILABLE', 'Codex CLI is not available on the server');
    }
    const contextFiles = await repositoryService.resolveContextFiles(
      body.repositoryId,
      body.contextFileIds ?? [],
    );
    const execution = codexChatService.send({
      repositoryId: body.repositoryId,
      repositoryRealPath: repository.realPath,
      ...(body.conversationId ? { conversationId: body.conversationId } : {}),
      ...(contextFiles.length > 0 ? { contextFiles } : {}),
      message: body.message,
    });
    void execution.catch(error => {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        request.log.warn({ code: error instanceof ApiError ? error.code : 'CODEX_UNAVAILABLE' }, 'Codex background turn failed');
      }
    });
    return reply.code(202).send({ conversation: codexChatService.getConversation(body.repositoryId) });
  });
  app.post('/api/codex/conversations/:repositoryId/stop', async (request, reply) => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Codex chat is not ready');
    requireSameOrigin(request.headers.origin);
    emptyBodySchema.parse(request.body ?? {});
    const params = repositoryParamsSchema.parse(request.params);
    await repositoryService.resolveRepository(params.repositoryId);
    codexChatService.stopConversation(params.repositoryId);
    return reply.code(202).send({ status: 'stopping' });
  });
  app.delete('/api/codex/conversations/:repositoryId', async (request, reply) => {
    if (!repositoryService) throw new ApiError(503, 'SERVICE_NOT_READY', 'Codex chat is not ready');
    requireSameOrigin(request.headers.origin);
    noBodySchema.parse(request.body);
    const params = repositoryParamsSchema.parse(request.params);
    await repositoryService.resolveRepository(params.repositoryId);
    await codexChatService.clearConversation(params.repositoryId);
    return reply.code(204).send();
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
      if (!managementPage && cookieViewerId && cookieViewerId === viewerManager.activeViewerId()) {
        return proxyViewerRequest(request, reply, viewerManager, cookieViewerId, `${requestUrl.pathname}${requestUrl.search}`);
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
