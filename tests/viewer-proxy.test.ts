import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ReadinessResult } from '../src/domain/types.js';
import { ViewerManager } from '../src/services/viewer-manager.js';
import { createTestConfig } from './helpers.js';

const temporaryDirectories: string[] = [];
const ready: ReadinessResult = {
  status: 'ready',
  checks: { workspaceRoot: true, state: true, directoryIdSecret: true, node: true, zellij: true, codeViewer: true },
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('CodeReviewer same-origin proxy', () => {
  it('sets the entry title from the repository name and preserves non-HTML responses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codepilot-web-viewer-title-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    await mkdir(path.join(root, 'static'), { recursive: true });
    await writeFile(path.join(root, 'static/index.html'), '<div>management</div>');

    const upstream = createServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><head><title>Code Viewer</title></head><body>reviewer</body></html>');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: request.url }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const viewerManager = new ViewerManager({
      start: async () => ({
        pid: 321,
        output: () => `GDP_LISTEN_URL=http://127.0.0.1:${upstreamPort}/\n`,
        exited: () => false,
        waitForExit: async () => undefined,
      }),
      healthy: async () => true,
      stop: async () => undefined,
    }, upstreamPort, 'https://192.0.2.10:8024');
    const config = createTestConfig(root);
    config.viewerPortRange = { start: upstreamPort, end: upstreamPort };
    const app = await createApp(config, {
      readiness: ready,
      directoryIdSecret: Buffer.from('viewer title test secret'),
      viewerManager,
      staticRoot: path.join(root, 'static'),
      https: false,
      logger: false,
    });
    const listing = await app.inject({ method: 'GET', url: '/api/repositories' });
    const repositoryId = listing.json().entries[0].id as string;
    const { instance } = await viewerManager.create(repositoryId, path.join(root, 'repository'));

    try {
      const entry = await app.inject({ method: 'GET', url: `/viewer/${instance.id}/` });
      expect(entry.statusCode).toBe(200);
      expect(entry.body).toContain('<title>repository - CodeReviewer</title>');
      expect(entry.body).toContain('<script src="/codepilot-html-title.js"></script>');
      expect(entry.body).not.toContain('<script>(()=>');

      const json = await app.inject({ method: 'GET', url: `/viewer/${instance.id}/probe` });
      expect(json.json()).toEqual({ path: '/probe' });
    } finally {
      await app.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
