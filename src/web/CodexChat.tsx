import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type {
  CodexChatAppearance,
  CodexChatMessageSnapshot,
  CodexCliStatus,
  CodexConversationSnapshot,
  RepositoryContextFile,
  RepositoryEntryResponse,
} from '../domain/types.js';
import {
  clearCodexConversation,
  getCodexAppearance,
  getCodexConversation,
  getCodexStatus,
  getRepositories,
  getRepositoryContextFiles,
  startCodexMessage,
  stopCodexConversation,
} from './api.js';

const suggestions = [
  '介绍这个项目的架构和主要模块',
  '检查当前代码中可能存在的安全问题',
  '运行相关测试并分析失败原因',
];

const displayNameStorageKey = 'codepilot.codex.displayName';
const appearanceStorageKey = 'codepilot.codex.appearance';
const defaultAppearance: CodexChatAppearance = {
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  fontSize: 16,
};
const fontOptions = [
  { label: '系统默认', value: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  { label: '思源黑体 / Noto Sans SC', value: '"Noto Sans SC", "Source Han Sans SC", sans-serif' },
  { label: '微软雅黑', value: '"Microsoft YaHei", sans-serif' },
  { label: '苹方', value: '"PingFang SC", sans-serif' },
  { label: '宋体', value: 'SimSun, serif' },
  { label: '系统衬线字体', value: 'ui-serif, Georgia, serif' },
  { label: '系统等宽字体', value: 'ui-monospace, "SFMono-Regular", Consolas, monospace' },
];

interface ContextFileTreeDirectory {
  type: 'directory';
  name: string;
  path: string;
  children: ContextFileTreeNode[];
}

interface ContextFileTreeFile {
  type: 'file';
  name: string;
  path: string;
  file: RepositoryContextFile;
}

type ContextFileTreeNode = ContextFileTreeDirectory | ContextFileTreeFile;

function buildContextFileTree(files: RepositoryContextFile[]): ContextFileTreeNode[] {
  const root: ContextFileTreeDirectory = { type: 'directory', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.relativePath.split('/');
    let directory = root;
    for (const [index, part] of parts.entries()) {
      const nodePath = parts.slice(0, index + 1).join('/');
      if (index === parts.length - 1) {
        directory.children.push({ type: 'file', name: part, path: nodePath, file });
        continue;
      }
      let child = directory.children.find(node => node.type === 'directory' && node.name === part);
      if (!child || child.type !== 'directory') {
        child = { type: 'directory', name: part, path: nodePath, children: [] };
        directory.children.push(child);
      }
      directory = child;
    }
  }
  const sortNodes = (nodes: ContextFileTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    for (const node of nodes) if (node.type === 'directory') sortNodes(node.children);
  };
  sortNodes(root.children);
  return root.children;
}

function readStoredDisplayName(): string {
  try {
    return window.localStorage?.getItem?.(displayNameStorageKey) ?? '';
  } catch {
    return '';
  }
}

function readStoredAppearance(): CodexChatAppearance | null {
  try {
    const value = window.localStorage?.getItem?.(appearanceStorageKey);
    if (!value) return null;
    const stored = JSON.parse(value) as Partial<CodexChatAppearance>;
    if (typeof stored.fontFamily !== 'string' || !stored.fontFamily.trim()) return null;
    if (!Number.isInteger(stored.fontSize) || stored.fontSize! < 12 || stored.fontSize! > 24) return null;
    return { fontFamily: stored.fontFamily.trim(), fontSize: stored.fontSize! };
  } catch {
    return null;
  }
}

function conversationStorageKey(repositoryId: string): string {
  return `codepilot.codex.${repositoryId}`;
}

function readStoredConversation(repositoryId: string): CodexConversationSnapshot | null {
  try {
    const value = window.localStorage?.getItem?.(conversationStorageKey(repositoryId));
    if (!value) return null;
    const snapshot = JSON.parse(value) as CodexConversationSnapshot;
    return snapshot.status === 'running'
      ? {
          ...snapshot,
          status: 'stopped',
          error: '后台服务已重启，上次运行已中断；可以发送下一条消息继续该 Codex 会话。',
        }
      : snapshot;
  } catch {
    return null;
  }
}

export function CodexChat() {
  const repositoryId = new URLSearchParams(window.location.search).get('repositoryId');
  const [repository, setRepository] = useState<RepositoryEntryResponse | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null);
  const [configuredAppearance, setConfiguredAppearance] = useState(defaultAppearance);
  const [appearanceOverride, setAppearanceOverride] = useState<CodexChatAppearance | null>(readStoredAppearance);
  const [messages, setMessages] = useState<CodexChatMessageSnapshot[]>([]);
  const [displayNameInput, setDisplayNameInput] = useState(readStoredDisplayName);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [contextFiles, setContextFiles] = useState<RepositoryContextFile[] | null>(null);
  const [selectedContextFiles, setSelectedContextFiles] = useState<RepositoryContextFile[]>([]);
  const [contextFilesTruncated, setContextFilesTruncated] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const [filesLoading, setFilesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<CodexChatMessageSnapshot[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const filePickerRef = useRef<HTMLElement | null>(null);
  const filePickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const displayName = displayNameInput.trim() || 'me';
  const displayAvatar = Array.from(displayName)[0]?.toLocaleUpperCase() ?? 'M';
  const appearance = appearanceOverride ?? configuredAppearance;
  const availableFontOptions = fontOptions.some(option => option.value === appearance.fontFamily)
    ? fontOptions
    : [{ label: '当前自定义字体', value: appearance.fontFamily }, ...fontOptions];

  const updateDisplayName = (value: string) => {
    const nextValue = value.slice(0, 24);
    setDisplayNameInput(nextValue);
    try {
      if (nextValue.trim()) window.localStorage?.setItem?.(displayNameStorageKey, nextValue.trim());
      else window.localStorage?.removeItem?.(displayNameStorageKey);
    } catch {
      // The preference remains active for this page when browser storage is unavailable.
    }
  };

  const updateAppearance = (nextAppearance: CodexChatAppearance) => {
    setAppearanceOverride(nextAppearance);
    try {
      window.localStorage?.setItem?.(appearanceStorageKey, JSON.stringify(nextAppearance));
    } catch {
      // The preference remains active for this page when browser storage is unavailable.
    }
  };

  const resetAppearance = () => {
    setAppearanceOverride(null);
    try {
      window.localStorage?.removeItem?.(appearanceStorageKey);
    } catch {
      // The server defaults still apply for this page when browser storage is unavailable.
    }
  };

  const applySnapshot = (snapshot: CodexConversationSnapshot | null, preserveHistory = true) => {
    const sameConversation = snapshot?.conversationId
      && conversationIdRef.current
      && snapshot.conversationId === conversationIdRef.current;
    const nextMessages = snapshot && preserveHistory && sameConversation
      ? [
          ...messagesRef.current.filter(message => !snapshot.messages.some(candidate => candidate.id === message.id)),
          ...snapshot.messages,
        ]
      : snapshot?.messages ?? [];
    messagesRef.current = nextMessages;
    conversationIdRef.current = snapshot?.conversationId ?? null;
    setMessages(nextMessages);
    setConversationId(conversationIdRef.current);
    setRunning(snapshot?.status === 'running');
    setError(snapshot?.error ?? null);
    if (!repositoryId) return;
    try {
      if (snapshot) window.localStorage?.setItem?.(conversationStorageKey(repositoryId), JSON.stringify({
        ...snapshot,
        messages: nextMessages,
      }));
      else window.localStorage?.removeItem?.(conversationStorageKey(repositoryId));
    } catch {
      // Conversation recovery still works from the server when browser storage is unavailable.
    }
  };

  useEffect(() => {
    document.title = 'Codex 对话 · CodePilot Web';
    if (!repositoryId) {
      setError('缺少 repository ID，请从管理首页打开 Codex 对话。');
      setLoading(false);
      return;
    }
    void Promise.all([
      getRepositories(),
      getCodexStatus(),
      getCodexAppearance(),
      getCodexConversation(repositoryId),
    ]).then(([listing, status, configuredAppearance, serverConversation]) => {
      const selected = listing.entries.find(entry => entry.id === repositoryId);
      if (!selected) throw new Error('仓库不存在或已经不可用');
      setRepository(selected);
      setCodexStatus(status);
      setConfiguredAppearance(configuredAppearance);
      const storedConversation = readStoredConversation(repositoryId);
      const restoredConversation = serverConversation && storedConversation
        && serverConversation.conversationId === storedConversation.conversationId
        ? { ...serverConversation, messages: storedConversation.messages }
        : serverConversation ?? storedConversation;
      applySnapshot(restoredConversation);
      if (!status.available) {
        setError('服务器未检测到可用的 Codex CLI。请确认 codex 已安装、可执行，并已加入后台服务用户的 PATH，然后刷新页面。');
      }
    }).catch(caught => {
      setError(caught instanceof Error ? caught.message : '仓库加载失败');
    }).finally(() => setLoading(false));
  }, [repositoryId]);

  useEffect(() => {
    if (!repositoryId || !running) return;
    const timer = window.setInterval(() => {
      void getCodexConversation(repositoryId).then(applySnapshot).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [repositoryId, running]);

  useEffect(() => {
    if (typeof messagesEnd.current?.scrollIntoView === 'function') {
      messagesEnd.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages]);

  useEffect(() => {
    const input = draftInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    if (!panelOpen && !filePickerOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (filePickerOpen) setFilePickerOpen(false);
      else setPanelOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [filePickerOpen, panelOpen]);

  useEffect(() => {
    if (!filePickerOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (filePickerRef.current?.contains(target) || filePickerTriggerRef.current?.contains(target)) return;
      setFilePickerOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [filePickerOpen]);

  const openFilePicker = async () => {
    if (!repositoryId || running) return;
    setFilePickerOpen(true);
    if (contextFiles) return;
    setFilesLoading(true);
    try {
      const listing = await getRepositoryContextFiles(repositoryId);
      setContextFiles(listing.files);
      setContextFilesTruncated(listing.truncated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '仓库文件加载失败');
      setFilePickerOpen(false);
    } finally {
      setFilesLoading(false);
    }
  };

  const toggleContextFile = (file: RepositoryContextFile) => {
    setSelectedContextFiles(current => {
      if (current.some(selected => selected.id === file.id)) {
        return current.filter(selected => selected.id !== file.id);
      }
      return current.length < 8 ? [...current, file] : current;
    });
  };

  const toggleDirectory = (directoryPath: string) => {
    setExpandedDirectories(current => {
      const next = new Set(current);
      if (next.has(directoryPath)) next.delete(directoryPath);
      else next.add(directoryPath);
      return next;
    });
  };

  const send = async (message = draft) => {
    const content = message.trim();
    if (!content || !repositoryId || !repository || !codexStatus?.available || running) return;
    const attachedFiles = selectedContextFiles;
    setDraft('');
    setSelectedContextFiles([]);
    setFilePickerOpen(false);
    setError(null);
    setRunning(true);
    try {
      const snapshot = await startCodexMessage({
        repositoryId,
        ...(conversationId ? { conversationId } : {}),
        ...(attachedFiles.length > 0 ? { contextFileIds: attachedFiles.map(file => file.id) } : {}),
        message: content,
      });
      applySnapshot(snapshot);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Codex 请求失败');
      setRunning(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const startNewConversation = async () => {
    if (running) return;
    if (!repositoryId) return;
    try {
      await clearCodexConversation(repositoryId);
      applySnapshot(null, false);
      setSelectedContextFiles([]);
      setFilePickerOpen(false);
      setError(null);
      setPanelOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '新对话创建失败');
    }
  };

  const stop = async () => {
    if (!repositoryId || !running) return;
    try {
      await stopCodexConversation(repositoryId);
      const snapshot = await getCodexConversation(repositoryId);
      applySnapshot(snapshot);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Codex 停止失败');
    }
  };

  const normalizedFileSearch = fileSearch.trim().toLocaleLowerCase();
  const visibleContextFiles = (contextFiles ?? [])
    .filter(file => !normalizedFileSearch || file.relativePath.toLocaleLowerCase().includes(normalizedFileSearch));
  const contextFileTree = buildContextFileTree(visibleContextFiles);
  const renderContextFileTree = (nodes: ContextFileTreeNode[]): ReactNode => (
    <ul className="chat-file-tree">
      {nodes.map(node => {
        if (node.type === 'directory') {
          const expanded = Boolean(normalizedFileSearch) || expandedDirectories.has(node.path);
          return (
            <li className="directory" key={node.path}>
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${expanded ? '折叠' : '展开'}目录 ${node.path}`}
                onClick={() => toggleDirectory(node.path)}
              >
                <span>{expanded ? '▾' : '▸'}</span>
                <strong>{node.name}</strong>
              </button>
              {expanded && renderContextFileTree(node.children)}
            </li>
          );
        }
        const selected = selectedContextFiles.some(candidate => candidate.id === node.file.id);
        return (
          <li className="file" key={node.file.id}>
            <button
              type="button"
              className={selected ? 'selected' : ''}
              onClick={() => toggleContextFile(node.file)}
              disabled={!selected && selectedContextFiles.length >= 8}
              title={node.path}
            >
              <span>{selected ? '✓' : '+'}</span>
              <code>{node.name}</code>
              <small>{Math.max(1, Math.ceil(node.file.size / 1024))} KiB</small>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <main
      className="chat-shell"
      style={{ fontFamily: appearance.fontFamily, fontSize: `${appearance.fontSize}px` }}
    >
      {panelOpen && (
        <>
          <button
            className="chat-panel-backdrop"
            type="button"
            aria-label="关闭对话面板"
            onClick={() => setPanelOpen(false)}
          />
          <aside className="chat-sidebar" role="dialog" aria-modal="true" aria-label="对话信息">
            <div className="chat-sidebar-heading">
              <a className="chat-back-link" href="/">← 返回管理首页</a>
              <button type="button" aria-label="关闭对话面板" onClick={() => setPanelOpen(false)}>×</button>
            </div>
            <div className="chat-brand"><span>CODEPILOT</span><strong>Codex 对话</strong></div>
            <button type="button" onClick={() => void startNewConversation()} disabled={running}>＋ 新对话</button>
            <label className="chat-display-name">
              <span>我的显示名</span>
              <input
                value={displayNameInput}
                onChange={event => updateDisplayName(event.target.value)}
                placeholder="me"
                maxLength={24}
              />
            </label>
            <div className="chat-appearance-settings">
              <label>
                <span>字体</span>
                <select
                  aria-label="Codex 页面字体"
                  value={appearance.fontFamily}
                  onChange={event => updateAppearance({ ...appearance, fontFamily: event.target.value })}
                >
                  {availableFontOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>字号</span>
                <input
                  aria-label="Codex 页面字号"
                  type="number"
                  min={12}
                  max={24}
                  step={1}
                  value={appearance.fontSize}
                  onChange={event => {
                    const fontSize = Number(event.target.value);
                    if (Number.isInteger(fontSize) && fontSize >= 12 && fontSize <= 24) {
                      updateAppearance({ ...appearance, fontSize });
                    }
                  }}
                />
              </label>
              <button
                className="chat-appearance-reset"
                type="button"
                aria-label="恢复服务器默认"
                onClick={resetAppearance}
                disabled={!appearanceOverride}
              >系统默认</button>
            </div>
            <div className="chat-repository-card">
              <small>当前仓库</small>
              <strong>{repository?.name ?? (loading ? '加载中…' : '不可用')}</strong>
              {repository?.relativePath && repository.relativePath !== repository.name
                ? <span>{repository.relativePath}</span>
                : null}
            </div>
            <p className="chat-security-note">
              {codexStatus?.available
                ? `${codexStatus.version ?? 'Codex CLI'} · 当前仓库 · ${codexStatus.mode === 'yolo' ? 'YOLO 模式' : '沙箱模式'}`
                : '发送消息前会检测后台服务是否可以调用 Codex CLI。'}
            </p>
          </aside>
        </>
      )}

      <section className="chat-main">
        <header className="chat-header">
          <div className="chat-header-copy">
            <button
              className="chat-panel-toggle"
              type="button"
              aria-label="打开对话面板"
              aria-expanded={panelOpen}
              onClick={() => setPanelOpen(true)}
            >☰</button>
            <div><small>CODING AGENT</small><h1>{repository?.name ?? 'Codex'}</h1></div>
          </div>
          <span className={running ? 'chat-status busy' : `chat-status${codexStatus && !codexStatus.available ? ' unavailable' : ''}`}>
            {running ? '处理中' : codexStatus?.available ? '就绪' : loading ? '检测中' : '不可用'}
          </span>
        </header>

        <div className="chat-messages" aria-live="polite">
          {error && <div className="error" role="alert">{error}</div>}
          {!loading && repository && codexStatus?.available && messages.length === 0 && (
            <div className="chat-empty">
              <div className="chat-orb">&gt;_</div>
              <h2>向 Codex 提问</h2>
              <p>可以让 Codex 阅读代码、修改文件、运行测试并解释结果。</p>
              <div className="chat-suggestions">
                {suggestions.map(suggestion => (
                  <button key={suggestion} type="button" onClick={() => void send(suggestion)}>{suggestion}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map(message => (
            <article className={`chat-message ${message.role}`} key={message.id}>
              <div className="chat-avatar">{message.role === 'user' ? displayAvatar : 'C'}</div>
              <div className="chat-message-body">
                <strong>{message.role === 'user' ? displayName : 'Codex'}</strong>
                {message.content
                  ? (
                    <div className="chat-message-content">
                      {message.contextFiles && message.contextFiles.length > 0 && (
                        <div className="chat-message-files">
                          {message.contextFiles.map(file => <span key={file}>📎 {file}</span>)}
                        </div>
                      )}
                      <div className="chat-message-text">{message.content}</div>
                    </div>
                  )
                  : <div className="chat-thinking"><i /><i /><i /></div>}
              </div>
            </article>
          ))}
          <div ref={messagesEnd} />
        </div>

        <div className="chat-composer-wrap">
          {filePickerOpen && (
            <section ref={filePickerRef} className="chat-file-picker" role="dialog" aria-label="选择上下文文件">
              <div className="chat-file-picker-heading">
                <div><strong>Add file</strong><small>最多选择 8 个文本文件</small></div>
                <button type="button" aria-label="关闭文件选择" onClick={() => setFilePickerOpen(false)}>×</button>
              </div>
              <input
                aria-label="搜索仓库文件"
                value={fileSearch}
                onChange={event => setFileSearch(event.target.value)}
                placeholder="搜索相对路径…"
              />
              <div className="chat-file-list">
                {filesLoading && <p>正在读取仓库文件…</p>}
                {!filesLoading && renderContextFileTree(contextFileTree)}
                {!filesLoading && visibleContextFiles.length === 0 && <p>没有匹配的可附加文本文件。</p>}
              </div>
              {contextFilesTruncated && (
                <small className="chat-file-limit-note">文件较多，请通过路径搜索缩小范围。</small>
              )}
            </section>
          )}
          <form className="chat-composer" onSubmit={submit}>
            {selectedContextFiles.length > 0 && (
              <div className="chat-selected-files">
                {selectedContextFiles.map(file => (
                  <button type="button" key={file.id} onClick={() => toggleContextFile(file)} title="移除附件">
                    <span>📎 {file.relativePath}</span><b>×</b>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={draftInputRef}
              aria-label="发送给 Codex 的消息"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="给 Codex 发送消息…"
              rows={1}
              maxLength={20_000}
              disabled={!repository || !codexStatus?.available || running}
            />
            <div className="chat-composer-footer">
              <div className="chat-composer-tools">
                <button
                  ref={filePickerTriggerRef}
                  type="button"
                  onClick={() => void openFilePicker()}
                  disabled={!repository || !codexStatus?.available || running}
                >＋ Add file</button>
                <span>{selectedContextFiles.length > 0 ? `已选 ${selectedContextFiles.length}/8` : 'Enter 发送 · Shift+Enter 换行'}</span>
              </div>
              {running ? (
                <button className="danger-button" type="button" onClick={() => void stop()}>停止</button>
              ) : (
                <button type="submit" disabled={!draft.trim() || !repository || !codexStatus?.available}>发送</button>
              )}
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
