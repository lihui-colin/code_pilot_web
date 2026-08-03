import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyReplyFrom from '@fastify/reply-from';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import type { AppConfig } from './config.js';
import type { ReadinessResult } from './domain/types.js';
import { ApiError } from './errors.js';
import { RepositoryService } from './services/repository-service.js';
import { SpawnViewerProcessAdapter, ViewerManager } from './services/viewer-manager.js';
import { proxyViewerRequest, viewerIdFromCookie } from './services/viewer-proxy.js';
import { ExecFileZellijAdapter, repositorySessionName, ZellijService } from './services/zellij-service.js';
import type { ZellijTokenService } from './services/zellij-token-service.js';

const repositoryQuerySchema = z.object({}).strict();
const repositoryIdSchema = z.string().regex(/^dir_[A-Za-z0-9_-]{43}$/u);
const createSessionSchema = z.object({
  repositoryId: repositoryIdSchema,
  command: z.literal('codex'),
}).strict();
const sessionParamsSchema = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) }).strict();
const createViewerSchema = z.object({ repositoryId: repositoryIdSchema }).strict();
const emptyBodySchema = z.object({}).strict();
const noBodySchema = z.undefined();

export interface AppDependencies {
  readiness: ReadinessResult;
  directoryIdSecret: Buffer | null;
  zellijExecutablePath?: string;
  codeViewerExecutablePath?: string;
  zellijAdapter?: ConstructorParameters<typeof ZellijService>[0];
  viewerManager?: ViewerManager;
  zellijTokenService?: ZellijTokenService;
  staticRoot?: string | false;
  logger?: boolean;
}

export async function createApp(config: AppConfig, dependencies: AppDependencies) {
  const logger = dependencies.logger ?? true;
  const app = Fastify({ logger }) as FastifyInstance;
  await app.register(fastifyReplyFrom, {
    base: `http://127.0.0.1:${config.viewerPortRange.start}`,
    disableRequestLogging: true,
  });
  const repositoryService = dependencies.directoryIdSecret
    ? new RepositoryService(config.workspaceRootRealPath, dependencies.directoryIdSecret, config.projectMarkers, app.log)
    : null;
  const zellijService = new ZellijService(
    dependencies.zellijAdapter ?? new ExecFileZellijAdapter(dependencies.zellijExecutablePath),
    config.zellijWebBaseUrl,
    app.log,
    new Map(),
    path.join(path.dirname(config.directoryIdSecretFile), 'layouts'),
  );
  const viewerManager = dependencies.viewerManager ?? new ViewerManager(
    new SpawnViewerProcessAdapter(dependencies.codeViewerExecutablePath),
    config.viewerPortRange.start,
    config.publicBaseUrl,
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
    return {
      ...listing,
      entries: listing.entries.map(entry => {
        const viewer = viewerManager.currentFor(entry.id);
        const baseName = repositorySessionName(entry.name, entry.id);
        const sessionName = repositorySessionName(entry.name, entry.id, (sessionBaseNameCounts.get(baseName) ?? 0) > 1);
        const session = sessionsByName.get(sessionName);
        return {
          ...entry,
          viewer: viewer ? { id: viewer.id, status: viewer.status, webUrl: viewer.webUrl } : null,
          session: session ? { name: session.name, status: session.status, webUrl: session.webUrl } : null,
        };
      }),
    };
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
  app.post('/api/zellij-token/regenerate', async (request, reply) => {
    requireSameOrigin(request.headers.origin);
    emptyBodySchema.parse(request.body ?? {});
    if (!dependencies.zellijTokenService) {
      throw new ApiError(503, 'SERVICE_NOT_READY', 'Zellij Web token management is not ready');
    }
    const token = await dependencies.zellijTokenService.regenerate();
    await reply.code(201).send({ token });
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
      const cookieViewerId = viewerIdFromCookie(request.headers.cookie);
      if (requestUrl.pathname !== '/' && cookieViewerId && cookieViewerId === viewerManager.activeViewerId()) {
        return proxyViewerRequest(request, reply, viewerManager, cookieViewerId, `${requestUrl.pathname}${requestUrl.search}`);
      }
      if (request.method === 'GET') {
        await reply.sendFile('index.html');
        return;
      }
      await reply.code(404).send();
    });
  }

  app.addHook('onClose', async () => viewerManager.close());

  return app;
}
