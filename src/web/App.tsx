import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReadinessResult,
  RepositoryFolderListing,
  RepositoryListingResponse,
  SessionInfo,
  ZellijWebTokenInfo,
} from '../domain/types.js';
import {
  addManualRepository,
  createSession,
  createViewer,
  deleteManualRepository,
  deleteSession,
  deleteZellijToken,
  getCodexActivity,
  getReadiness,
  getRepositoryFolders,
  getRepositories,
  getSessions,
  getZellijToken,
  regenerateZellijToken,
  restartServices,
} from './api.js';
import { errorMessage } from './browser-utils.js';

interface DashboardState {
  readiness: ReadinessResult;
  sessions: SessionInfo[];
  zellijToken: ZellijWebTokenInfo | null;
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [repositories, setRepositories] = useState<RepositoryListingResponse | null>(null);
  const [runningCodexRepositoryIds, setRunningCodexRepositoryIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyRepositoryId, setBusyRepositoryId] = useState<string | null>(null);
  const [busySessionName, setBusySessionName] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenPanelOpen, setTokenPanelOpen] = useState(false);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [servicesRestarting, setServicesRestarting] = useState(false);
  const [folderPicker, setFolderPicker] = useState<RepositoryFolderListing | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerBusy, setFolderPickerBusy] = useState(false);
  const [openRepositoryMenuId, setOpenRepositoryMenuId] = useState<string | null>(null);
  const copyFeedbackTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!openRepositoryMenuId) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(`[data-repository-menu-id="${openRepositoryMenuId}"]`)) return;
      setOpenRepositoryMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenRepositoryMenuId(null);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openRepositoryMenuId]);

  useEffect(() => {
    if (!tokenPanelOpen && !sessionPanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTokenPanelOpen(false);
      setSessionPanelOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [sessionPanelOpen, tokenPanelOpen]);

  const refreshDashboard = useCallback(async () => {
    try {
      const [readiness, sessions, zellijToken] = await Promise.all([
        getReadiness(), getSessions(), getZellijToken(),
      ]);
      setDashboard({ readiness, sessions, zellijToken });
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, '加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  const createRepositorySession = async (repositoryId: string) => {
    setBusyRepositoryId(repositoryId);
    try {
      await createSession(repositoryId);
      await Promise.all([refreshDashboard(), refreshRepositories()]);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Zellij Session 创建失败'));
    } finally {
      setBusyRepositoryId(null);
    }
  };

  const removeSession = async (
    sessionName: string,
    setBusy: (busy: boolean) => void,
    onSuccess?: () => void,
  ) => {
    const confirmation = window.prompt(`删除会终止 Session 中的所有进程。请输入 ${sessionName} 确认删除：`);
    if (confirmation !== sessionName) return;
    setBusy(true);
    try {
      await deleteSession(sessionName);
      await Promise.all([refreshDashboard(), refreshRepositories()]);
      setError(null);
      onSuccess?.();
    } catch (caught) {
      setError(errorMessage(caught, 'Zellij Session 删除失败'));
    } finally {
      setBusy(false);
    }
  };

  const removeRepositorySession = (repositoryId: string, sessionName: string) => removeSession(
    sessionName,
    busy => setBusyRepositoryId(busy ? repositoryId : null),
  );

  const removeManagedSession = (sessionName: string) => removeSession(
    sessionName,
    busy => setBusySessionName(busy ? sessionName : null),
    () => setSessionPanelOpen(false),
  );

  const browseCode = async (repositoryId: string) => {
    const viewerWindow = window.open('about:blank', '_blank');
    if (!viewerWindow) {
      setError('浏览器阻止了新标签页，请允许本站打开弹窗。');
      return;
    }
    setBusyRepositoryId(repositoryId);
    try {
      const viewer = await createViewer(repositoryId);
      viewerWindow.location.replace(viewer.webUrl);
      await refreshRepositories();
      setError(null);
    } catch (caught) {
      viewerWindow.close();
      setError(errorMessage(caught, 'code-viewer 启动失败'));
    } finally {
      setBusyRepositoryId(null);
    }
  };

  const copyToken = async () => {
    const value = dashboard?.zellijToken?.value;
    if (!value) return;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(value);
      else {
        const input = document.createElement('textarea');
        input.value = value;
        document.body.append(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      setTokenCopied(true);
      if (copyFeedbackTimer.current !== undefined) window.clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = window.setTimeout(() => {
        setTokenCopied(false);
        copyFeedbackTimer.current = undefined;
      }, 2_000);
      setError(null);
    } catch {
      setError('复制失败，请手动选择 Token。');
    }
  };

  const regenerateToken = async () => {
    if (dashboard?.zellijToken && !window.confirm('重新创建后，当前 Token 将被撤销。是否继续？')) return;
    setTokenBusy(true);
    try {
      const zellijToken = await regenerateZellijToken();
      setDashboard(current => current ? { ...current, zellijToken } : current);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Token 创建失败'));
    } finally {
      setTokenBusy(false);
    }
  };

  const removeToken = async () => {
    if (!window.confirm('删除后，新的浏览器将无法登录 Zellij Web，直到重新创建 Token。是否继续？')) return;
    setTokenBusy(true);
    try {
      await deleteZellijToken();
      setDashboard(current => current ? { ...current, zellijToken: null } : current);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Token 删除失败'));
    } finally {
      setTokenBusy(false);
    }
  };

  const refreshRepositories = useCallback(async () => {
    try {
      setRepositories(await getRepositories());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, '目录加载失败'));
    }
  }, []);

  const refreshCodexActivity = useCallback(async () => {
    try {
      const activity = await getCodexActivity();
      setRunningCodexRepositoryIds(new Set(activity.runningRepositoryIds));
    } catch {
      // Keep the last known activity state when this optional status refresh fails.
    }
  }, []);

  const loadRepositoryFolder = async (directoryId?: string) => {
    setFolderPickerBusy(true);
    try {
      setFolderPicker(await getRepositoryFolders(directoryId));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, '服务器目录加载失败'));
    } finally {
      setFolderPickerBusy(false);
    }
  };

  const openFolderPicker = async () => {
    setFolderPickerOpen(true);
    await loadRepositoryFolder();
  };

  const selectRepositoryFolder = async (directoryId: string) => {
    setFolderPickerBusy(true);
    try {
      await addManualRepository(directoryId);
      await refreshRepositories();
      setFolderPickerOpen(false);
      setFolderPicker(null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Git 仓库添加失败'));
    } finally {
      setFolderPickerBusy(false);
    }
  };

  const removeManualRepository = async (repositoryId: string) => {
    if (!window.confirm('从列表移除此手动仓库？这不会删除服务器上的文件或 Zellij Session。')) return;
    setBusyRepositoryId(repositoryId);
    try {
      await deleteManualRepository(repositoryId);
      await refreshRepositories();
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, '手动仓库移除失败'));
    } finally {
      setBusyRepositoryId(null);
    }
  };

  const restartAllServices = async () => {
    if (!window.confirm('重启会断开当前 Zellij Web、code-viewer 和 OpenVSCode 连接，但不会删除 Zellij Session。是否继续？')) return;
    setServicesRestarting(true);
    try {
      await restartServices();
      setError(null);
      let observedShutdown = false;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 1_000));
        try {
          const response = await fetch('/api/health', { credentials: 'same-origin' });
          if (response.ok && observedShutdown) {
            window.location.reload();
            return;
          }
          if (!response.ok) observedShutdown = true;
        } catch {
          observedShutdown = true;
        }
      }
      throw new Error('服务重启超时，请检查后台重启日志。');
    } catch (caught) {
      setError(errorMessage(caught, '服务重启失败'));
      setServicesRestarting(false);
    }
  };

  useEffect(() => {
    void refreshDashboard();
    void refreshRepositories();
    void refreshCodexActivity();
    let timer: number | undefined;
    const updateTimer = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = document.hidden ? undefined : window.setInterval(() => {
        void refreshDashboard();
        void refreshCodexActivity();
      }, 10_000);
    };
    const onVisibilityChange = () => {
      updateTimer();
      if (!document.hidden) {
        void refreshDashboard();
        void refreshCodexActivity();
      }
    };
    const onFocus = () => void refreshCodexActivity();
    updateTimer();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      if (copyFeedbackTimer.current !== undefined) window.clearTimeout(copyFeedbackTimer.current);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCodexActivity, refreshDashboard, refreshRepositories]);

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <h1>CodePilot Web</h1>
          <p className="hero-title-subtitle">Zellij管理与代码浏览</p>
          <p className="subtitle">通过公司内网 HTTPS 入口管理 Zellij Session 并浏览代码。</p>
        </div>
        <div className="hero-actions">
          <button
            className="token-panel-trigger"
            type="button"
            aria-label="打开 Token 管理"
            aria-expanded={tokenPanelOpen}
            onClick={() => setTokenPanelOpen(true)}
          >Token 管理 <span>{dashboard?.zellijToken ? '已配置' : '未配置'}</span></button>
          <button
            className="restart-button"
            type="button"
            disabled={servicesRestarting}
            onClick={() => void restartAllServices()}
          >{servicesRestarting ? '服务重启中…' : '重启后台服务'}</button>
        </div>
      </header>

      {tokenPanelOpen && (
        <>
          <button
            className="token-panel-backdrop"
            type="button"
            aria-label="关闭 Token 管理"
            onClick={() => setTokenPanelOpen(false)}
          />
          <aside className="token-sidebar" role="dialog" aria-modal="true" aria-label="Zellij Web Token 管理">
            <div className="token-sidebar-heading">
              <div><p className="eyebrow">ZELLIJ WEB</p><h2>Token 管理</h2></div>
              <button type="button" aria-label="关闭 Token 管理" onClick={() => setTokenPanelOpen(false)}>×</button>
            </div>
            <div className="token-sidebar-status">
              <small>当前状态</small>
              <strong className={dashboard?.zellijToken ? 'status-ok' : 'status-warn'}>
                {dashboard?.zellijToken ? '已配置' : '未配置'}
              </strong>
            </div>
            {dashboard?.zellijToken ? (
              <div className="token-content">
                <span>名称：<strong>{dashboard.zellijToken.name}</strong></span>
                <code>{dashboard.zellijToken.value}</code>
              </div>
            ) : <p className="empty">当前没有 Zellij Web Token。</p>}
            <div className="token-sidebar-actions">
              {dashboard?.zellijToken && (
                <button type="button" onClick={() => void copyToken()}>{tokenCopied ? '已复制' : '复制 Token'}</button>
              )}
              <button type="button" onClick={() => void regenerateToken()} disabled={tokenBusy}>
                {dashboard?.zellijToken ? '重新创建' : '创建 Token'}
              </button>
              {dashboard?.zellijToken && (
                <button className="danger-button" type="button" onClick={() => void removeToken()} disabled={tokenBusy}>
                  删除 Token
                </button>
              )}
            </div>
            <p className="token-security-note">Token 仅用于登录同源 Zellij Web，请勿发送给不受信任的人员。</p>
          </aside>
        </>
      )}
      <span className={`token-copy-feedback${tokenCopied ? ' visible' : ''}`} role="status" aria-live="polite">
        {tokenCopied ? 'Token 已复制' : ''}
      </span>

      {sessionPanelOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setSessionPanelOpen(false);
          }}
        >
          <section className="session-dialog" role="dialog" aria-modal="true" aria-label="Zellij 会话列表">
            <div className="panel-heading">
              <div><p className="eyebrow">SESSIONS</p><h2>Zellij 会话</h2></div>
              <button type="button" aria-label="关闭会话列表" onClick={() => setSessionPanelOpen(false)}>×</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>名称</th><th>来源</th><th>目录</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {dashboard?.sessions.map(session => (
                    <tr key={session.name}>
                      <td className="mono">{session.name}</td>
                      <td>{session.origin === 'managed' ? '托管' : '外部'}</td>
                      <td className="path">{session.relativePath ?? '—'}</td>
                      <td><span className="pill">运行中</span></td>
                      <td>
                        <div className="session-actions">
                          <a
                            className="button-link"
                            href={session.webUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => {
                              if (session.repositoryId) void copyToken();
                              setSessionPanelOpen(false);
                            }}
                          >
                            打开
                          </a>
                          <button
                            className="danger-button"
                            type="button"
                            disabled={busySessionName === session.name}
                            onClick={() => void removeManagedSession(session.name)}
                          >
                            {busySessionName === session.name ? '删除中…' : '删除'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!loading && dashboard?.sessions.length === 0 && <tr><td colSpan={5} className="empty">暂无会话</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}
      <section className="status-grid" aria-label="服务状态">
        <article className="status-card">
          <span>管理服务</span>
          <strong className="status-ok">在线</strong>
        </article>
        <article className="status-card">
          <span>就绪状态</span>
          <strong className={dashboard?.readiness.status === 'ready' ? 'status-ok' : 'status-warn'}>
            {dashboard?.readiness.status === 'ready' ? '已就绪' : '未就绪'}
          </strong>
        </article>
        <article className="status-card">
          <span>Zellij 工具</span>
          <strong className={dashboard?.readiness.checks.zellij ? 'status-ok' : 'status-warn'}>
            {dashboard?.readiness.checks.zellij ? '可用' : '版本异常'}
          </strong>
        </article>
      </section>

      <section className="panel repository-panel">
        <div className="panel-heading directory-heading">
          <div className="workspace-heading-copy">
            <p className="eyebrow">WORKSPACE</p>
            <h2>Git 仓库</h2>
            <span className="workspace-root">{repositories?.current.name ?? '—'}</span>
          </div>
          <div className="directory-heading-actions">
            <button
              type="button"
              aria-label="打开会话列表"
              aria-expanded={sessionPanelOpen}
              onClick={() => setSessionPanelOpen(true)}
            >会话列表 <span className="action-count">{dashboard?.sessions.length ?? 0}</span></button>
            <button type="button" onClick={() => void openFolderPicker()}>添加文件夹</button>
          </div>
        </div>
        <div className="directory-list">
          {repositories?.entries.map(entry => {
            const codexRunning = runningCodexRepositoryIds.has(entry.id);
            return (
            <article className="directory-row" key={entry.id}>
              <div className="kind-icon repository">&lt;/&gt;</div>
              <div className="directory-copy">
                <strong>{entry.name}</strong>
                <span>{entry.relativePath || '.'}</span>
                {entry.source === 'manual' && <small className="manual-source">手动添加</small>}
                {entry.markers.length > 0 && <div className="markers">{entry.markers.map(marker => <small key={marker}>{marker}</small>)}</div>}
              </div>
              <div className="repository-actions">
                {entry.session ? (
                  <a
                    className="button-link zellij-link"
                    href={entry.session.webUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => void copyToken()}
                  >
                    打开 Zellij Web
                  </a>
                ) : (
                  <button
                    className="zellij-action"
                    type="button"
                    onClick={() => void createRepositorySession(entry.id)}
                    disabled={busyRepositoryId === entry.id || dashboard?.readiness.status !== 'ready'}
                  >创建 Zellij Session</button>
                )}
                <a
                  className={`button-link codex-chat-link${codexRunning ? ' running' : ''}`}
                  href={`/codex-chat?repositoryId=${encodeURIComponent(entry.id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >{codexRunning ? <><span className="codex-running-dot" aria-hidden="true" />Codex 生成中…</> : '与 Codex 对话'}</a>
                <div
                  className="repository-more"
                  data-repository-menu-id={entry.id}
                >
                  <button
                    className="repository-more-trigger"
                    type="button"
                    aria-label={`${entry.name} 更多操作`}
                    aria-haspopup="menu"
                    aria-expanded={openRepositoryMenuId === entry.id}
                    title="更多操作"
                    onClick={() => setOpenRepositoryMenuId(current => current === entry.id ? null : entry.id)}
                  >⋯</button>
                  {openRepositoryMenuId === entry.id && <div className="repository-menu">
                    <a
                      href={entry.openVSCodeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setOpenRepositoryMenuId(null)}
                    >编辑代码</a>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenRepositoryMenuId(null);
                        void browseCode(entry.id);
                      }}
                      disabled={busyRepositoryId === entry.id || dashboard?.readiness.status !== 'ready'}
                    >code-viewer</button>
                    {(entry.session || entry.source === 'manual') && <div className="repository-menu-separator" />}
                    {entry.session && (
                      <button
                        className="danger-button"
                        type="button"
                        onClick={() => {
                          setOpenRepositoryMenuId(null);
                          void removeRepositorySession(entry.id, entry.session!.name);
                        }}
                        disabled={busyRepositoryId === entry.id || dashboard?.readiness.status !== 'ready'}
                      >删除 Session</button>
                    )}
                    {entry.source === 'manual' && (
                      <button
                        className="danger-button"
                        type="button"
                        onClick={() => {
                          setOpenRepositoryMenuId(null);
                          void removeManualRepository(entry.id);
                        }}
                        disabled={busyRepositoryId === entry.id}
                      >移除仓库</button>
                    )}
                  </div>}
                </div>
              </div>
            </article>
            );
          })}
          {repositories?.entries.length === 0 && <p className="empty">Workspace 下没有找到 Git 仓库。</p>}
        </div>
      </section>

      {folderPickerOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title">
            <div className="panel-heading">
              <div><p className="eyebrow">OPEN FOLDER</p><h2 id="folder-dialog-title">打开服务器 Git 仓库</h2></div>
              <button type="button" onClick={() => setFolderPickerOpen(false)}>关闭</button>
            </div>
            <div className="folder-toolbar">
              <button
                type="button"
                disabled={!folderPicker?.parentId || folderPickerBusy}
                onClick={() => folderPicker?.parentId && void loadRepositoryFolder(folderPicker.parentId)}
              >上一级</button>
              <strong className="mono">{folderPicker?.current.name ?? '加载中…'}</strong>
              {folderPicker?.current.gitRepository && (
                <button
                  type="button"
                  disabled={folderPickerBusy}
                  onClick={() => void selectRepositoryFolder(folderPicker.current.id)}
                >选择当前 Git 仓库</button>
              )}
            </div>
            <div className="folder-list" aria-busy={folderPickerBusy}>
              {folderPicker?.entries.map(folder => (
                <div className="folder-row" key={folder.id}>
                  <button
                    className="folder-name"
                    type="button"
                    disabled={folderPickerBusy}
                    onClick={() => void loadRepositoryFolder(folder.id)}
                  >📁 {folder.name}</button>
                  {folder.gitRepository && (
                    <button
                      type="button"
                      disabled={folderPickerBusy}
                      onClick={() => void selectRepositoryFolder(folder.id)}
                    >选择 Git 仓库</button>
                  )}
                </div>
              ))}
              {!folderPickerBusy && folderPicker?.entries.length === 0 && <p className="empty">此目录下没有可浏览的子目录。</p>}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
