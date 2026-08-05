import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { CodexConversationStreamEvent } from '../domain/types.js';
import { ApiError } from '../errors.js';
import type { CodexChatServiceLike } from '../services/codex-chat-service.js';
import type { RepositoryService } from '../services/repository-service.js';
import { emptyBodySchema, noBodySchema, repositoryIdSchema, repositoryParamsSchema } from './schemas.js';

const contextFileIdSchema = z.string().regex(/^file_[A-Za-z0-9_-]{43}$/u);
const codexChatSchema = z.object({
  repositoryId: repositoryIdSchema,
  conversationId: z.uuid().optional(),
  contextFileIds: z.array(contextFileIdSchema).max(8).refine(
    fileIds => new Set(fileIds).size === fileIds.length,
    'context file IDs must be unique',
  ).optional(),
  message: z.string().trim().min(1).max(20_000),
}).strict();
interface CodexRouteDependencies {
  repositoryService: RepositoryService | null;
  codexChatService: CodexChatServiceLike;
  appearance: AppConfig['codexChatAppearance'];
  requireSameOrigin(origin: string | undefined): void;
}

function requireRepositoryService(service: RepositoryService | null): RepositoryService {
  if (!service) throw new ApiError(503, 'SERVICE_NOT_READY', 'Codex chat is not ready');
  return service;
}

export function registerCodexRoutes(app: FastifyInstance, dependencies: CodexRouteDependencies): void {
  const { codexChatService, requireSameOrigin } = dependencies;
  const repositoryService = () => requireRepositoryService(dependencies.repositoryService);

  app.get('/api/codex/status', async () => codexChatService.status());
  app.get('/api/codex/appearance', async () => dependencies.appearance);
  app.get('/api/codex/activity', async () => ({
    runningRepositoryIds: codexChatService.getRunningRepositoryIds?.() ?? [],
  }));
  app.get('/api/codex/conversations/:repositoryId', async request => {
    const params = repositoryParamsSchema.parse(request.params);
    const repository = await repositoryService().resolveRepository(params.repositoryId);
    await codexChatService.restoreConversation?.(params.repositoryId, repository.realPath);
    return { conversation: codexChatService.getConversation(params.repositoryId) };
  });
  app.get('/api/codex/conversations/:repositoryId/events', async (request, reply) => {
    const params = repositoryParamsSchema.parse(request.params);
    const repository = await repositoryService().resolveRepository(params.repositoryId);
    await codexChatService.restoreConversation?.(params.repositoryId, repository.realPath);
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
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribe = undefined;
      response.off('close', cleanup);
      response.off('error', cleanup);
      request.raw.off('aborted', cleanup);
    };
    response.once('close', cleanup);
    response.once('error', cleanup);
    request.raw.once('aborted', cleanup);

    const releaseSubscription = codexChatService.subscribe(params.repositoryId, send);
    if (cleanedUp) {
      releaseSubscription();
      return;
    }
    unsubscribe = releaseSubscription;
    heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref();
  });
  app.post('/api/codex/messages', async (request, reply) => {
    requireSameOrigin(request.headers.origin);
    const body = codexChatSchema.parse(request.body);
    const repositories = repositoryService();
    const repository = await repositories.resolveRepository(body.repositoryId);
    if (body.conversationId) {
      await codexChatService.restoreConversation?.(body.repositoryId, repository.realPath);
    }
    if (!(await codexChatService.status()).available) {
      throw new ApiError(503, 'CODEX_CLI_UNAVAILABLE', 'Codex CLI is not available on the server');
    }
    const contextFiles = await repositories.resolveContextFiles(body.repositoryId, body.contextFileIds ?? []);
    const execution = codexChatService.send({
      repositoryId: body.repositoryId,
      repositoryRealPath: repository.realPath,
      ...(body.conversationId ? { conversationId: body.conversationId } : {}),
      ...(contextFiles.length > 0 ? { contextFiles } : {}),
      message: body.message,
    });
    void execution.catch(error => {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        request.log.warn(
          { code: error instanceof ApiError ? error.code : 'CODEX_UNAVAILABLE' },
          'Codex background turn failed',
        );
      }
    });
    return reply.code(202).send({ conversation: codexChatService.getConversation(body.repositoryId) });
  });
  app.post('/api/codex/conversations/:repositoryId/stop', async (request, reply) => {
    requireSameOrigin(request.headers.origin);
    emptyBodySchema.parse(request.body ?? {});
    const params = repositoryParamsSchema.parse(request.params);
    await repositoryService().resolveRepository(params.repositoryId);
    codexChatService.stopConversation(params.repositoryId);
    return reply.code(202).send({ status: 'stopping' });
  });
  app.delete('/api/codex/conversations/:repositoryId', async (request, reply) => {
    requireSameOrigin(request.headers.origin);
    noBodySchema.parse(request.body);
    const params = repositoryParamsSchema.parse(request.params);
    await repositoryService().resolveRepository(params.repositoryId);
    await codexChatService.clearConversation(params.repositoryId);
    return reply.code(204).send();
  });
}
