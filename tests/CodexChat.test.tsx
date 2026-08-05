// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexChat } from '../src/web/CodexChat.js';
import * as api from '../src/web/api.js';

vi.mock('../src/web/api.js', () => ({
  clearCodexConversation: vi.fn(),
  getCodexAppearance: vi.fn(),
  getCodexConversation: vi.fn(),
  getCodexStatus: vi.fn(),
  getRepositories: vi.fn(),
  getRepositoryContextFiles: vi.fn(),
  subscribeCodexConversation: vi.fn(() => () => undefined),
  startCodexMessage: vi.fn(),
  stopCodexConversation: vi.fn(),
}));

const repositoryId = `dir_${'a'.repeat(43)}`;
const conversationId = '123e4567-e89b-42d3-a456-426614174000';

beforeEach(() => {
  vi.clearAllMocks();
  const storedValues = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => storedValues.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storedValues.set(key, value)),
    removeItem: vi.fn((key: string) => storedValues.delete(key)),
    clear: vi.fn(() => storedValues.clear()),
  });
  window.history.pushState({}, '', `/codex-chat?repositoryId=${repositoryId}`);
  vi.mocked(api.getRepositories).mockResolvedValue({
    current: { id: null, name: 'workspace', relativePath: '' },
    breadcrumbs: [],
    entries: [{
      id: repositoryId,
      name: 'codepilot-web',
      relativePath: 'codepilot-web',
      kind: 'repository',
      source: 'workspace',
      markers: ['git', 'node'],
      viewer: null,
      session: null,
      openVSCodeUrl: 'https://example.test/openvscode/',
    }],
  });
  vi.mocked(api.getCodexStatus).mockResolvedValue({ available: true, version: 'codex-cli 0.146.0', mode: 'yolo' });
  vi.mocked(api.getCodexAppearance).mockResolvedValue({
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: 16,
  });
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
    await screen.findByRole('heading', { name: 'codepilot-web' });
    expect(screen.queryByRole('dialog', { name: '对话信息' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开对话面板' }));
    const drawer = screen.getByRole('dialog', { name: '对话信息' });
    expect(drawer).toHaveTextContent('当前仓库');
    expect(drawer).toHaveTextContent('codex-cli 0.146.0 · 当前仓库 · YOLO 模式');
    expect(within(drawer).getAllByText('codepilot-web')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '＋ 新对话' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '对话信息' })).not.toBeInTheDocument();
  });

  it('loads the selected repository and renders a background conversation snapshot', async () => {
    render(<CodexChat />);
    expect(await screen.findByRole('heading', { name: 'codepilot-web' })).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    fireEvent.change(input, { target: { value: '分析项目结构' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(api.startCodexMessage).toHaveBeenCalledWith({ repositoryId, message: '分析项目结构' }));
    expect(screen.getByText('分析项目结构')).toBeInTheDocument();
    expect(await screen.findByText('这是 Codex 的回答。')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Codex' })).toHaveAttribute('src', '/codex-icon.svg');
    expect(screen.getByText('me')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('renders Codex output as SSE snapshots arrive', async () => {
    let onSnapshot: ((snapshot: import('../src/domain/types.js').CodexConversationSnapshot | null) => void) | undefined;
    vi.mocked(api.subscribeCodexConversation).mockImplementation((_repositoryId, listener) => {
      onSnapshot = listener;
      return () => undefined;
    });
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'codepilot-web' });
    await waitFor(() => expect(api.subscribeCodexConversation).toHaveBeenCalledWith(repositoryId, expect.any(Function)));

    act(() => onSnapshot?.({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-live', role: 'user', content: '实时输出' },
        { id: 'assistant-live', role: 'assistant', content: '第一段' },
      ],
      status: 'running',
      error: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    }));
    expect(screen.getByText('第一段')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Codex 正在继续生成' })).toBeInTheDocument();

    act(() => onSnapshot?.({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-live', role: 'user', content: '实时输出' },
        { id: 'assistant-live', role: 'assistant', content: '第一段第二段' },
      ],
      status: 'running',
      error: null,
      updatedAt: '2026-08-04T00:00:01.000Z',
    }));
    expect(screen.getByText('第一段第二段')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Codex 正在继续生成' })).toBeInTheDocument();
    const conversationWrites = () => vi.mocked(window.localStorage.setItem).mock.calls
      .filter(([key]) => key === `codepilot.codex.${repositoryId}`);
    expect(conversationWrites()).toHaveLength(0);
    await waitFor(() => expect(conversationWrites()).toHaveLength(1));

    act(() => onSnapshot?.({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-live', role: 'user', content: '实时输出' },
        { id: 'assistant-live', role: 'assistant', content: '第一段第二段' },
      ],
      status: 'running',
      error: null,
      updatedAt: '2026-08-04T00:00:01.000Z',
    }));
    await new Promise(resolve => window.setTimeout(resolve, 120));
    expect(conversationWrites()).toHaveLength(1);

    act(() => onSnapshot?.({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-live', role: 'user', content: '实时输出' },
        { id: 'assistant-live', role: 'assistant', content: '第一段第二段' },
      ],
      status: 'idle',
      error: null,
      updatedAt: '2026-08-04T00:00:02.000Z',
    }));
    expect(screen.queryByRole('status', { name: 'Codex 正在继续生成' })).not.toBeInTheDocument();
    expect(conversationWrites()).toHaveLength(2);
  });

  it('rechecks a transient unavailable CLI status when a background turn finishes', async () => {
    let onSnapshot: ((snapshot: import('../src/domain/types.js').CodexConversationSnapshot | null) => void) | undefined;
    vi.mocked(api.getCodexStatus)
      .mockResolvedValueOnce({ available: false, version: null, mode: 'yolo' })
      .mockResolvedValueOnce({ available: true, version: 'codex-cli 0.146.0', mode: 'yolo' });
    vi.mocked(api.getCodexConversation).mockResolvedValue({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-background', role: 'user', content: '后台任务' },
        { id: 'assistant-background', role: 'assistant', content: '正在处理' },
      ],
      status: 'running',
      error: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    });
    vi.mocked(api.subscribeCodexConversation).mockImplementation((_repositoryId, listener) => {
      onSnapshot = listener;
      return () => undefined;
    });

    render(<CodexChat />);

    expect(await screen.findByText('生成中')).toBeInTheDocument();
    act(() => onSnapshot?.({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-background', role: 'user', content: '后台任务' },
        { id: 'assistant-background', role: 'assistant', content: '处理完成' },
      ],
      status: 'idle',
      error: null,
      updatedAt: '2026-08-04T00:00:01.000Z',
    }));

    expect(screen.getByText('检测中')).toBeInTheDocument();
    expect(await screen.findByText('就绪')).toBeInTheDocument();
    expect(api.getCodexStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('不可用')).not.toBeInTheDocument();
  });

  it('does not pull the reader away from history while Codex is streaming', async () => {
    let onSnapshot: ((snapshot: import('../src/domain/types.js').CodexConversationSnapshot | null) => void) | undefined;
    vi.mocked(api.getCodexConversation).mockResolvedValue({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-scroll', role: 'user', content: '分析长对话' },
        { id: 'assistant-scroll', role: 'assistant', content: '已有内容' },
      ],
      status: 'running',
      error: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    });
    vi.mocked(api.subscribeCodexConversation).mockImplementation((_repositoryId, listener) => {
      onSnapshot = listener;
      return () => undefined;
    });

    const { container } = render(<CodexChat />);
    await screen.findByText('已有内容');
    await new Promise(resolve => window.setTimeout(resolve, 0));
    const messageList = container.querySelector('.chat-messages') as HTMLDivElement;
    let scrollTop = 100;
    Object.defineProperties(messageList, {
      scrollHeight: { configurable: true, get: () => 1_000 },
      clientHeight: { configurable: true, get: () => 300 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => { scrollTop = Number(top); });
    Object.defineProperty(messageList, 'scrollTo', { configurable: true, value: scrollTo });

    fireEvent.scroll(messageList);
    expect(screen.getByRole('button', { name: '↓ 回到最新消息' })).toBeInTheDocument();

    act(() => onSnapshot?.({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-scroll', role: 'user', content: '分析长对话' },
        { id: 'assistant-scroll', role: 'assistant', content: '已有内容，新增一段' },
      ],
      status: 'running',
      error: null,
      updatedAt: '2026-08-04T00:00:01.000Z',
    }));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    expect(scrollTop).toBe(100);

    fireEvent.click(screen.getByRole('button', { name: '↓ 回到最新消息' }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: '↓ 回到最新消息' })).not.toBeInTheDocument();
  });

  it('shows sandbox mode when the server does not use yolo mode', async () => {
    vi.mocked(api.getCodexStatus).mockResolvedValue({
      available: true,
      version: 'codex-cli 0.146.0',
      mode: 'sandbox',
    });
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'codepilot-web' });

    fireEvent.click(screen.getByRole('button', { name: '打开对话面板' }));
    expect(screen.getByRole('dialog', { name: '对话信息' }))
      .toHaveTextContent('codex-cli 0.146.0 · 当前仓库 · 沙箱模式');
  });

  it('uses a locally persisted personalized display name for user messages', async () => {
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'codepilot-web' });
    fireEvent.click(screen.getByRole('button', { name: '打开对话面板' }));
    fireEvent.change(screen.getByRole('textbox', { name: '我的显示名' }), { target: { value: 'Colin' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    fireEvent.change(input, { target: { value: '分析项目结构' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('Colin')).toBeInTheDocument();
    expect(screen.getByText('C', { selector: '.chat-message.user .chat-avatar' })).toBeInTheDocument();
    expect(window.localStorage.getItem('codepilot.codex.displayName')).toBe('Colin');
  });

  it('applies the configured font family and size to the chat page', async () => {
    vi.mocked(api.getCodexAppearance).mockResolvedValue({
      fontFamily: '"Noto Sans SC", sans-serif',
      fontSize: 18,
    });

    const { container } = render(<CodexChat />);
    await screen.findByRole('heading', { name: 'codepilot-web' });

    expect(container.querySelector('.chat-shell')).toHaveStyle({
      fontFamily: '"Noto Sans SC", sans-serif',
      fontSize: '18px',
    });
  });

  it('configures and persists typography from any Codex page drawer', async () => {
    const { container } = render(<CodexChat />);
    await screen.findByRole('heading', { name: 'codepilot-web' });
    fireEvent.click(screen.getByRole('button', { name: '打开对话面板' }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Codex 页面字体' }), {
      target: { value: '"Noto Sans SC", "Source Han Sans SC", sans-serif' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Codex 页面字号' }), {
      target: { value: '19' },
    });

    await waitFor(() => expect(container.querySelector('.chat-shell')).toHaveStyle({
      fontFamily: '"Noto Sans SC", "Source Han Sans SC", sans-serif',
      fontSize: '19px',
    }));
    expect(JSON.parse(window.localStorage.getItem('codepilot.codex.appearance')!)).toEqual({
      fontFamily: '"Noto Sans SC", "Source Han Sans SC", sans-serif',
      fontSize: 19,
    });

    fireEvent.click(screen.getByRole('button', { name: '恢复服务器默认' }));
    expect(container.querySelector('.chat-shell')).toHaveStyle({
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      fontSize: '16px',
    });
    const resetButton = screen.getByRole('button', { name: '恢复服务器默认' });
    expect(resetButton).toBeDisabled();
    expect(window.getComputedStyle(resetButton).cursor).toBe('default');
    expect(window.localStorage.getItem('codepilot.codex.appearance')).toBeNull();
  });

  it('starts the message input at one line and grows with wrapped content', async () => {
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'codepilot-web' });
    const input = screen.getByRole('textbox', { name: '发送给 Codex 的消息' });
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 72 });

    expect(input).toHaveAttribute('rows', '1');
    fireEvent.change(input, { target: { value: '这是一段足够长、会在输入框中自动换行显示的消息内容。' } });

    await waitFor(() => expect(input).toHaveStyle({ height: '72px' }));
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
    await screen.findByRole('heading', { name: 'codepilot-web' });
    fireEvent.click(screen.getByRole('button', { name: '＋ Add file' }));
    const sourceDirectory = await screen.findByRole('button', { name: '展开目录 src' });
    expect(screen.queryByText('app.ts')).not.toBeInTheDocument();
    fireEvent.click(sourceDirectory);
    fireEvent.click(screen.getByText('app.ts').closest('button')!);
    fireEvent.click(screen.getByText('config.ts').closest('button')!);
    expect(screen.getByRole('dialog', { name: '选择上下文文件' })).toBeInTheDocument();
    expect(screen.getByText('已选 2/8')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('heading', { name: 'codepilot-web' }));
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

  it('shows matching files in their automatically expanded directory path', async () => {
    vi.mocked(api.getRepositoryContextFiles).mockResolvedValue({
      files: [
        { id: `file_${'b'.repeat(43)}`, relativePath: 'src/components/Editor.tsx', size: 512 },
        { id: `file_${'c'.repeat(43)}`, relativePath: 'tests/Editor.test.tsx', size: 256 },
      ],
      truncated: false,
    });
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'codepilot-web' });
    fireEvent.click(screen.getByRole('button', { name: '＋ Add file' }));
    await screen.findByRole('button', { name: '展开目录 src' });

    fireEvent.change(screen.getByRole('textbox', { name: '搜索仓库文件' }), {
      target: { value: 'components/editor' },
    });

    expect(screen.getByRole('button', { name: '折叠目录 src' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '折叠目录 src/components' })).toBeInTheDocument();
    expect(screen.getByText('Editor.tsx')).toBeInTheDocument();
    expect(screen.queryByText('Editor.test.tsx')).not.toBeInTheDocument();
  });

  it('continues the server-issued Codex conversation on the next message', async () => {
    render(<CodexChat />);
    await screen.findByRole('heading', { name: 'codepilot-web' });
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
    expect(screen.getByText('生成中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
  });

  it('prefers server thread history over a stale browser snapshot', async () => {
    window.localStorage.setItem(`codepilot.codex.${repositoryId}`, JSON.stringify({
      repositoryId,
      conversationId,
      messages: [{ id: 'user-stale', role: 'user', content: '旧浏览器内容' }],
      status: 'idle',
      error: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    }));
    vi.mocked(api.getCodexConversation).mockResolvedValue({
      repositoryId,
      conversationId,
      messages: [
        { id: 'user-server', role: 'user', content: '跨设备历史' },
        { id: 'assistant-server', role: 'assistant', content: '服务端历史' },
      ],
      status: 'idle',
      error: null,
      updatedAt: '2026-08-05T00:00:00.000Z',
    });

    render(<CodexChat />);

    expect(await screen.findByText('跨设备历史')).toBeInTheDocument();
    expect(screen.getByText('服务端历史')).toBeInTheDocument();
    expect(screen.queryByText('旧浏览器内容')).not.toBeInTheDocument();
  });

  it('shows app-server startup status until the Codex handshake completes', async () => {
    vi.mocked(api.getCodexConversation).mockResolvedValue({
      repositoryId,
      conversationId: null,
      messages: [
        { id: 'user-starting', role: 'user', content: '开始任务' },
        { id: 'assistant-starting', role: 'assistant', content: '' },
      ],
      status: 'running',
      phase: 'starting',
      error: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    });

    render(<CodexChat />);

    expect(await screen.findByText('正在启动 Codex app-server…')).toBeInTheDocument();
    expect(screen.getByText('正在启动 Codex…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消启动' })).toBeInTheDocument();
  });

  it('does not keep the thinking animation after an empty failed response', async () => {
    vi.mocked(api.getCodexConversation).mockResolvedValue({
      repositoryId,
      conversationId,
      messages: [{ id: 'user-failed', role: 'user', content: '执行任务' }, {
        id: 'assistant-failed', role: 'assistant', content: '',
      }],
      status: 'failed',
      error: 'Codex is temporarily unavailable',
      updatedAt: '2026-08-04T00:00:00.000Z',
    });

    const { container } = render(<CodexChat />);

    expect(await screen.findByText('执行任务')).toBeInTheDocument();
    expect(screen.getByText('未收到回复')).toBeInTheDocument();
    expect(container.querySelector('.chat-thinking')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Codex is temporarily unavailable');
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
    vi.mocked(api.getCodexStatus).mockResolvedValue({ available: false, version: null, mode: 'yolo' });
    render(<CodexChat />);

    expect(await screen.findByRole('alert')).toHaveTextContent('服务器未检测到可用的 Codex CLI');
    expect(screen.getByText('不可用')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '发送给 Codex 的消息' })).toBeDisabled();
    expect(api.startCodexMessage).not.toHaveBeenCalled();
  });
});
