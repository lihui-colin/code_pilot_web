// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexChat } from '../src/web/CodexChat.js';
import * as api from '../src/web/api.js';

vi.mock('../src/web/api.js', () => ({
  getCodexStatus: vi.fn(),
  getRepositories: vi.fn(),
  getRepositoryContextFiles: vi.fn(),
  streamCodexMessage: vi.fn(),
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
  vi.mocked(api.getRepositoryContextFiles).mockResolvedValue({
    files: [{ id: `file_${'b'.repeat(43)}`, relativePath: 'src/app.ts', size: 512 }],
    truncated: false,
  });
  vi.mocked(api.streamCodexMessage).mockImplementation(async (_request, onEvent) => {
    onEvent({ type: 'conversation', conversationId });
    onEvent({ type: 'assistant_delta', delta: '这是 Codex 的回答。' });
    onEvent({ type: 'done' });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it('loads the selected repository and renders a streamed conversation', async () => {
    render(<CodexChat />);
    expect(await screen.findByRole('heading', { name: 'terminal-web' })).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    fireEvent.change(input, { target: { value: '分析项目结构' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(api.streamCodexMessage).toHaveBeenCalledWith(
      { repositoryId, message: '分析项目结构' },
      expect.any(Function),
      expect.any(AbortSignal),
    ));
    expect(screen.getByText('分析项目结构')).toBeInTheDocument();
    expect(await screen.findByText('这是 Codex 的回答。')).toBeInTheDocument();
  });

  it('attaches a server-listed repository file to the next Codex message', async () => {
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'terminal-web' });
    fireEvent.click(screen.getByRole('button', { name: '＋ Add file' }));
    const filePath = await screen.findByText('src/app.ts');
    fireEvent.click(filePath.closest('button')!);
    expect(screen.getByText('已选 1/8')).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    fireEvent.change(input, { target: { value: '解释附件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(api.streamCodexMessage).toHaveBeenCalledWith(
      {
        repositoryId,
        contextFileIds: [`file_${'b'.repeat(43)}`],
        message: '解释附件',
      },
      expect.any(Function),
      expect.any(AbortSignal),
    ));
    expect(screen.getByText('📎 src/app.ts')).toBeInTheDocument();
  });

  it('continues the server-issued Codex conversation on the next message', async () => {
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'terminal-web' });
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    fireEvent.change(input, { target: { value: '第一条' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.streamCodexMessage).toHaveBeenCalledTimes(1));
    await screen.findByText('这是 Codex 的回答。');
    fireEvent.change(input, { target: { value: '继续' } });
    expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(api.streamCodexMessage).toHaveBeenLastCalledWith(
      { repositoryId, conversationId, message: '继续' },
      expect.any(Function),
      expect.any(AbortSignal),
    ));
  });

  it('shows an actionable warning and disables sending when Codex CLI is unavailable', async () => {
    vi.mocked(api.getCodexStatus).mockResolvedValue({ available: false, version: null });
    render(<CodexChat />);

    expect(await screen.findByRole('alert')).toHaveTextContent('服务器未检测到可用的 Codex CLI');
    expect(screen.getByText('不可用')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '发送给 Codex 的消息' })).toBeDisabled();
    expect(api.streamCodexMessage).not.toHaveBeenCalled();
  });
});
