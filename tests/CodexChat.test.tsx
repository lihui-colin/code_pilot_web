// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexChat } from '../src/web/CodexChat.js';
import * as api from '../src/web/api.js';

vi.mock('../src/web/api.js', () => ({
  clearCodexConversation: vi.fn(),
  getCodexConversation: vi.fn(),
  getCodexStatus: vi.fn(),
  getRepositories: vi.fn(),
  getRepositoryContextFiles: vi.fn(),
  startCodexMessage: vi.fn(),
  stopCodexConversation: vi.fn(),
}));

const repositoryId = `dir_${'a'.repeat(43)}`;
const conversationId = '123e4567-e89b-42d3-a456-426614174000';

beforeEach(() => {
  vi.clearAllMocks();
  window.history.pushState({}, '', `/codex-chat?repositoryId=${repositoryId}`);
  vi.mocked(api.getRepositories).mockResolvedValue({
    current: { id: null, name: 'workspace', relativePath: '' },
    breadcrumbs: [],
    entries: [{
      id: repositoryId,
      name: 'terminal-web',
      relativePath: 'terminal-web',
      kind: 'repository',
      source: 'workspace',
      markers: ['git', 'node'],
      viewer: null,
      session: null,
      openVSCodeUrl: 'https://example.test/openvscode/',
    }],
  });
  vi.mocked(api.getCodexStatus).mockResolvedValue({ available: true, version: 'codex-cli 0.146.0' });
  vi.mocked(api.getCodexConversation).mockResolvedValue(null);
  vi.mocked(api.getRepositoryContextFiles).mockResolvedValue({
    files: [{ id: `file_${'b'.repeat(43)}`, relativePath: 'src/app.ts', size: 512 }],
    truncated: false,
  });
  vi.mocked(api.startCodexMessage).mockImplementation(async request => ({
    repositoryId,
    conversationId,
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: request.message,
        ...(request.contextFileIds?.length ? { contextFiles: ['src/app.ts'] } : {}),
      },
      { id: 'assistant-1', role: 'assistant', content: '这是 Codex 的回答。' },
    ],
    status: 'idle',
    error: null,
    updatedAt: '2026-08-04T00:00:00.000Z',
  }));
  vi.mocked(api.clearCodexConversation).mockResolvedValue(undefined);
  vi.mocked(api.stopCodexConversation).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CodexChat', () => {
  it('keeps repository details in a hidden drawer that can be opened and closed', async () => {
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'terminal-web' });
    expect(screen.queryByRole('dialog', { name: '对话信息' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开对话面板' }));
    expect(screen.getByRole('dialog', { name: '对话信息' })).toHaveTextContent('当前仓库');
    expect(screen.getByRole('button', { name: '＋ 新对话' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '对话信息' })).not.toBeInTheDocument();
  });

  it('loads the selected repository and renders a background conversation snapshot', async () => {
    render(<CodexChat />);
    expect(await screen.findByRole('heading', { name: 'terminal-web' })).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    fireEvent.change(input, { target: { value: '分析项目结构' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(api.startCodexMessage).toHaveBeenCalledWith({ repositoryId, message: '分析项目结构' }));
    expect(screen.getByText('分析项目结构')).toBeInTheDocument();
    expect(await screen.findByText('这是 Codex 的回答。')).toBeInTheDocument();
  });

  it('attaches a server-listed repository file to the next Codex message', async () => {
    vi.mocked(api.getRepositoryContextFiles).mockResolvedValue({
      files: [
        { id: `file_${'b'.repeat(43)}`, relativePath: 'src/app.ts', size: 512 },
        { id: `file_${'c'.repeat(43)}`, relativePath: 'src/config.ts', size: 256 },
      ],
      truncated: false,
    });
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'terminal-web' });
    fireEvent.click(screen.getByRole('button', { name: '＋ Add file' }));
    const filePath = await screen.findByText('src/app.ts');
    fireEvent.click(filePath.closest('button')!);
    fireEvent.click(screen.getByText('src/config.ts').closest('button')!);
    expect(screen.getByRole('dialog', { name: '选择上下文文件' })).toBeInTheDocument();
    expect(screen.getByText('已选 2/8')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('heading', { name: 'terminal-web' }));
    expect(screen.queryByRole('dialog', { name: '选择上下文文件' })).not.toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    fireEvent.change(input, { target: { value: '解释附件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(api.startCodexMessage).toHaveBeenCalledWith(
      {
        repositoryId,
        contextFileIds: [`file_${'b'.repeat(43)}`, `file_${'c'.repeat(43)}`],
        message: '解释附件',
      },
    ));
    expect(screen.getByText('📎 src/app.ts')).toBeInTheDocument();
  });

  it('continues the server-issued Codex conversation on the next message', async () => {
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'terminal-web' });
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    fireEvent.change(input, { target: { value: '第一条' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.startCodexMessage).toHaveBeenCalledTimes(1));
    await screen.findByText('这是 Codex 的回答。');
    fireEvent.change(input, { target: { value: '继续' } });
    expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(api.startCodexMessage).toHaveBeenLastCalledWith(
      { repositoryId, conversationId, message: '继续' },
    ));
  });

  it('restores the repository conversation and running state when reopened', async () => {
    vi.mocked(api.getCodexConversation).mockResolvedValue({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-restored', role: 'user', content: '继续分析' },
        { id: 'assistant-restored', role: 'assistant', content: '后台仍在处理' },
      ],
      status: 'running',
      error: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    });

    render(<CodexChat />);

    expect(await screen.findByText('继续分析')).toBeInTheDocument();
    expect(screen.getByText('后台仍在处理')).toBeInTheDocument();
    expect(screen.getByText('处理中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
  });

  it('combines a server-persisted conversation ID with browser message history after restart', async () => {
    const storedSnapshot = {
      repositoryId,
      conversationId,
      messages: [{ id: 'user-stored', role: 'user' as const, content: '重启前的消息' }],
      status: 'idle' as const,
      error: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    };
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => JSON.stringify(storedSnapshot)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.mocked(api.getCodexConversation).mockResolvedValue({
      repositoryId,
      conversationId,
      messages: [],
      status: 'idle',
      error: null,
      updatedAt: '1970-01-01T00:00:00.000Z',
    });

    render(<CodexChat />);

    expect(await screen.findByText('重启前的消息')).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    fireEvent.change(input, { target: { value: '继续执行' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.startCodexMessage).toHaveBeenCalledWith({
      repositoryId,
      conversationId,
      message: '继续执行',
    }));
  });

  it('shows an actionable warning and disables sending when Codex CLI is unavailable', async () => {
    vi.mocked(api.getCodexStatus).mockResolvedValue({ available: false, version: null });
    render(<CodexChat />);

    expect(await screen.findByRole('alert')).toHaveTextContent('服务器未检测到可用的 Codex CLI');
    expect(screen.getByText('不可用')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '发送给 Codex 的消息' })).toBeDisabled();
    expect(api.startCodexMessage).not.toHaveBeenCalled();
  });
});
