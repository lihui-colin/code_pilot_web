import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { ReadinessResult } from '../src/domain/types.js';
import type { ZellijAdapter } from '../src/services/zellij-service.js';
import { repositorySessionName } from '../src/services/zellij-service.js';
import { ViewerManager, type ViewerProcessAdapter } from '../src/services/viewer-manager.js';
import { ZellijTokenService } from '../src/services/zellij-token-service.js';
import { createTestConfig } from './helpers.js';

const temporaryDirectories: string[] = [];
const ready: ReadinessResult = {
  status: 'ready',
  checks: { workspaceRoot: true, state: true, directoryIdSecret: true, node: true, zellij: true, codeViewer: true },
};

async function testApp(adapter: ZellijAdapter = { listSessions: async () => '' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-app-'));
  temporaryDirectories.push(root);
  return createApp(createTestConfig(root), {
    readiness: ready,
    directoryIdSecret: Buffer.from('route test secret'),
    zellijAdapter: adapter,
    staticRoot: false,
    https: false,
    logger: false,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('MVP-1 routes', () => {
  it('returns only the configured Codex chat appearance fields', async () => {
    const app = await testApp();

    const response = await app.inject({ method: 'GET', url: '/api/codex/appearance' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      fontSize: 16,
    });
    await app.close();
  });

  it('starts a background Codex conversation for a validated repository ID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-codex-route-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    let receivedPath = '';
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      codexChatService: {
        status: async () => ({ available: true, version: 'codex-cli 0.146.0', mode: 'yolo' }),
        send: async turn => {
          receivedPath = turn.repositoryRealPath;
        },
        getConversation: () => null,
        getRunningRepositoryIds: () => [],
        clearConversation: () => undefined,
        stopConversation: () => undefined,
        close: async () => undefined,
      },
      staticRoot: false,
      https: false,
      logger: false,
    });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const repositoryId = listing.json().entries[0].id as string;

    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/messages',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { repositoryId, message: 'Hello' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ conversation: null });
    expect(receivedPath).toBe(path.join(root, 'repository'));
    await app.close();
  });

  it('adds only server-issued repository files to the Codex turn context', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-codex-context-route-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    await mkdir(path.join(root, 'repository', 'src'));
    await writeFile(path.join(root, 'repository', 'src', 'context.ts'), 'export const context = true;\n');
    let receivedContext: Array<{ relativePath: string; content: string }> | undefined;
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      codexChatService: {
        status: async () => ({ available: true, version: 'codex-cli 0.146.0', mode: 'yolo' }),
        send: async turn => {
          receivedContext = turn.contextFiles;
        },
        getConversation: () => null,
        clearConversation: () => undefined,
        stopConversation: () => undefined,
        close: async () => undefined,
      },
      staticRoot: false,
      https: false,
      logger: false,
    });
    const repositories = await app.inject({ method: 'GET', url: '/api/repositories' });
    const repositoryId = repositories.json().entries[0].id as string;
    const files = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/files` });
    expect(files.statusCode).toBe(200);
    expect(files.json().files[0]).toMatchObject({ relativePath: 'src/context.ts' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/messages',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: {
        repositoryId,
        contextFileIds: [files.json().files[0].id],
        message: 'Use the attached file',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(receivedContext).toEqual([{
      relativePath: 'src/context.ts',
      content: 'export const context = true;\n',
    }]);
    await app.close();
  });

  it('gets, stops, and clears a repository Codex conversation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-codex-lifecycle-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    let stoppedRepositoryId = '';
    let clearedRepositoryId = '';
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      codexChatService: {
        status: async () => ({ available: true, version: 'codex-cli 0.146.0', mode: 'yolo' }),
        send: async () => undefined,
        getConversation: repositoryId => ({
          repositoryId,
          conversationId: '123e4567-e89b-42d3-a456-426614174000',
          messages: [{ id: 'user-1', role: 'user', content: 'Hello' }],
          status: 'running',
          error: null,
          updatedAt: '2026-08-04T00:00:00.000Z',
        }),
        stopConversation: repositoryId => { stoppedRepositoryId = repositoryId; },
        clearConversation: repositoryId => { clearedRepositoryId = repositoryId; },
        close: async () => undefined,
      },
      staticRoot: false,
      https: false,
      logger: false,
    });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const repositoryId = listing.json().entries[0].id as string;

    const snapshot = await app.inject({ method: 'GET', url: `/api/codex/conversations/${repositoryId}` });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().conversation).toMatchObject({ repositoryId, status: 'running' });

    const stopped = await app.inject({
      method: 'POST',
      url: `/api/codex/conversations/${repositoryId}/stop`,
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: {},
    });
    expect(stopped.statusCode).toBe(202);
    expect(stoppedRepositoryId).toBe(repositoryId);

    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/codex/conversations/${repositoryId}`,
      headers: { origin: 'https://192.0.2.10:8024' },
    });
    expect(cleared.statusCode).toBe(204);
    expect(clearedRepositoryId).toBe(repositoryId);
    await app.close();
  });

  it('streams sanitized Codex snapshots over the repository SSE endpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-codex-sse-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    let unsubscribeCalls = 0;
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      codexChatService: {
        status: async () => ({ available: true, version: 'codex-cli 0.146.0', mode: 'yolo' }),
        send: async () => undefined,
        getConversation: () => null,
        getRunningRepositoryIds: () => [],
        subscribe: (repositoryId, listener) => {
          listener({
            conversation: {
              repositoryId,
              conversationId: '123e4567-e89b-42d3-a456-426614174000',
              messages: [{ id: 'assistant-live', role: 'assistant', content: '实时输出' }],
              status: 'running',
              error: null,
              updatedAt: '2026-08-04T00:00:00.000Z',
            },
          });
          return () => { unsubscribeCalls += 1; };
        },
        clearConversation: () => undefined,
        stopConversation: () => undefined,
        close: async () => undefined,
      },
      staticRoot: false,
      https: false,
      logger: false,
    });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const repositoryId = listing.json().entries[0].id as string;
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/codex/conversations/${repositoryId}/events`);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    for (let attempt = 0; attempt < 20 && unsubscribeCalls === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(new TextDecoder().decode(chunk.value)).toContain('实时输出');
    expect(unsubscribeCalls).toBe(1);
    const reentry = await fetch(`${address}/api/codex/conversations/${repositoryId}`);
    expect(reentry.status).toBe(200);
    await app.close();
  });

  it('reports repositories with active Codex turns', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-codex-activity-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      codexChatService: {
        status: async () => ({ available: true, version: 'codex-cli 0.146.0', mode: 'yolo' }),
        send: async () => undefined,
        getConversation: () => null,
        getRunningRepositoryIds: () => [`dir_${'a'.repeat(43)}`],
        clearConversation: () => undefined,
        stopConversation: () => undefined,
        close: async () => undefined,
      },
      staticRoot: false,
      https: false,
      logger: false,
    });

    const response = await app.inject({ method: 'GET', url: '/api/codex/activity' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runningRepositoryIds: [`dir_${'a'.repeat(43)}`] });
    await app.close();
  });

  it('reports Codex CLI availability and blocks chat when it is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-codex-unavailable-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    let sends = 0;
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      codexChatService: {
        status: async () => ({ available: false, version: null, mode: 'yolo' }),
        send: async () => { sends += 1; },
        getConversation: () => null,
        clearConversation: () => undefined,
        stopConversation: () => undefined,
        close: async () => undefined,
      },
      staticRoot: false,
      https: false,
      logger: false,
    });

    const status = await app.inject({ method: 'GET', url: '/api/codex/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ available: false, version: null, mode: 'yolo' });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const repositoryId = listing.json().entries[0].id as string;
    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/messages',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { repositoryId, message: 'Hello' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: 'CODEX_CLI_UNAVAILABLE',
      message: 'Codex CLI is not available on the server',
    });
    expect(sends).toBe(0);
    await app.close();
  });

  it('rejects paths, commands, and extra fields in Codex chat requests', async () => {
    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/messages',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: {
        repositoryId: `dir_${'a'.repeat(43)}`,
        message: 'Hello',
        path: '/etc',
        command: 'bash',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    await app.close();
  });

  it('accepts a same-origin request to restart the managed backend services', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-restart-route-'));
    temporaryDirectories.push(root);
    let restarts = 0;
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      serviceRestarter: { restart: async () => { restarts += 1; } },
      staticRoot: false,
      https: false,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/services/restart',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'restarting' });
    expect(restarts).toBe(1);
    await app.close();
  });

  it('rejects cross-origin service restart requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-restart-origin-'));
    temporaryDirectories.push(root);
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      serviceRestarter: { restart: async () => undefined },
      staticRoot: false,
      https: false,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/services/restart',
      headers: { origin: 'https://attacker.example' },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    await app.close();
  });

  it('rejects service restart parameters from the frontend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-restart-schema-'));
    temporaryDirectories.push(root);
    let restarts = 0;
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      serviceRestarter: { restart: async () => { restarts += 1; } },
      staticRoot: false,
      https: false,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/services/restart',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { port: 22, command: 'kill -9' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(restarts).toBe(0);
    await app.close();
  });

  it('allows API requests without user credentials', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['www-authenticate']).toBeUndefined();
    await app.close();
  });

  it('health does not invoke external tools', async () => {
    let calls = 0;
    const app = await testApp({ listSessions: async () => { calls += 1; return ''; } });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(calls).toBe(0);
    await app.close();
  });

  it('returns sanitized session data', async () => {
    const app = await testApp({ listSessions: async () => 'beta\nbad name\nalpha\n' });
    const sessions = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().sessions.map((session: { name: string }) => session.name)).toEqual(['alpha', 'beta']);
    await app.close();
  });

  it('rejects arbitrary repository query fields', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/api/repositories?path=/etc' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    await app.close();
  });

  it('rejects recursive repository navigation parameters', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: `/api/repositories?parentId=dir_${'a'.repeat(43)}` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    await app.close();
  });

  it('browses server folders by opaque ID and adds or removes an external Git repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-open-folder-route-'));
    temporaryDirectories.push(root);
    const workspace = path.join(root, 'workspace');
    const external = path.join(root, 'external-repository');
    await mkdir(workspace);
    await mkdir(path.join(external, '.git'), { recursive: true });
    const persisted: string[][] = [];
    const app = await createApp(createTestConfig(workspace), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      persistManualRepositoryPaths: async paths => { persisted.push([...paths]); },
      staticRoot: false,
      https: false,
      logger: false,
    });

    let folderListing = (await app.inject({ method: 'GET', url: '/api/repository-folders' })).json();
    for (const segment of external.split(path.sep).filter(Boolean)) {
      const child = folderListing.entries.find((entry: { name: string }) => entry.name === segment);
      expect(child).toBeDefined();
      folderListing = (await app.inject({
        method: 'GET',
        url: `/api/repository-folders?directoryId=${encodeURIComponent(child.id)}`,
      })).json();
    }
    const added = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { directoryId: folderListing.current.id },
    });
    expect(added.statusCode).toBe(201);
    expect(persisted).toEqual([[external]]);

    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const manualEntry = listing.json().entries.find((entry: { source: string }) => entry.source === 'manual');
    expect(manualEntry).toMatchObject({ name: 'external-repository', relativePath: external, markers: ['git'] });
    expect(new URL(manualEntry.openVSCodeUrl).searchParams.get('folder')).toBe(external);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/repositories/${manualEntry.id}`,
      headers: { origin: 'https://192.0.2.10:8024' },
    });
    expect(removed.statusCode).toBe(204);
    expect(persisted.at(-1)).toEqual([]);
    await app.close();
  });

  it('cleans repository components before removing a manual repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-remove-cleanup-route-'));
    temporaryDirectories.push(root);
    const workspace = path.join(root, 'workspace');
    const external = path.join(root, 'external-repository');
    await mkdir(workspace);
    await mkdir(path.join(external, '.git'), { recursive: true });
    let sessions = '';
    const zellijDelete = vi.fn(async (arguments_: string[]) => { sessions = sessions.replace(`${arguments_[2]}\n`, ''); });
    const viewerStop = vi.fn(async () => undefined);
    const repositoryId = `dir_${'a'.repeat(43)}`;
    const cleanupRepository = vi.fn(async () => undefined);
    const viewerManager = new ViewerManager({
      start: async (_path, port) => ({
        pid: 321,
        output: () => `GDP_LISTEN_URL=http://127.0.0.1:${port}/\n`,
        exited: () => false,
        waitForExit: async () => undefined,
      }),
      healthy: async () => true,
      stop: viewerStop,
    }, 8022, 'https://192.0.2.10:8024');
    const app = await createApp(createTestConfig(workspace), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      manualRepositoryPaths: [external],
      zellijAdapter: {
        listSessions: async () => sessions,
        createSession: async arguments_ => { sessions = `${arguments_[4]}\n`; },
        deleteSession: zellijDelete,
      },
      viewerManager,
      codexChatService: {
        status: async () => ({ available: true, version: 'codex-cli 0.146.0', mode: 'yolo' }),
        send: async () => undefined,
        getConversation: () => null,
        clearConversation: async () => undefined,
        cleanupRepository,
        stopConversation: () => undefined,
        close: async () => undefined,
      },
      staticRoot: false,
      https: false,
      logger: false,
    });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const manualEntry = listing.json().entries.find((entry: { source: string }) => entry.source === 'manual');
    expect(manualEntry).toBeDefined();
    const id = manualEntry.id as string;
    const createdSession = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { repositoryId: id, command: 'codex' },
    });
    expect(createdSession.statusCode).toBe(201);
    await app.inject({
      method: 'POST',
      url: '/api/viewers',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { repositoryId: id },
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/repositories/${id}`,
      headers: { origin: 'https://192.0.2.10:8024' },
    });

    expect(removed.statusCode).toBe(204);
    expect(zellijDelete).toHaveBeenCalledTimes(1);
    expect(viewerStop).toHaveBeenCalledTimes(1);
    expect(cleanupRepository).toHaveBeenCalledWith(id);
    await app.close();
  });

  it('rejects execution actions for a manually selected non-Git directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-plain-folder-route-'));
    temporaryDirectories.push(root);
    const workspace = path.join(root, 'workspace');
    const plain = path.join(root, 'plain-directory');
    await mkdir(workspace);
    await mkdir(plain);
    const viewerStart = vi.fn(async () => {
      throw new Error('viewer must not start');
    });
    const app = await createApp(createTestConfig(workspace), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      manualRepositoryPaths: [plain],
      viewerManager: new ViewerManager({
        start: viewerStart,
        healthy: async () => true,
        stop: async () => undefined,
      }, 8022, 'https://192.0.2.10:8024'),
      staticRoot: false,
      https: false,
      logger: false,
    });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const entry = listing.json().entries.find((candidate: { source: string }) => candidate.source === 'manual');
    expect(entry).toMatchObject({ kind: 'directory', openVSCodeUrl: null });

    const response = await app.inject({
      method: 'POST',
      url: '/api/viewers',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { repositoryId: entry.id },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('NOT_A_REPOSITORY');
    expect(viewerStart).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not clean resources when repository removal targets a workspace entry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-workspace-remove-route-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, '.git'));
    const zellijDelete = vi.fn(async () => undefined);
    const viewerStop = vi.fn(async () => undefined);
    const cleanupRepository = vi.fn(async () => undefined);
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      zellijAdapter: { listSessions: async () => '', deleteSession: zellijDelete },
      viewerManager: new ViewerManager({
        start: async () => { throw new Error('not used'); },
        healthy: async () => true,
        stop: viewerStop,
      }, 8022, 'https://192.0.2.10:8024'),
      codexChatService: {
        status: async () => ({ available: true, version: 'codex-cli 0.146.0', mode: 'yolo' }),
        send: async () => undefined,
        getConversation: () => null,
        clearConversation: async () => undefined,
        cleanupRepository,
        stopConversation: () => undefined,
        close: async () => undefined,
      },
      staticRoot: false,
      https: false,
      logger: false,
    });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const repositoryId = listing.json().entries[0].id as string;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/repositories/${repositoryId}`,
      headers: { origin: 'https://192.0.2.10:8024' },
    });

    expect(response.statusCode).toBe(404);
    expect(zellijDelete).not.toHaveBeenCalled();
    expect(viewerStop).not.toHaveBeenCalled();
    expect(cleanupRepository).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not accept server paths in the folder picker API', async () => {
    const app = await testApp();
    const queryResponse = await app.inject({ method: 'GET', url: '/api/repository-folders?path=/etc' });
    const bodyResponse = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { path: '/etc' },
    });
    expect(queryResponse.statusCode).toBe(400);
    expect(bodyResponse.statusCode).toBe(400);
    await app.close();
  });

  it('accepts a relative initial directory for the folder picker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-initial-folder-route-'));
    temporaryDirectories.push(root);
    const relativePath = path.relative(path.parse(root).root, root);
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      staticRoot: false,
      https: false,
      logger: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/repository-folders?initialPath=${encodeURIComponent(relativePath)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().current.name).toBe(path.basename(root));
    expect(response.json().current.relativePath).toBe(relativePath.split(path.sep).join('/'));
    await app.close();
  });

  it('returns 503 readiness without leaking details', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-not-ready-'));
    temporaryDirectories.push(root);
    const app = await createApp(createTestConfig(root), {
      readiness: { ...ready, status: 'not_ready', checks: { ...ready.checks, codeViewer: false } },
      directoryIdSecret: null,
      staticRoot: false,
      https: false,
      logger: false,
    });
    const response = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(root);
    await app.close();
  });

  it('creates a Zellij Session for a repository ID without accepting a path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-session-route-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    let sessions = '';
    const adapter: ZellijAdapter = {
      listSessions: async () => sessions,
      createSession: async arguments_ => { sessions = `${arguments_[4]}\n`; },
      deleteSession: async () => { sessions = ''; },
    };
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      zellijAdapter: adapter,
      staticRoot: false,
      https: false,
      logger: false,
    });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const repositoryEntry = listing.json().entries[0];
    const openVSCodeUrl = new URL(repositoryEntry.openVSCodeUrl);
    expect(openVSCodeUrl.origin).toBe('https://192.0.2.10:8024');
    expect(openVSCodeUrl.pathname).toBe('/openvscode/');
    expect(openVSCodeUrl.searchParams.get('folder')).toBe(path.join(root, 'repository'));
    const repositoryId = repositoryEntry.id as string;
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { repositoryId, command: 'codex' },
    });
    expect(response.statusCode).toBe(201);
    const sessionName = repositorySessionName('repository', repositoryId);
    expect(response.json()).toMatchObject({ name: sessionName, origin: 'managed', relativePath: 'repository' });

    const listingWithSession = await app.inject({ method: 'GET', url: '/api/repositories' });
    expect(listingWithSession.json().entries[0].session).toMatchObject({
      name: sessionName,
      webUrl: `https://192.0.2.10:8024/zellij/open/${sessionName}`,
    });

    const reused = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { repositoryId, command: 'codex' },
    });
    expect(reused.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionName}`,
      headers: { origin: 'https://192.0.2.10:8024' },
    });
    expect(deleted.statusCode).toBe(204);
    expect(sessions).toBe('');
    await app.close();
  });

  it('starts code-viewer for a repository and returns its same-origin proxy URL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-viewer-route-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    const viewerAdapter: ViewerProcessAdapter = {
      start: async (_repositoryRealPath, port) => ({
        pid: 321,
        output: () => `GDP_LISTEN_URL=http://127.0.0.1:${port}/\n`,
        exited: () => false,
        waitForExit: async () => undefined,
      }),
      healthy: async () => true,
      stop: async () => undefined,
    };
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      viewerManager: new ViewerManager(viewerAdapter, 8022, 'https://192.0.2.10:8024'),
      staticRoot: false,
      https: false,
      logger: false,
    });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const repositoryId = listing.json().entries[0].id as string;
    const response = await app.inject({
      method: 'POST',
      url: '/api/viewers',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: { repositoryId },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      repositoryId,
      upstreamUrl: 'http://127.0.0.1:8022',
      webUrl: expect.stringMatching(/^https:\/\/192\.0\.2\.10:8024\/viewer\/viewer_/u),
    });
    await app.close();
  });

  it('serves Codex Chat from the management SPA even when a viewer cookie is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-codex-route-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'static'), { recursive: true });
    await writeFile(path.join(root, 'static/index.html'), '<div id="management-spa">CodePilot Web</div>');
    const viewerId = `viewer_${'v'.repeat(22)}`;
    const viewerAdapter: ViewerProcessAdapter = {
      start: async () => ({
        pid: 321,
        output: () => 'GDP_LISTEN_URL=http://127.0.0.1:8022/\n',
        exited: () => false,
        waitForExit: async () => undefined,
      }),
      healthy: async () => true,
      stop: async () => undefined,
    };
    const viewerManager = new ViewerManager(viewerAdapter, 8022, 'https://192.0.2.10:8024');
    Object.assign(viewerManager, {
      active: {
        instance: {
          id: viewerId,
          repositoryId: `dir_${'a'.repeat(43)}`,
          pid: 321,
          upstreamUrl: 'http://127.0.0.1:8022',
          webUrl: `https://192.0.2.10:8024/viewer/${viewerId}/`,
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
          status: 'running',
        },
        process: {
          pid: 321,
          output: () => '',
          exited: () => false,
          waitForExit: async () => undefined,
        },
      },
    });
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      viewerManager,
      staticRoot: path.join(root, 'static'),
      https: false,
      logger: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/codex-chat?repositoryId=dir_${'a'.repeat(43)}`,
      headers: { cookie: `codepilot_web_viewer=${viewerId}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('management-spa');
    await app.close();
  });

  it('returns, regenerates, and deletes the configured Zellij Web token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-token-route-'));
    temporaryDirectories.push(root);
    const initialToken = { name: 'codepilot-web-test', value: '123e4567-e89b-42d3-a456-426614174000' };
    const persist = async () => undefined;
    const tokenService = new ZellijTokenService('/managed/zellij', '/managed/tokens.db', initialToken, {
      persist,
      createToken: async () => ({
        name: 'codepilot-web-new',
        value: '123e4567-e89b-42d3-a456-426614174001',
      }),
      run: async () => '',
    });
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      zellijTokenService: tokenService,
      staticRoot: false,
      https: false,
      logger: false,
    });

    const initial = await app.inject({ method: 'GET', url: '/api/zellij-token' });
    expect(initial.json()).toEqual({ token: initialToken });
    const regenerated = await app.inject({
      method: 'POST',
      url: '/api/zellij-token/regenerate',
      headers: { origin: 'https://192.0.2.10:8024' },
      payload: {},
    });
    expect(regenerated.statusCode).toBe(201);
    expect(regenerated.json().token).toEqual({
      name: 'codepilot-web-new',
      value: '123e4567-e89b-42d3-a456-426614174001',
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/zellij-token',
      headers: { origin: 'https://192.0.2.10:8024' },
    });
    expect(deleted.statusCode).toBe(204);
    expect(tokenService.get()).toBeNull();
    await app.close();
  });
});
