// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/web/App.js';
import * as api from '../src/web/api.js';

vi.mock('../src/web/api.js', () => ({
  addManualRepository: vi.fn(),
  createSession: vi.fn(),
  createViewer: vi.fn(),
  deleteManualRepository: vi.fn(),
  deleteSession: vi.fn(),
  deleteZellijToken: vi.fn(),
  getReadiness: vi.fn(),
  getRepositoryFolders: vi.fn(),
  getRepositories: vi.fn(),
  getSessions: vi.fn(),
  getZellijToken: vi.fn(),
  regenerateZellijToken: vi.fn(),
  restartServices: vi.fn(),
}));

const readiness = {
  status: 'ready' as const,
  checks: { workspaceRoot: true, directoryIdSecret: true, node: true, zellij: true, codeViewer: true },
};
const repositories = {
  current: { id: null, name: 'workspace', relativePath: '' },
  breadcrumbs: [{ id: null, name: 'workspace', relativePath: '' }],
  entries: [],
};
const openVSCodeUrl = 'https://192.0.2.10:8024/openvscode/?folder=%2Fworkspace%2Fterminal-web';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getReadiness).mockResolvedValue(readiness);
  vi.mocked(api.getRepositories).mockResolvedValue(repositories);
  vi.mocked(api.getRepositoryFolders).mockResolvedValue({
    current: { id: `folder_${'r'.repeat(43)}`, name: '/', gitRepository: false },
    parentId: null,
    entries: [],
  });
  vi.mocked(api.addManualRepository).mockResolvedValue(`dir_${'m'.repeat(43)}`);
  vi.mocked(api.deleteManualRepository).mockResolvedValue(undefined);
  vi.mocked(api.getSessions).mockResolvedValue([{
    name: 'alpha',
    status: 'running',
    origin: 'external',
    repositoryId: null,
    relativePath: null,
    createdAt: null,
    command: null,
    webUrl: 'https://192.0.2.10:8024/zellij/alpha',
  }]);
  vi.mocked(api.getZellijToken).mockResolvedValue({
    name: 'terminal-web-test',
    value: '123e4567-e89b-42d3-a456-426614174000',
  });
  vi.mocked(api.regenerateZellijToken).mockResolvedValue({
    name: 'terminal-web-new',
    value: '123e4567-e89b-42d3-a456-426614174001',
  });
  vi.mocked(api.deleteZellijToken).mockResolvedValue(undefined);
  vi.mocked(api.deleteSession).mockResolvedValue(undefined);
  vi.mocked(api.createSession).mockResolvedValue({
    name: 'terminal-web', status: 'running', origin: 'managed', repositoryId: `dir_${'a'.repeat(43)}`,
    relativePath: 'terminal-web', createdAt: '2026-08-02T00:00:00.000Z', command: 'codex',
    webUrl: 'https://192.0.2.10:8024/zellij/terminal-web',
  });
  vi.mocked(api.createViewer).mockResolvedValue({
    id: `viewer_${'b'.repeat(22)}`, repositoryId: `dir_${'a'.repeat(43)}`, pid: 123,
    upstreamUrl: 'http://127.0.0.1:8022', webUrl: `http://192.0.2.10:8024/viewer/viewer_${'b'.repeat(22)}/`,
    createdAt: '2026-08-02T00:00:00.000Z', lastAccessedAt: '2026-08-02T00:00:00.000Z', status: 'running',
  });
  vi.mocked(api.restartServices).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('confirms and requests a restart of all managed backend services', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.restartServices).mockReturnValue(new Promise(() => undefined));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '重启后台服务' }));

    await waitFor(() => expect(api.restartServices).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '服务重启中…' })).toBeDisabled();
  });

  it('opens Session links safely in a new tab', async () => {
    render(<App />);
    const link = await screen.findByRole('link', { name: '打开' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('href', 'https://192.0.2.10:8024/zellij/alpha');
  });

  it('still shows Sessions and the token while readiness is degraded', async () => {
    vi.mocked(api.getReadiness).mockResolvedValue({
      status: 'not_ready',
      checks: { ...readiness.checks, node: false, codeViewer: false },
    });
    render(<App />);
    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('terminal-web-test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制 Token' })).toBeInTheDocument();
    expect(screen.getByText('未就绪')).toBeInTheDocument();
  });

  it('deletes a Session from the Zellij management table after exact-name confirmation', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('alpha');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith('alpha'));
    expect(prompt).toHaveBeenCalledWith('删除会终止 Session 中的所有进程。请输入 alpha 确认删除：');
    await waitFor(() => expect(api.getSessions).toHaveBeenCalledTimes(2));
    expect(api.getRepositories).toHaveBeenCalledTimes(2);
  });

  it('does not delete a Session when the confirmation name does not match', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('wrong-name');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    expect(api.deleteSession).not.toHaveBeenCalled();
  });

  it('shows the Zellij Web token name and value with management actions', async () => {
    render(<App />);
    expect(await screen.findByText('terminal-web-test')).toBeInTheDocument();
    expect(screen.getByText('123e4567-e89b-42d3-a456-426614174000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制 Token' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新创建' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除 Token' })).toBeInTheDocument();
  });

  it('confirms when the Zellij Web token is copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '复制 Token' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('123e4567-e89b-42d3-a456-426614174000'));
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Token 已复制');
  });

  it('recreates the Zellij Web token and shows its new name and value', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '重新创建' }));
    await waitFor(() => expect(api.regenerateZellijToken).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('terminal-web-new')).toBeInTheDocument();
    expect(screen.getByText('123e4567-e89b-42d3-a456-426614174001')).toBeInTheDocument();
  });

  it('deletes the Zellij Web token and offers to create one again', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '删除 Token' }));
    await waitFor(() => expect(api.deleteZellijToken).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('当前没有 Zellij Web Token。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建 Token' })).toBeInTheDocument();
  });

  it('pauses polling while hidden and refreshes immediately when visible', async () => {
    vi.useFakeTimers();
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    render(<App />);
    await act(async () => Promise.resolve());
    expect(api.getSessions).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(api.getSessions).toHaveBeenCalledTimes(2);

    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(api.getSessions).toHaveBeenCalledTimes(2);

    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(api.getSessions).toHaveBeenCalledTimes(3);
  });

  it('shows a flat Git repository result list without navigation controls', async () => {
    vi.mocked(api.getRepositories).mockResolvedValue({
      ...repositories,
      entries: [{
        id: `dir_${'a'.repeat(43)}`,
        name: 'terminal-web',
        relativePath: 'terminal-web',
        kind: 'repository',
        source: 'workspace',
        markers: ['git', 'node'],
        openVSCodeUrl,
        viewer: null,
        session: null,
      }],
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Git 仓库' })).toBeInTheDocument();
    expect((await screen.findAllByText('terminal-web')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Git 仓库' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '进入' })).not.toBeInTheDocument();
    const zellijAction = screen.getByRole('button', { name: '创建 Zellij Session' });
    const moreActions = screen.getByLabelText('terminal-web 更多操作').closest('.repository-more');
    expect(zellijAction.closest('.repository-more')).toBeNull();
    fireEvent.click(screen.getByLabelText('terminal-web 更多操作'));
    expect(screen.getByRole('button', { name: 'code-viewer' }).closest('.repository-more')).toBe(moreActions);
    expect(screen.getByRole('link', { name: '编辑代码' }).closest('.repository-more')).toBe(moreActions);
    const codexLink = screen.getByRole('link', { name: '与 Codex 对话' });
    expect(codexLink.closest('.repository-more')).toBeNull();
    expect(codexLink).toHaveAttribute('href', `/codex-chat?repositoryId=dir_${'a'.repeat(43)}`);
    expect(codexLink).toHaveAttribute('target', '_blank');
  });

  it('closes repository more actions on outside click and Escape', async () => {
    vi.mocked(api.getRepositories).mockResolvedValue({
      ...repositories,
      entries: [{
        id: `dir_${'a'.repeat(43)}`,
        name: 'terminal-web',
        relativePath: 'terminal-web',
        kind: 'repository',
        source: 'workspace',
        markers: ['git', 'node'],
        openVSCodeUrl,
        viewer: null,
        session: null,
      }],
    });
    render(<App />);
    const trigger = await screen.findByLabelText('terminal-web 更多操作');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });

  it('opens the server folder picker and adds a selected Git repository', async () => {
    const folderId = `folder_${'f'.repeat(43)}`;
    vi.mocked(api.getRepositoryFolders).mockResolvedValue({
      current: { id: `folder_${'r'.repeat(43)}`, name: '/', gitRepository: false },
      parentId: null,
      entries: [{ id: folderId, name: 'external-project', gitRepository: true }],
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '添加文件夹' }));
    expect(await screen.findByRole('dialog', { name: '打开服务器 Git 仓库' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '选择 Git 仓库' }));

    await waitFor(() => expect(api.addManualRepository).toHaveBeenCalledWith(folderId));
    await waitFor(() => expect(api.getRepositories).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog', { name: '打开服务器 Git 仓库' })).not.toBeInTheDocument();
  });

  it('removes a manually added repository without deleting files', async () => {
    const repositoryId = `dir_${'m'.repeat(43)}`;
    vi.mocked(api.getRepositories).mockResolvedValue({
      ...repositories,
      entries: [{
        id: repositoryId, name: 'external-project', relativePath: '/srv/external-project',
        kind: 'repository', source: 'manual', markers: ['git'], openVSCodeUrl, viewer: null, session: null,
      }],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByLabelText('external-project 更多操作'));
    fireEvent.click(await screen.findByRole('button', { name: '移除仓库' }));
    await waitFor(() => expect(api.deleteManualRepository).toHaveBeenCalledWith(repositoryId));
  });

  it('opens the repository-specific OpenVSCode folder URL', async () => {
    vi.mocked(api.getRepositories).mockResolvedValue({
      ...repositories,
      entries: [{
        id: `dir_${'a'.repeat(43)}`, name: 'terminal-web', relativePath: 'terminal-web',
        kind: 'repository', source: 'workspace', markers: ['git', 'node'], openVSCodeUrl, viewer: null, session: null,
      }],
    });
    render(<App />);
    fireEvent.click(await screen.findByLabelText('terminal-web 更多操作'));
    const link = await screen.findByRole('link', { name: '编辑代码' });
    expect(link).toHaveAttribute('href', openVSCodeUrl);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('creates the deterministic Zellij Session for a repository', async () => {
    vi.mocked(api.getRepositories).mockResolvedValue({
      ...repositories,
      entries: [{
        id: `dir_${'a'.repeat(43)}`, name: 'terminal-web', relativePath: 'terminal-web',
        kind: 'repository', source: 'workspace', markers: ['git', 'node'], openVSCodeUrl, viewer: null, session: null,
      }],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '创建 Zellij Session' }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith(`dir_${'a'.repeat(43)}`));
  });

  it('copies the token when opening and can delete an existing repository Session', async () => {
    const sessionName = 'terminal-web';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(api.getRepositories).mockResolvedValue({
      ...repositories,
      entries: [{
        id: `dir_${'a'.repeat(43)}`, name: 'terminal-web', relativePath: 'terminal-web',
        kind: 'repository', source: 'workspace', markers: ['git', 'node'], openVSCodeUrl, viewer: null,
        session: { name: sessionName, status: 'running', webUrl: `https://192.0.2.10:8024/zellij/${sessionName}` },
      }],
    });
    vi.spyOn(window, 'prompt').mockReturnValue(sessionName);
    render(<App />);
    const link = await screen.findByRole('link', { name: '打开 Zellij Web' });
    expect(link).toHaveAttribute('href', `https://192.0.2.10:8024/zellij/${sessionName}`);
    expect(link).toHaveAttribute('target', '_blank');
    fireEvent.click(link);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('123e4567-e89b-42d3-a456-426614174000'));
    expect(screen.getByRole('status')).toHaveTextContent('Token 已复制');
    fireEvent.click(screen.getByLabelText('terminal-web 更多操作'));
    fireEvent.click(screen.getByRole('button', { name: '删除 Session' }));
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith(sessionName));
  });

  it('opens a blank tab before starting code-viewer and navigates it on success', async () => {
    vi.mocked(api.getRepositories).mockResolvedValue({
      ...repositories,
      entries: [{
        id: `dir_${'a'.repeat(43)}`, name: 'terminal-web', relativePath: 'terminal-web',
        kind: 'repository', source: 'workspace', markers: ['git', 'node'], openVSCodeUrl, viewer: null, session: null,
      }],
    });
    const replace = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue({
      location: { replace },
      close: vi.fn(),
    } as unknown as Window);
    render(<App />);
    fireEvent.click(await screen.findByLabelText('terminal-web 更多操作'));
    fireEvent.click(await screen.findByRole('button', { name: 'code-viewer' }));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`http://192.0.2.10:8024/viewer/viewer_${'b'.repeat(22)}/`));
  });
});
