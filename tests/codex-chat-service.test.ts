import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexChatService,
  SpawnCodexAppServerAdapter,
  type CodexAppServerProtocolMessage,
  type CodexExecutionRequest,
  type CodexInteractiveControl,
  type CodexProcessAdapter,
} from '../src/services/codex-chat-service.js';
import { ApiError } from '../src/errors.js';

const threadId = '123e4567-e89b-42d3-a456-426614174000';
const repositoryId = `dir_${'a'.repeat(43)}`;

function fakeChildProcess(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function appServerLine(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ method, params });
}

function adapterWith(lines: string[]): CodexProcessAdapter & { execute: ReturnType<typeof vi.fn> } {
  return {
    checkAvailability: vi.fn(async () => ({ available: true, version: 'codex-cli 0.146.0' })),
    execute: vi.fn(async (request: CodexExecutionRequest) => {
      for (const line of lines) request.onStdoutLine(line);
    }),
  };
}

function successfulLines(text = 'Done'): string[] {
  return [
    appServerLine('thread/started', { thread: { id: threadId } }),
    appServerLine('item/completed', {
      threadId,
      item: { id: 'answer', type: 'agentMessage', text },
    }),
    appServerLine('turn/completed', { threadId, turn: { status: 'completed' } }),
  ];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SpawnCodexAppServerAdapter', () => {
  it('reports only a recognized Codex CLI version as available', async () => {
    const validVersion = vi.fn(async () => 'codex-cli 0.146.0');
    const invalidVersion = vi.fn(async () => '/secret/path unexpected output');
    const unavailableVersion = vi.fn(async () => { throw new Error('spawn ENOENT /secret/path'); });

    await expect(new SpawnCodexAppServerAdapter('codex', undefined, undefined, validVersion).checkAvailability())
      .resolves.toEqual({ available: true, version: 'codex-cli 0.146.0' });
    await expect(new SpawnCodexAppServerAdapter('codex', undefined, undefined, invalidVersion).checkAvailability())
      .resolves.toEqual({ available: false, version: null });
    await expect(new SpawnCodexAppServerAdapter('codex', undefined, undefined, unavailableVersion).checkAvailability())
      .resolves.toEqual({ available: false, version: null });
    expect(validVersion).toHaveBeenCalledWith('codex');
  });

  it('drives a turn over stdio with fixed workspace-write policy', async () => {
    const child = fakeChildProcess(5151);
    const spawnProcess = vi.fn(() => child);
    const lines: string[] = [];
    const requests: Array<{ method: string; id?: number; params?: Record<string, unknown> }> = [];
    child.stdin.on('data', chunk => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line) as { method: string; id?: number; params?: Record<string, unknown> };
        requests.push(message);
        if (message.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        } else if (message.method === 'thread/start') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: threadId } } })}\n`);
        } else if (message.method === 'turn/start') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } })}\n`);
          child.stdout.write(`${appServerLine('item/agentMessage/delta', {
            threadId, turnId: 'turn-1', itemId: 'item-1', delta: '实时输出',
          })}\n`);
          child.stdout.write(`${appServerLine('turn/completed', {
            threadId, turn: { id: 'turn-1', status: 'completed' },
          })}\n`);
        }
      }
    });
    const adapter = new SpawnCodexAppServerAdapter(
      '/opt/codex',
      spawnProcess as unknown as typeof import('node:child_process').spawn,
      vi.fn() as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      cwd: '/workspace/repository',
      input: 'Explain the repository',
      signal: new AbortController().signal,
      onStdoutLine: line => lines.push(line),
    });

    child.emit('spawn');
    await execution;

    expect(spawnProcess).toHaveBeenCalledWith('/opt/codex', ['app-server', '--listen', 'stdio://'], {
      cwd: '/workspace/repository',
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(requests.map(request => request.method)).toEqual([
      'initialize', 'initialized', 'thread/start', 'turn/start',
    ]);
    expect(requests.at(-1)?.params).toMatchObject({
      threadId,
      cwd: '/workspace/repository',
      input: [{ type: 'text', text: 'Explain the repository', text_elements: [] }],
      approvalPolicy: 'never',
      summary: 'detailed',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace/repository'] },
    });
    expect(lines.some(line => line.includes('item/agentMessage/delta'))).toBe(true);
  });

  it('forwards every inbound protocol message and sends fixed turn/steer input', async () => {
    const child = fakeChildProcess(5252);
    const inbound: CodexAppServerProtocolMessage[] = [];
    const requests: Array<{ method: string; id?: number; params?: Record<string, unknown> }> = [];
    let interactiveControl: CodexInteractiveControl | undefined;
    child.stdin.on('data', chunk => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line) as { method: string; id?: number; params?: Record<string, unknown> };
        requests.push(message);
        if (message.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        } else if (message.method === 'thread/start') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: threadId } } })}\n`);
        } else if (message.method === 'turn/start') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: 'turn-interactive' } } })}\n`);
          child.stdout.write(`${appServerLine('turn/started', {
            threadId, turn: { id: 'turn-interactive', status: 'inProgress' },
          })}\n`);
          child.stdout.write(`${JSON.stringify({
            id: 900,
            method: 'item/tool/requestUserInput',
            params: { threadId, turnId: 'turn-interactive', itemId: 'tool-request', questions: [] },
          })}\n`);
        } else if (message.method === 'turn/steer') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { turnId: 'turn-interactive' } })}\n`);
          child.stdout.write(`${appServerLine('turn/completed', {
            threadId, turn: { id: 'turn-interactive', status: 'completed' },
          })}\n`);
        }
      }
    });
    const adapter = new SpawnCodexAppServerAdapter(
      'codex',
      vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      vi.fn() as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      cwd: '/workspace/repository',
      input: 'Start interactively',
      signal: new AbortController().signal,
      onStdoutLine: () => undefined,
      onAppServerMessage: event => inbound.push(event),
      onControlReady: control => { interactiveControl = control; },
    });

    child.emit('spawn');
    await vi.waitFor(() => expect(interactiveControl).toBeDefined());
    interactiveControl!.steer('Run the focused tests');
    await execution;

    expect(requests.find(request => request.method === 'turn/steer')?.params).toEqual({
      threadId,
      expectedTurnId: 'turn-interactive',
      input: [{ type: 'text', text: 'Run the focused tests', text_elements: [] }],
    });
    expect(inbound.map(event => event.requestMethod ?? event.message.method)).toEqual([
      'initialize',
      'thread/start',
      'turn/start',
      'turn/started',
      'item/tool/requestUserInput',
      'turn/steer',
      'turn/completed',
    ]);
  });

  it('resumes an existing thread through the native app-server request', async () => {
    const child = fakeChildProcess();
    const requests: Array<{ method: string; id?: number; params?: Record<string, unknown> }> = [];
    child.stdin.on('data', chunk => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line) as { method: string; id?: number; params?: Record<string, unknown> };
        requests.push(message);
        if (message.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        } else if (message.method === 'thread/resume') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: threadId } } })}\n`);
        } else if (message.method === 'turn/start') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: 'turn-2' } } })}\n`);
          child.stdout.write(`${appServerLine('turn/completed', {
            threadId, turn: { id: 'turn-2', status: 'completed' },
          })}\n`);
        }
      }
    });
    const adapter = new SpawnCodexAppServerAdapter(
      'codex',
      vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      vi.fn() as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      cwd: '/workspace/repository',
      conversationId: threadId,
      input: 'Continue',
      signal: new AbortController().signal,
      onStdoutLine: () => undefined,
    });

    child.emit('spawn');
    await execution;

    expect(requests.find(request => request.method === 'thread/resume')?.params).toEqual({
      threadId,
      cwd: '/workspace/repository',
    });
  });

  it('classifies a thread/resume active-writer conflict without exposing the raw error', async () => {
    const child = fakeChildProcess();
    child.stdin.on('data', chunk => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line) as { method: string; id?: number };
        if (message.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        } else if (message.method === 'thread/resume') {
          child.stdout.write(`${JSON.stringify({
            id: message.id,
            error: {
              code: -32603,
              message: `thread-store conflict: thread ${threadId} already has an active writer`,
            },
          })}\n`);
        }
      }
    });
    const adapter = new SpawnCodexAppServerAdapter(
      'codex',
      vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      vi.fn() as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      cwd: '/workspace/repository',
      conversationId: threadId,
      input: 'Continue',
      signal: new AbortController().signal,
      onStdoutLine: () => undefined,
    });

    child.emit('spawn');

    await expect(execution).rejects.toMatchObject({
      statusCode: 409,
      code: 'CODEX_CONVERSATION_IN_USE',
      message: '该对话正在另一个 Codex 客户端中使用，请关闭该客户端或新建对话。',
    });
    await expect(execution).rejects.not.toThrow(threadId);
  });

  it('keeps non-resume app-server errors generic even when their text mentions an active writer', async () => {
    const child = fakeChildProcess();
    child.stdin.on('data', chunk => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line) as { method: string; id?: number };
        if (message.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        } else if (message.method === 'thread/start') {
          child.stdout.write(`${JSON.stringify({
            id: message.id,
            error: { code: -32603, message: `thread ${threadId} already has an active writer` },
          })}\n`);
        }
      }
    });
    const adapter = new SpawnCodexAppServerAdapter(
      'codex',
      vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      vi.fn() as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      cwd: '/workspace/repository',
      input: 'Start',
      signal: new AbortController().signal,
      onStdoutLine: () => undefined,
    });

    child.emit('spawn');

    await expect(execution).rejects.toEqual(new Error('Codex app-server request failed'));
  });

  it('reads a stored thread with turns over the native app-server request', async () => {
    const child = fakeChildProcess();
    const requests: Array<{ method: string; id?: number; params?: Record<string, unknown> }> = [];
    child.stdin.on('data', chunk => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line) as { method: string; id?: number; params?: Record<string, unknown> };
        requests.push(message);
        if (message.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        } else if (message.method === 'thread/read') {
          child.stdout.write(`${JSON.stringify({
            id: message.id,
            result: {
              thread: {
                id: threadId,
                cwd: '/workspace/repository',
                updatedAt: 1_730_000_000,
                turns: [{
                  id: 'turn-1',
                  items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Explain this' }] }],
                }],
              },
            },
          })}\n`);
        }
      }
    });
    const spawnProcess = vi.fn(() => child);
    const adapter = new SpawnCodexAppServerAdapter(
      'codex',
      spawnProcess as unknown as typeof import('node:child_process').spawn,
      vi.fn() as unknown as typeof process.kill,
    );
    const historyPromise = adapter.readThread?.({ cwd: '/workspace/repository', conversationId: threadId });
    child.emit('spawn');
    const history = await historyPromise;

    expect(spawnProcess).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: '/workspace/repository',
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'thread/read']);
    expect(history).toMatchObject({ id: threadId, cwd: '/workspace/repository', updatedAt: 1_730_000_000 });
    expect(history?.turns).toHaveLength(1);
  });

  it('terminates the process group and escalates cancellation after five seconds', async () => {
    vi.useFakeTimers();
    const child = fakeChildProcess(7331);
    const killProcess = vi.fn();
    const controller = new AbortController();
    const adapter = new SpawnCodexAppServerAdapter(
      'codex',
      vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      killProcess as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      cwd: '/workspace/repository',
      input: 'Stop this turn',
      signal: controller.signal,
      onStdoutLine: () => undefined,
    });
    const rejected = expect(execution).rejects.toMatchObject({ name: 'AbortError' });

    child.emit('spawn');
    await Promise.resolve();
    controller.abort();
    expect(killProcess).toHaveBeenCalledWith(-7331, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killProcess).toHaveBeenCalledWith(-7331, 'SIGKILL');
    child.emit('exit', null, 'SIGKILL');

    await rejected;
  });

  it('rejects oversized output without exposing its contents', async () => {
    const child = fakeChildProcess(8118);
    const killProcess = vi.fn();
    const adapter = new SpawnCodexAppServerAdapter(
      'codex',
      vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      killProcess as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      cwd: '/workspace/repository',
      input: 'Generate too much output',
      signal: new AbortController().signal,
      onStdoutLine: () => undefined,
    });

    child.emit('spawn');
    await Promise.resolve();
    child.stdout.write(`${'x'.repeat((4 * 1024 * 1024) + 1)}\n`);
    await Promise.resolve();
    child.emit('exit', null, 'SIGTERM');

    await expect(execution).rejects.toMatchObject({
      code: 'CODEX_OUTPUT_TOO_LARGE',
      message: 'Codex produced too much output',
    });
    expect(killProcess).toHaveBeenCalledWith(-8118, 'SIGTERM');
  });

  it('times out a turn after thirty minutes', async () => {
    vi.useFakeTimers();
    const child = fakeChildProcess(9001);
    const killProcess = vi.fn();
    const adapter = new SpawnCodexAppServerAdapter(
      'codex',
      vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      killProcess as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      cwd: '/workspace/repository',
      input: 'Long-running turn',
      signal: new AbortController().signal,
      onStdoutLine: () => undefined,
    });
    const rejected = expect(execution).rejects.toMatchObject({
      code: 'CODEX_TURN_TIMEOUT',
      message: 'Codex did not finish in time',
    });

    child.emit('spawn');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
    child.emit('exit', null, 'SIGTERM');

    await rejected;
    expect(killProcess).toHaveBeenCalledWith(-9001, 'SIGTERM');
  });
});

describe('CodexChatService', () => {
  it('reports the fixed unrestricted approval mode', async () => {
    await expect(new CodexChatService(adapterWith([])).status()).resolves.toEqual({
      available: true,
      version: 'codex-cli 0.146.0',
      mode: 'yolo',
    });
  });

  it('builds the prompt and streams a sanitized assistant response', async () => {
    const adapter = adapterWith(successfulLines('See /workspace/repository/src/app.ts'));
    const service = new CodexChatService(adapter);

    await service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      contextFiles: [{ relativePath: 'src/app.ts', content: 'export const answer = 42;' }],
      message: 'Explain the app',
    });

    const request = adapter.execute.mock.calls[0]![0] as CodexExecutionRequest;
    expect(request).toMatchObject({ cwd: '/workspace/repository' });
    expect(request.input).toContain('User message:\nExplain the app');
    expect(request.input).toContain('Selected context files (JSON):');
    expect(request.input).toContain('"relativePath":"src/app.ts"');
    expect(service.getConversation(repositoryId)).toMatchObject({
      conversationId: threadId,
      status: 'idle',
      messages: [
        { role: 'user', content: 'Explain the app', contextFiles: ['src/app.ts'] },
        { role: 'assistant', content: 'See ./src/app.ts' },
      ],
    });
  });

  it('coalesces rapid token deltas into typed events while publishing terminal state immediately', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const adapter: CodexProcessAdapter = {
      checkAvailability: async () => ({ available: true, version: 'codex-cli 0.146.0' }),
      execute: vi.fn(async request => {
        request.onStdoutLine(appServerLine('thread/started', { thread: { id: threadId } }));
        request.onStdoutLine(appServerLine('item/agentMessage/delta', { threadId, itemId: 'answer', delta: '第一段' }));
        request.onStdoutLine(appServerLine('item/agentMessage/delta', { threadId, itemId: 'answer', delta: '第二段' }));
        await new Promise<void>(resolve => { release = resolve; });
      }),
    };
    const service = new CodexChatService(adapter);
    const events: import('../src/domain/types.js').CodexConversationStreamEvent[] = [];
    const unsubscribe = service.subscribe(repositoryId, event => {
      events.push(event);
    });
    const execution = service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      message: 'Stream this',
    });

    await Promise.resolve();
    expect(events.some(event => event.type === 'message.delta')).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(events.at(-1)).toMatchObject({
      type: 'message.delta',
      messageId: expect.stringMatching(/^assistant-/u),
      delta: '第一段第二段',
    });

    release?.();
    await execution;
    expect(events.at(-1)).toMatchObject({
      type: 'turn.completed',
      status: 'idle',
      assistantMessage: { content: '第一段第二段' },
    });
    unsubscribe();
  });

  it('does not duplicate text when a completed item follows deltas', async () => {
    const adapter = adapterWith([
      appServerLine('thread/started', { thread: { id: threadId } }),
      appServerLine('item/agentMessage/delta', { threadId, itemId: 'answer', delta: 'First' }),
      appServerLine('item/completed', {
        threadId,
        item: { id: 'answer', type: 'agentMessage', text: 'First and second' },
      }),
    ]);
    const service = new CodexChatService(adapter);
    const events: import('../src/domain/types.js').CodexConversationStreamEvent[] = [];
    const unsubscribe = service.subscribe(repositoryId, event => events.push(event));

    await service.send({ repositoryId, repositoryRealPath: '/workspace/repository', message: 'Continue' });

    expect(service.getConversation(repositoryId)?.messages.at(-1)?.content).toBe('First and second');
    expect(events.find(event => event.type === 'message.completed')).toMatchObject({
      type: 'message.completed',
      message: { content: 'First and second' },
    });
    unsubscribe();
  });

  it('publishes sanitized reasoning, file-change, command, and tool activities', async () => {
    const adapter = adapterWith([
      appServerLine('thread/started', { thread: { id: threadId } }),
      appServerLine('item/started', {
        threadId,
        item: { id: 'reason-1', type: 'reasoning', status: 'inProgress', summary: [] },
      }),
      appServerLine('item/reasoning/summaryTextDelta', {
        threadId,
        itemId: 'reason-1',
        delta: '检查 /workspace/repository/src/app.ts',
      }),
      appServerLine('item/completed', {
        threadId,
        item: { id: 'reason-1', type: 'reasoning', status: 'completed', summary: [] },
      }),
      appServerLine('item/started', {
        threadId,
        item: { id: 'command-1', type: 'commandExecution', status: 'inProgress', command: 'npm test -- src/app.ts' },
      }),
      appServerLine('item/completed', {
        threadId,
        item: { id: 'command-1', type: 'commandExecution', status: 'completed', command: 'npm test -- src/app.ts', aggregatedOutput: 'token-secret' },
      }),
      appServerLine('item/completed', {
        threadId,
        item: {
          id: 'files-1',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: '/workspace/repository/src/app.ts', kind: 'update', diff: 'secret diff' },
            { path: '/etc/passwd', kind: 'update' },
          ],
        },
      }),
      appServerLine('item/completed', {
        threadId,
        item: { id: 'tool-1', type: 'mcpToolCall', status: 'completed', server: 'docs', tool: 'search', arguments: { token: 'secret' } },
      }),
      appServerLine('item/completed', {
        threadId,
        item: { id: 'answer', type: 'agentMessage', text: 'Done' },
      }),
    ]);
    const service = new CodexChatService(adapter);
    const events: import('../src/domain/types.js').CodexConversationStreamEvent[] = [];
    const unsubscribe = service.subscribe(repositoryId, event => events.push(event));

    await service.send({ repositoryId, repositoryRealPath: '/workspace/repository', message: 'Update it' });

    const snapshot = service.getConversation(repositoryId)!;
    expect(snapshot.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'thinking', status: 'completed', detail: '检查 ./src/app.ts' }),
      expect.objectContaining({
        kind: 'command',
        title: '运行命令',
        status: 'completed',
        detail: 'npm test -- src/app.ts',
      }),
      expect.objectContaining({
        kind: 'file-change',
        files: [{ path: 'src/app.ts', kind: 'update' }],
      }),
      expect.objectContaining({ kind: 'tool', title: '工具调用 · docs/search', status: 'completed' }),
    ]));
    expect(events.some(event => event.type === 'activity.updated')).toBe(true);
    expect(JSON.stringify(snapshot.activities)).not.toContain('token-secret');
    expect(JSON.stringify(snapshot.activities)).not.toContain('secret diff');
    expect(JSON.stringify(snapshot.activities)).not.toContain('/etc/passwd');
    unsubscribe();
  });

  it('publishes ordered protocol metadata without exposing raw app-server payloads', async () => {
    const adapter: CodexProcessAdapter = {
      checkAvailability: async () => ({ available: true, version: 'codex-cli 0.146.0' }),
      execute: vi.fn(async request => {
        request.onAppServerMessage?.({
          message: {
            id: 81,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId,
              turnId: 'turn-secret',
              itemId: 'item-secret',
              command: 'curl -H Authorization:secret-token',
              output: 'private-output',
              diff: 'private-diff',
              cwd: '/workspace/repository',
            },
          },
        });
        request.onAppServerMessage?.({
          requestMethod: 'turn/start',
          message: { id: 3, result: { turn: { id: 'turn-secret', status: 'completed' }, usage: 'private-usage' } },
        });
        for (const line of successfulLines('Safe answer')) request.onStdoutLine(line);
      }),
    };
    const service = new CodexChatService(adapter);
    const events: import('../src/domain/types.js').CodexConversationStreamEvent[] = [];
    const unsubscribe = service.subscribe(repositoryId, event => events.push(event));

    await service.send({ repositoryId, repositoryRealPath: '/workspace/repository', message: 'Inspect events' });

    const protocolEvents = events.filter(event => event.type === 'app-server.event');
    expect(protocolEvents).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          sequence: 1,
          kind: 'request',
          method: 'item/commandExecution/requestApproval',
          requestId: '81',
          threadId,
          turnId: 'turn-secret',
          itemId: 'item-secret',
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          sequence: 2,
          kind: 'response',
          method: 'turn/start',
          requestId: '3',
          turnId: 'turn-secret',
        }),
      }),
    ]);
    expect(JSON.stringify(protocolEvents)).not.toMatch(/secret-token|private-output|private-diff|private-usage|\/workspace\/repository/u);
    unsubscribe();
  });

  it('steers a running turn and keeps follow-up output attached to the new assistant message', async () => {
    let executionRequest: CodexExecutionRequest | undefined;
    let releaseExecution: (() => void) | undefined;
    const steeredInputs: string[] = [];
    const adapter: CodexProcessAdapter = {
      checkAvailability: async () => ({ available: true, version: 'codex-cli 0.146.0' }),
      execute: vi.fn(async request => {
        executionRequest = request;
        request.onStdoutLine(appServerLine('thread/started', { thread: { id: threadId } }));
        request.onControlReady?.({ steer: (input: string) => steeredInputs.push(input) });
        await new Promise<void>(resolve => { releaseExecution = resolve; });
      }),
    };
    const service = new CodexChatService(adapter);
    const events: import('../src/domain/types.js').CodexConversationStreamEvent[] = [];
    const unsubscribe = service.subscribe(repositoryId, event => events.push(event));
    const execution = service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      message: 'Initial question',
    });
    await vi.waitFor(() => expect(executionRequest).toBeDefined());
    executionRequest!.onStdoutLine(appServerLine('item/completed', {
      threadId,
      item: { id: 'initial-answer', type: 'agentMessage', text: 'Initial answer' },
    }));
    executionRequest!.onStdoutLine(appServerLine('item/started', {
      threadId,
      item: { id: 'long-command', type: 'commandExecution', command: 'npm test', status: 'inProgress' },
    }));

    const steeredSnapshot = service.steerConversation(repositoryId, 'Also run the tests');
    const initialAssistantId = steeredSnapshot.messages[1]!.id;
    const steeredEvent = events.find(event => event.type === 'turn.steered');
    expect(steeredInputs).toEqual(['Also run the tests']);
    expect(steeredSnapshot.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Initial question'],
      ['assistant', 'Initial answer'],
      ['user', 'Also run the tests'],
      ['assistant', ''],
    ]);
    expect(steeredEvent).toMatchObject({
      type: 'turn.steered',
      userMessage: { content: 'Also run the tests' },
      assistantMessage: { content: '' },
    });

    executionRequest!.onStdoutLine(appServerLine('item/completed', {
      threadId,
      item: { id: 'long-command', type: 'commandExecution', command: 'npm test', status: 'completed' },
    }));
    executionRequest!.onStdoutLine(appServerLine('item/completed', {
      threadId,
      item: { id: 'steered-answer', type: 'agentMessage', text: 'Tests passed' },
    }));
    executionRequest!.onStdoutLine(appServerLine('turn/completed', {
      threadId,
      turn: { status: 'completed' },
    }));
    releaseExecution?.();
    await execution;

    expect(service.getConversation(repositoryId)?.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Initial question'],
      ['assistant', 'Initial answer'],
      ['user', 'Also run the tests'],
      ['assistant', 'Tests passed'],
    ]);
    expect(service.getConversation(repositoryId)?.activities).toContainEqual(expect.objectContaining({
      id: 'activity-long-command',
      assistantMessageId: initialAssistantId,
      status: 'completed',
      detail: 'npm test',
    }));
    unsubscribe();
  });

  it('resumes only a server-known conversation in the same repository', async () => {
    const adapter = adapterWith(successfulLines('First'));
    const service = new CodexChatService(adapter);
    await service.send({ repositoryId, repositoryRealPath: '/workspace/repository', message: 'First' });
    adapter.execute.mockImplementationOnce(async (request: CodexExecutionRequest) => {
      request.onStdoutLine(appServerLine('thread/started', { thread: { id: threadId } }));
      request.onStdoutLine(appServerLine('item/completed', {
        threadId,
        item: { id: 'second', type: 'agentMessage', text: 'Second' },
      }));
    });

    await service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      conversationId: threadId,
      message: 'Continue',
    });

    const request = adapter.execute.mock.calls[1]![0] as CodexExecutionRequest;
    expect(request).toMatchObject({ conversationId: threadId, cwd: '/workspace/repository' });
    await expect(service.send({
      repositoryId: `dir_${'b'.repeat(43)}`,
      repositoryRealPath: '/workspace/other',
      conversationId: threadId,
      message: 'Read another repository',
    })).rejects.toMatchObject({ code: 'CODEX_CONVERSATION_NOT_FOUND' });
  });

  it('keeps a background snapshot running until explicitly stopped', async () => {
    let executionRequest: CodexExecutionRequest | undefined;
    const adapter: CodexProcessAdapter = {
      checkAvailability: async () => ({ available: true, version: 'codex-cli 0.146.0' }),
      execute: vi.fn(async request => {
        executionRequest = request;
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
          }, { once: true });
        });
      }),
    };
    const service = new CodexChatService(adapter);
    const execution = service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      message: 'Keep working',
    });

    expect(service.getConversation(repositoryId)).toMatchObject({
      repositoryId,
      status: 'running',
      phase: 'starting',
      messages: [{ role: 'user', content: 'Keep working' }, { role: 'assistant', content: '' }],
    });
    expect(executionRequest).toBeDefined();
    service.stopConversation(repositoryId);
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.getConversation(repositoryId)).toMatchObject({
      status: 'stopped',
      messages: [{ role: 'user', content: 'Keep working' }, { role: 'assistant', content: '（本次响应已停止）' }],
    });
  });

  it('uses native resume for a valid conversation ID after service restart', async () => {
    const adapter = adapterWith(successfulLines('Resumed'));
    const service = new CodexChatService(adapter);

    await service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      conversationId: threadId,
      message: 'Continue after restart',
    });

    expect(adapter.execute.mock.calls[0]![0]).toMatchObject({
      conversationId: threadId,
      cwd: '/workspace/repository',
    });
  });

  it('rolls back a failed resume attempt when another Codex client owns the writer', async () => {
    let executionCount = 0;
    const adapter: CodexProcessAdapter = {
      checkAvailability: async () => ({ available: true, version: 'codex-cli 0.146.0' }),
      execute: vi.fn(async request => {
        executionCount += 1;
        if (executionCount === 1) {
          for (const line of successfulLines('First answer')) request.onStdoutLine(line);
          return;
        }
        throw new ApiError(
          409,
          'CODEX_CONVERSATION_IN_USE',
          '该对话正在另一个 Codex 客户端中使用，请关闭该客户端或新建对话。',
        );
      }),
    };
    const service = new CodexChatService(adapter);
    const events: import('../src/domain/types.js').CodexConversationStreamEvent[] = [];
    const unsubscribe = service.subscribe(repositoryId, event => events.push(event));
    await service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      message: 'First question',
    });

    await expect(service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      conversationId: threadId,
      message: 'Duplicate-prone retry',
    })).rejects.toMatchObject({ code: 'CODEX_CONVERSATION_IN_USE' });

    expect(service.getConversation(repositoryId)).toMatchObject({
      conversationId: threadId,
      status: 'failed',
      error: '该对话正在另一个 Codex 客户端中使用，请关闭该客户端或新建对话。',
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
      ],
    });
    expect(JSON.stringify(service.getConversation(repositoryId))).not.toContain('Duplicate-prone retry');
    expect(events.find(event => event.type === 'turn.completed' && event.status === 'failed')).toMatchObject({
      type: 'turn.completed',
      rollbackMessageIds: [expect.stringMatching(/^user-/u), expect.stringMatching(/^assistant-/u)],
      assistantMessage: null,
      error: '该对话正在另一个 Codex 客户端中使用，请关闭该客户端或新建对话。',
    });
    unsubscribe();
  });

  it('persists the conversation ID only after a successful turn', async () => {
    const persisted: Array<Map<string, string>> = [];
    const service = new CodexChatService(adapterWith(successfulLines()), new Map(), async conversations => {
      persisted.push(new Map(conversations));
    });

    await service.send({ repositoryId, repositoryRealPath: '/workspace/repository', message: 'Complete this turn' });

    expect(persisted).toEqual([new Map([[repositoryId, threadId]])]);
    const failedPersist = vi.fn(async () => undefined);
    const failedService = new CodexChatService(adapterWith([
      appServerLine('thread/started', { thread: { id: threadId } }),
      appServerLine('turn/completed', { threadId, turn: { status: 'failed' } }),
    ]), new Map(), failedPersist);
    await expect(failedService.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      message: 'Fail this turn',
    })).rejects.toMatchObject({ code: 'CODEX_TURN_FAILED' });
    expect(failedPersist).not.toHaveBeenCalled();
  });

  it('keeps activity cards attached when a turn fails before assistant text', async () => {
    const service = new CodexChatService(adapterWith([
      appServerLine('thread/started', { thread: { id: threadId } }),
      appServerLine('item/started', {
        threadId,
        item: { id: 'command-before-failure', type: 'commandExecution', status: 'inProgress' },
      }),
      appServerLine('turn/completed', { threadId, turn: { status: 'failed' } }),
    ]));

    await expect(service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      message: 'Run the task',
    })).rejects.toMatchObject({ code: 'CODEX_TURN_FAILED' });

    const snapshot = service.getConversation(repositoryId)!;
    const assistantMessage = snapshot.messages.at(-1)!;
    expect(assistantMessage).toMatchObject({ role: 'assistant', content: '' });
    expect(snapshot.activities).toEqual([
      expect.objectContaining({
        assistantMessageId: assistantMessage.id,
        kind: 'command',
        status: 'running',
      }),
    ]);
  });

  it('restores a persisted conversation ID without browser state', () => {
    const service = new CodexChatService(adapterWith([]), new Map([[repositoryId, threadId]]));

    expect(service.getConversation(repositoryId)).toEqual({
      repositoryId,
      conversationId: threadId,
      messages: [],
      status: 'idle',
      error: null,
      updatedAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('hydrates persisted thread history without browser state and caches the result', async () => {
    const adapter = adapterWith([]);
    adapter.readThread = vi.fn(async () => ({
      id: threadId,
      cwd: '/workspace/repository',
      updatedAt: 1_730_000_000,
      turns: [{
        id: 'turn-1',
        items: [
          {
            id: 'user-1',
            type: 'userMessage',
            content: [{
              type: 'text',
              text: [
                'You are responding through the CodePilot Web chat interface.',
                'Selected context files (JSON):',
                JSON.stringify([{ relativePath: 'src/app.ts', content: 'do not expose this' }]),
                '',
                'User message:',
                '恢复历史',
              ].join('\n'),
            }],
          },
          { id: 'assistant-1', type: 'agentMessage', text: 'See /workspace/repository/src/app.ts' },
          { id: 'assistant-2', type: 'agentMessage', text: ' and continue' },
          { id: 'tool-1', type: 'fileChange', changes: [{ path: '/workspace/repository/secret' }] },
        ],
      }],
    }));
    const service = new CodexChatService(adapter, new Map([[repositoryId, threadId]]));

    const restored = await service.restoreConversation(repositoryId, '/workspace/repository');
    const cached = await service.restoreConversation(repositoryId, '/workspace/repository');

    expect(adapter.readThread).toHaveBeenCalledTimes(1);
    expect(restored).toMatchObject({
      repositoryId,
      conversationId: threadId,
      status: 'idle',
      messages: [
        { role: 'user', content: '恢复历史', contextFiles: ['src/app.ts'] },
        { role: 'assistant', content: 'See ./src/app.ts and continue' },
      ],
      activities: [{
        assistantMessageId: 'assistant-history-turn-1',
        kind: 'file-change',
        files: [{ path: 'secret', kind: '修改' }],
      }],
    });
    expect(JSON.stringify(restored)).not.toContain('do not expose this');
    expect(JSON.stringify(restored)).not.toContain('/workspace/repository');
    expect(cached).toEqual(restored);
  });

  it('restores an activity-only historical turn with an assistant anchor', async () => {
    const adapter = adapterWith([]);
    adapter.readThread = vi.fn(async () => ({
      id: threadId,
      cwd: '/workspace/repository',
      updatedAt: 0,
      turns: [{
        id: 'turn-without-text',
        items: [{
          id: 'file-change-only',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: '/workspace/repository/src/app.ts', kind: 'update' }],
        }],
      }],
    }));
    const service = new CodexChatService(adapter, new Map([[repositoryId, threadId]]));

    const restored = (await service.restoreConversation(repositoryId, '/workspace/repository'))!;

    expect(restored.messages).toEqual([{
      id: 'assistant-history-turn-without-text',
      role: 'assistant',
      content: '',
    }]);
    expect(restored.activities).toEqual([
      expect.objectContaining({
        assistantMessageId: 'assistant-history-turn-without-text',
        kind: 'file-change',
      }),
    ]);
  });

  it('rejects persisted thread history from another repository cwd', async () => {
    const adapter = adapterWith([]);
    adapter.readThread = vi.fn(async () => ({
      id: threadId,
      cwd: '/workspace/other-repository',
      updatedAt: 1_730_000_000,
      turns: [],
    }));
    const service = new CodexChatService(adapter, new Map([[repositoryId, threadId]]));

    await expect(service.restoreConversation(repositoryId, '/workspace/repository')).rejects.toMatchObject({
      code: 'CODEX_CONVERSATION_NOT_FOUND',
    });
  });

  it('cleans persisted conversation state for a removed repository', async () => {
    const persisted = vi.fn(async () => undefined);
    const service = new CodexChatService(adapterWith([]), new Map([[repositoryId, threadId]]), persisted);

    await service.cleanupRepository(repositoryId);

    expect(service.getConversation(repositoryId)).toBeNull();
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledWith(new Map());
  });

  it('does not return raw Codex failure details', async () => {
    const service = new CodexChatService(adapterWith([
      appServerLine('thread/started', { thread: { id: threadId } }),
      appServerLine('turn/completed', {
        threadId,
        turn: { status: 'failed', error: { message: '/secret/path token=secret' } },
      }),
    ]));

    await expect(service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      message: 'Fail safely',
    })).rejects.toMatchObject({
      code: 'CODEX_TURN_FAILED',
      message: 'Codex could not complete the request',
    });
  });
});
