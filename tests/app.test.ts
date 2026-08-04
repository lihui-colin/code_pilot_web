import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  checks: { workspaceRoot: true, directoryIdSecret: true, node: true, zellij: true, codeViewer: true },
};

async function testApp(adapter: ZellijAdapter = { listSessions: async () => '' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-app-'));
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
  it('streams a Codex conversation for a validated repository ID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-codex-route-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    let receivedPath = '';
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      codexChatService: {
        status: async () => ({ available: true, version: 'codex-cli 0.146.0' }),
        send: async turn => {
          receivedPath = turn.repositoryRealPath;
          turn.onEvent({ type: 'conversation', conversationId: '123e4567-e89b-42d3-a456-426614174000' });
          turn.onEvent({ type: 'assistant_delta', delta: 'Hello from Codex' });
          turn.onEvent({ type: 'done' });
        },
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

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(response.body.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { type: 'conversation', conversationId: '123e4567-e89b-42d3-a456-426614174000' },
      { type: 'assistant_delta', delta: 'Hello from Codex' },
      { type: 'done' },
    ]);
    expect(receivedPath).toBe(path.join(root, 'repository'));
    await app.close();
  });

  it('adds only server-issued repository files to the Codex turn context', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-codex-context-route-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    await mkdir(path.join(root, 'repository', 'src'));
    await writeFile(path.join(root, 'repository', 'src', 'context.ts'), 'export const context = true;\n');
    let receivedContext: Array<{ relativePath: string; content: string }> | undefined;
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      codexChatService: {
        status: async () => ({ available: true, version: 'codex-cli 0.146.0' }),
        send: async turn => {
          receivedContext = turn.contextFiles;
          turn.onEvent({ type: 'conversation', conversationId: '123e4567-e89b-42d3-a456-426614174000' });
          turn.onEvent({ type: 'done' });
        },
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

    expect(response.statusCode).toBe(200);
    expect(receivedContext).toEqual([{
      relativePath: 'src/context.ts',
      content: 'export const context = true;\n',
    }]);
    await app.close();
  });

  it('reports Codex CLI availability and blocks chat when it is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-codex-unavailable-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    let sends = 0;
    const app = await createApp(createTestConfig(root), {
      readiness: ready,
      directoryIdSecret: Buffer.from('route test secret'),
      codexChatService: {
        status: async () => ({ available: false, version: null }),
        send: async () => { sends += 1; },
        close: async () => undefined,
      },
      staticRoot: false,
      https: false,
      logger: false,
    });

    const status = await app.inject({ method: 'GET', url: '/api/codex/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ available: false, version: null });
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-restart-route-'));
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-restart-origin-'));
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-restart-schema-'));
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-open-folder-route-'));
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
    expect(new URL(manualEntry.openVsCodeUrl).searchParams.get('folder')).toBe(external);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/repositories/${manualEntry.id}`,
      headers: { origin: 'https://192.0.2.10:8024' },
    });
    expect(removed.statusCode).toBe(204);
    expect(persisted.at(-1)).toEqual([]);
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

  it('returns 503 readiness without leaking details', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-not-ready-'));
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-session-route-'));
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
    const openVsCodeUrl = new URL(repositoryEntry.openVsCodeUrl);
    expect(openVsCodeUrl.origin).toBe('https://192.0.2.10:8024');
    expect(openVsCodeUrl.pathname).toBe('/openvscode/');
    expect(openVsCodeUrl.searchParams.get('folder')).toBe(path.join(root, 'repository'));
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
      webUrl: `https://192.0.2.10:8021/${sessionName}`,
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-viewer-route-'));
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

  it('returns, regenerates, and deletes the configured Zellij Web token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-token-route-'));
    temporaryDirectories.push(root);
    const initialToken = { name: 'terminal-web-test', value: '123e4567-e89b-42d3-a456-426614174000' };
    const persist = async () => undefined;
    const tokenService = new ZellijTokenService('/managed/zellij', '/managed/tokens.db', initialToken, {
      persist,
      createToken: async () => ({
        name: 'terminal-web-new',
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
      name: 'terminal-web-new',
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
