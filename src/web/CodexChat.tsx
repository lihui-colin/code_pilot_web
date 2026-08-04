import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type {
  CodexChatMessageSnapshot,
  CodexCliStatus,
  CodexConversationSnapshot,
  RepositoryContextFile,
  RepositoryEntryResponse,
} from '../domain/types.js';
import {
  clearCodexConversation,
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
  const [messages, setMessages] = useState<CodexChatMessageSnapshot[]>([]);
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
  const [filesLoading, setFilesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<CodexChatMessageSnapshot[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const filePickerRef = useRef<HTMLElement | null>(null);
  const filePickerTriggerRef = useRef<HTMLButtonElement | null>(null);

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
    void Promise.all([getRepositories(), getCodexStatus(), getCodexConversation(repositoryId)]).then(([listing, status, serverConversation]) => {
      const selected = listing.entries.find(entry => entry.id === repositoryId);
      if (!selected) throw new Error('仓库不存在或已经不可用');
      setRepository(selected);
      setCodexStatus(status);
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
    .filter(file => !normalizedFileSearch || file.relativePath.toLocaleLowerCase().includes(normalizedFileSearch))
    .slice(0, 100);

  return (
    <main className="chat-shell">
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
            <div className="chat-repository-card">
              <small>当前仓库</small>
              <strong>{repository?.name ?? (loading ? '加载中…' : '不可用')}</strong>
              <span>{repository?.relativePath || '.'}</span>
            </div>
            <p className="chat-security-note">
              {codexStatus?.available
                ? `${codexStatus.version ?? 'Codex CLI'} · 当前仓库 · workspace-write 沙箱`
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
              <div className="chat-avatar">{message.role === 'user' ? '你' : 'C'}</div>
              <div className="chat-message-body">
                <strong>{message.role === 'user' ? '你' : 'Codex'}</strong>
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
                {!filesLoading && visibleContextFiles.map(file => {
                  const selected = selectedContextFiles.some(candidate => candidate.id === file.id);
                  return (
                    <button
                      type="button"
                      className={selected ? 'selected' : ''}
                      key={file.id}
                      onClick={() => toggleContextFile(file)}
                      disabled={!selected && selectedContextFiles.length >= 8}
                    >
                      <span>{selected ? '✓' : '+'}</span>
                      <code>{file.relativePath}</code>
                      <small>{Math.max(1, Math.ceil(file.size / 1024))} KiB</small>
                    </button>
                  );
                })}
                {!filesLoading && visibleContextFiles.length === 0 && <p>没有匹配的可附加文本文件。</p>}
              </div>
              {(contextFilesTruncated || visibleContextFiles.length === 100) && (
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
              aria-label="发送给 Codex 的消息"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="给 Codex 发送消息…"
              rows={3}
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
