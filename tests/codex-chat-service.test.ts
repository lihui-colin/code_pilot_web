import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexChatService,
  SpawnCodexProcessAdapter,
  type CodexExecutionRequest,
  type CodexProcessAdapter,
} from '../src/services/codex-chat-service.js';
import type { CodexChatStreamEvent } from '../src/domain/types.js';

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

afterEach(() => {
  vi.useRealTimers();
});

function adapterWith(lines: string[]): CodexProcessAdapter & { execute: ReturnType<typeof vi.fn> } {
  return {
    checkAvailability: vi.fn(async () => ({ available: true, version: 'codex-cli 0.146.0' })),
    execute: vi.fn(async (request: CodexExecutionRequest) => {
      for (const line of lines) request.onStdoutLine(line);
    }),
  };
}

describe('CodexChatService', () => {
  it('reports only a recognized Codex CLI version as available', async () => {
    const validVersion = vi.fn(async () => 'codex-cli 0.146.0');
    const invalidVersion = vi.fn(async () => '/secret/path unexpected output');
    const unavailableVersion = vi.fn(async () => { throw new Error('spawn ENOENT /secret/path'); });

    await expect(new SpawnCodexProcessAdapter('codex', undefined, undefined, validVersion).checkAvailability())
      .resolves.toEqual({ available: true, version: 'codex-cli 0.146.0' });
    await expect(new SpawnCodexProcessAdapter('codex', undefined, undefined, invalidVersion).checkAvailability())
      .resolves.toEqual({ available: false, version: null });
    await expect(new SpawnCodexProcessAdapter('codex', undefined, undefined, unavailableVersion).checkAvailability())
      .resolves.toEqual({ available: false, version: null });
    expect(validVersion).toHaveBeenCalledWith('codex');
  });

  it('spawns Codex without a shell and sends the prompt over stdin', async () => {
    const child = fakeChildProcess();
    const spawnProcess = vi.fn(() => child);
    const killProcess = vi.fn();
    const input: Buffer[] = [];
    const lines: string[] = [];
    child.stdin.on('data', chunk => input.push(chunk as Buffer));
    const adapter = new SpawnCodexProcessAdapter(
      '/opt/codex',
      spawnProcess as unknown as typeof import('node:child_process').spawn,
      killProcess as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      arguments_: ['exec', '--json', '-'],
      cwd: '/workspace/repository',
      input: 'Explain the repository',
      signal: new AbortController().signal,
      onStdoutLine: line => lines.push(line),
    });

    child.emit('spawn');
    await Promise.resolve();
    child.stdout.write('{"type":"turn.completed"}\n');
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.emit('exit', 0, null);
    await execution;

    expect(spawnProcess).toHaveBeenCalledWith('/opt/codex', ['exec', '--json', '-'], {
      cwd: '/workspace/repository',
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(Buffer.concat(input).toString('utf8')).toBe('Explain the repository');
    expect(lines).toEqual(['{"type":"turn.completed"}']);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it('terminates the full Codex process group and escalates cancellation after five seconds', async () => {
    vi.useFakeTimers();
    const child = fakeChildProcess(7331);
    const spawnProcess = vi.fn(() => child);
    const killProcess = vi.fn();
    const controller = new AbortController();
    const adapter = new SpawnCodexProcessAdapter(
      'codex',
      spawnProcess as unknown as typeof import('node:child_process').spawn,
      killProcess as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      arguments_: ['exec', '--json', '-'],
      cwd: '/workspace/repository',
      input: 'Stop this turn',
      signal: controller.signal,
      onStdoutLine: () => undefined,
    });

    child.emit('spawn');
    await Promise.resolve();
    controller.abort();
    expect(killProcess).toHaveBeenCalledWith(-7331, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killProcess).toHaveBeenCalledWith(-7331, 'SIGKILL');
    child.emit('exit', null, 'SIGKILL');

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops Codex and reports a sanitized error when stdout exceeds the limit', async () => {
    const child = fakeChildProcess(8118);
    const spawnProcess = vi.fn(() => child);
    const killProcess = vi.fn();
    const adapter = new SpawnCodexProcessAdapter(
      'codex',
      spawnProcess as unknown as typeof import('node:child_process').spawn,
      killProcess as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      arguments_: ['exec', '--json', '-'],
      cwd: '/workspace/repository',
      input: 'Generate too much output',
      signal: new AbortController().signal,
      onStdoutLine: () => undefined,
    });

    child.emit('spawn');
    await Promise.resolve();
    child.stdout.write(`${'x'.repeat((4 * 1024 * 1024) + 1)}\n`);
    expect(killProcess).toHaveBeenCalledWith(-8118, 'SIGTERM');
    child.emit('exit', null, 'SIGTERM');

    await expect(execution).rejects.toMatchObject({
      code: 'CODEX_OUTPUT_TOO_LARGE',
      message: 'Codex produced too much output',
    });
  });

  it('times out a Codex turn after thirty minutes', async () => {
    vi.useFakeTimers();
    const child = fakeChildProcess(9001);
    const spawnProcess = vi.fn(() => child);
    const killProcess = vi.fn();
    const adapter = new SpawnCodexProcessAdapter(
      'codex',
      spawnProcess as unknown as typeof import('node:child_process').spawn,
      killProcess as unknown as typeof process.kill,
    );
    const execution = adapter.execute({
      arguments_: ['exec', '--json', '-'],
      cwd: '/workspace/repository',
      input: 'Long-running turn',
      signal: new AbortController().signal,
      onStdoutLine: () => undefined,
    });

    child.emit('spawn');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
    expect(killProcess).toHaveBeenCalledWith(-9001, 'SIGTERM');
    child.emit('exit', null, 'SIGTERM');

    await expect(execution).rejects.toMatchObject({
      code: 'CODEX_TURN_TIMEOUT',
      message: 'Codex did not finish in time',
    });
  });

  it('starts Codex with fixed JSON and workspace-write arguments and streams the assistant response', async () => {
    const adapter = adapterWith([
      JSON.stringify({ type: 'thread.started', thread_id: threadId }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'answer', type: 'agent_message', text: 'See /workspace/repository/src/app.ts' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ]);
    const service = new CodexChatService(adapter);
    const events: CodexChatStreamEvent[] = [];

    await service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      contextFiles: [{ relativePath: 'src/app.ts', content: 'export const answer = 42;' }],
      message: 'Explain the app',
      onEvent: event => events.push(event),
    });

    const request = adapter.execute.mock.calls[0]![0] as CodexExecutionRequest;
    expect(request.arguments_).toEqual([
      'exec', '--json', '--color', 'never', '--sandbox', 'workspace-write',
      '--cd', '/workspace/repository', '-',
    ]);
    expect(request.cwd).toBe('/workspace/repository');
    expect(request.input).toContain('User message:\nExplain the app');
    expect(request.input).toContain('Selected context files (JSON):');
    expect(request.input).toContain('"relativePath":"src/app.ts"');
    expect(events).toEqual([
      { type: 'conversation', conversationId: threadId },
      { type: 'assistant_delta', delta: 'See ./src/app.ts' },
      { type: 'done' },
    ]);
  });

  it('resumes only a server-known conversation in the same repository', async () => {
    const adapter = adapterWith([
      JSON.stringify({ type: 'thread.started', thread_id: threadId }),
      JSON.stringify({ type: 'item.completed', item: { id: 'first', type: 'agent_message', text: 'First' } }),
    ]);
    const service = new CodexChatService(adapter);
    await service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      message: 'First',
      onEvent: () => undefined,
    });
    adapter.execute.mockImplementationOnce(async (request: CodexExecutionRequest) => {
      request.onStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
      request.onStdoutLine(JSON.stringify({
        type: 'item.completed', item: { id: 'second', type: 'agent_message', text: 'Second' },
      }));
    });

    await service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      conversationId: threadId,
      message: 'Continue',
      onEvent: () => undefined,
    });

    const request = adapter.execute.mock.calls[1]![0] as CodexExecutionRequest;
    expect(request.arguments_).toEqual([
      'exec', '--json', '--color', 'never', '--sandbox', 'workspace-write',
      'resume', threadId, '-',
    ]);
    await expect(service.send({
      repositoryId: `dir_${'b'.repeat(43)}`,
      repositoryRealPath: '/workspace/other',
      conversationId: threadId,
      message: 'Read another repository',
      onEvent: () => undefined,
    })).rejects.toMatchObject({ code: 'CODEX_CONVERSATION_NOT_FOUND' });
  });

  it('does not return raw Codex failure details', async () => {
    const adapter = adapterWith([
      JSON.stringify({ type: 'thread.started', thread_id: threadId }),
      JSON.stringify({ type: 'turn.failed', error: { message: '/secret/path token=secret' } }),
    ]);
    const service = new CodexChatService(adapter);

    await expect(service.send({
      repositoryId,
      repositoryRealPath: '/workspace/repository',
      message: 'Fail safely',
      onEvent: () => undefined,
    })).rejects.toMatchObject({
      code: 'CODEX_TURN_FAILED',
      message: 'Codex could not complete the request',
    });
  });
});
