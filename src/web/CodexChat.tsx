import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CodexCliStatus, RepositoryContextFile, RepositoryEntryResponse } from '../domain/types.js';
import { getCodexStatus, getRepositories, getRepositoryContextFiles, streamCodexMessage } from './api.js';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  contextFiles?: string[];
}

const suggestions = [
  '介绍这个项目的架构和主要模块',
  '检查当前代码中可能存在的安全问题',
  '运行相关测试并分析失败原因',
];

function newMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function CodexChat() {
  const repositoryId = new URLSearchParams(window.location.search).get('repositoryId');
  const [repository, setRepository] = useState<RepositoryEntryResponse | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  const abortController = useRef<AbortController | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.title = 'Codex 对话 · CodePilot Web';
    if (!repositoryId) {
      setError('缺少 repository ID，请从管理首页打开 Codex 对话。');
      setLoading(false);
      return;
    }
    void Promise.all([getRepositories(), getCodexStatus()]).then(([listing, status]) => {
      const selected = listing.entries.find(entry => entry.id === repositoryId);
      if (!selected) throw new Error('仓库不存在或已经不可用');
      setRepository(selected);
      setCodexStatus(status);
      if (!status.available) {
        setError('服务器未检测到可用的 Codex CLI。请确认 codex 已安装、可执行，并已加入后台服务用户的 PATH，然后刷新页面。');
      }
    }).catch(caught => {
      setError(caught instanceof Error ? caught.message : '仓库加载失败');
    }).finally(() => setLoading(false));
    return () => abortController.current?.abort();
  }, [repositoryId]);

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
    const userMessage: ChatMessage = {
      id: newMessageId('user'),
      role: 'user',
      content,
      ...(attachedFiles.length > 0 ? { contextFiles: attachedFiles.map(file => file.relativePath) } : {}),
    };
    const assistantId = newMessageId('assistant');
    setMessages(current => [...current, userMessage, { id: assistantId, role: 'assistant', content: '' }]);
    setDraft('');
    setSelectedContextFiles([]);
    setFilePickerOpen(false);
    setError(null);
    setRunning(true);
    const controller = new AbortController();
    abortController.current = controller;
    try {
      await streamCodexMessage({
        repositoryId,
        ...(conversationId ? { conversationId } : {}),
        ...(attachedFiles.length > 0 ? { contextFileIds: attachedFiles.map(file => file.id) } : {}),
        message: content,
      }, event => {
        if (event.type === 'conversation') setConversationId(event.conversationId);
        if (event.type === 'assistant_delta') {
          setMessages(current => current.map(item => (
            item.id === assistantId ? { ...item, content: `${item.content}${event.delta}` } : item
          )));
        }
      }, controller.signal);
    } catch (caught) {
      if (caught instanceof Error && caught.name === 'AbortError') {
        setMessages(current => current.map(item => (
          item.id === assistantId && !item.content ? { ...item, content: '（本次响应已停止）' } : item
        )));
      } else {
        setError(caught instanceof Error ? caught.message : 'Codex 请求失败');
        setMessages(current => current.filter(item => item.id !== assistantId || item.content.length > 0));
      }
    } finally {
      abortController.current = null;
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

  const startNewConversation = () => {
    if (running) return;
    setMessages([]);
    setConversationId(null);
    setSelectedContextFiles([]);
    setFilePickerOpen(false);
    setError(null);
    setPanelOpen(false);
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
            <button type="button" onClick={startNewConversation} disabled={running}>＋ 新对话</button>
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
            <section className="chat-file-picker" role="dialog" aria-label="选择上下文文件">
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
                  type="button"
                  onClick={() => void openFilePicker()}
                  disabled={!repository || !codexStatus?.available || running}
                >＋ Add file</button>
                <span>{selectedContextFiles.length > 0 ? `已选 ${selectedContextFiles.length}/8` : 'Enter 发送 · Shift+Enter 换行'}</span>
              </div>
              {running ? (
                <button className="danger-button" type="button" onClick={() => abortController.current?.abort()}>停止</button>
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
