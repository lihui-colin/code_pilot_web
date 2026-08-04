import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CodexCliStatus,
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
  getCodexStatus,
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

const FOLDER_INITIAL_PATH_STORAGE_KEY = 'codepilot-web.folder-initial-path';
const LAST_SELECTED_FOLDER_STORAGE_KEY = 'codepilot-web.last-selected-folder';
let inMemoryRememberedFolderPath = '';
let inMemoryLastSelectedFolderId = '';

function readRememberedFolderPath(): string {
  try {
    return window.localStorage.getItem(FOLDER_INITIAL_PATH_STORAGE_KEY) ?? '';
  } catch {
    return inMemoryRememberedFolderPath;
  }
}

function rememberFolderPath(value: string): void {
  inMemoryRememberedFolderPath = value;
  try {
    window.localStorage.setItem(FOLDER_INITIAL_PATH_STORAGE_KEY, value);
  } catch {
    // Storage may be disabled by the browser; directory browsing still works.
  }
}

function readLastSelectedFolderId(): string {
  try {
    return window.localStorage.getItem(LAST_SELECTED_FOLDER_STORAGE_KEY) ?? '';
  } catch {
    return inMemoryLastSelectedFolderId;
  }
}

function rememberLastSelectedFolderId(value: string): void {
  inMemoryLastSelectedFolderId = value;
  try {
    window.localStorage.setItem(LAST_SELECTED_FOLDER_STORAGE_KEY, value);
  } catch {
    // Storage may be disabled by the browser; keep the current page-session memory.
  }
}

function normalizedInitialFolderPath(value: string): string | null {
  const enteredPath = value.trim();
  if (!enteredPath) return null;
  const initialPath = enteredPath.replace(/^[/\\]+/u, '');
  if (!initialPath) return '';
  if (initialPath.split(/[\\/]+/u).some(segment => segment === '..')) return null;
  return initialPath;
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null);
  const [repositories, setRepositories] = useState<RepositoryListingResponse | null>(null);
  const [runningCodexRepositoryIds, setRunningCodexRepositoryIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyRepositoryId, setBusyRepositoryId] = useState<string | null>(null);
  const [busySessionName, setBusySessionName] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(false);
  const [systemStatusOpen, setSystemStatusOpen] = useState(false);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [servicesRestarting, setServicesRestarting] = useState(false);
  const [folderPicker, setFolderPicker] = useState<RepositoryFolderListing | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerBusy, setFolderPickerBusy] = useState(false);
  const [folderInitialPath, setFolderInitialPath] = useState('');
  const [folderPickerError, setFolderPickerError] = useState<string | null>(null);
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
    if (!systemSettingsOpen && !systemStatusOpen && !sessionPanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSystemSettingsOpen(false);
      setSystemStatusOpen(false);
      setSessionPanelOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [sessionPanelOpen, systemSettingsOpen, systemStatusOpen]);

  const refreshDashboard = useCallback(async () => {
    try {
      const [readiness, sessions, zellijToken, codex] = await Promise.all([
        getReadiness(), getSessions(), getZellijToken(), getCodexStatus(),
      ]);
      setDashboard({ readiness, sessions, zellijToken });
      setCodexStatus(codex);
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

  const loadRepositoryFolder = async (
    directoryId?: string,
    initialPath?: string,
    syncInitialPath = false,
  ): Promise<boolean> => {
    setFolderPickerBusy(true);
    try {
      const listing = await getRepositoryFolders(directoryId, initialPath);
      setFolderPicker(listing);
      if (syncInitialPath) {
        const currentPath = listing.current.relativePath ? `/${listing.current.relativePath}` : '/';
        setFolderInitialPath(currentPath);
        rememberFolderPath(currentPath);
      }
      setFolderPickerError(null);
      setError(null);
      return true;
    } catch (caught) {
      const message = errorMessage(caught, '服务器目录加载失败');
      setFolderPickerError(message);
      setError(message);
      return false;
    } finally {
      setFolderPickerBusy(false);
    }
  };

  const openFolderPicker = async () => {
    const rememberedPath = readRememberedFolderPath();
    const initialPath = normalizedInitialFolderPath(rememberedPath);
    const lastSelectedFolderId = readLastSelectedFolderId();
    setFolderPickerOpen(true);
    setFolderInitialPath(rememberedPath);
    setFolderPickerError(null);
    if (initialPath !== null) {
      const loaded = initialPath
        ? await loadRepositoryFolder(undefined, initialPath, true)
        : await loadRepositoryFolder(undefined, undefined, true);
      if (!loaded) await loadRepositoryFolder();
      return;
    }
    if (lastSelectedFolderId && await loadRepositoryFolder(lastSelectedFolderId, undefined, true)) return;
    await loadRepositoryFolder();
  };

  const openInitialFolder = async () => {
    const enteredPath = folderInitialPath.trim();
    if (!enteredPath) return;
    const initialPath = normalizedInitialFolderPath(enteredPath);
    if (initialPath === null) {
      setFolderPickerError('请输入有效的服务器目录，不能包含 .. 路径段。');
      return;
    }
    if (initialPath) await loadRepositoryFolder(undefined, initialPath, true);
    else await loadRepositoryFolder(undefined, undefined, true);
  };

  const selectRepositoryFolder = async (directoryId: string) => {
    setFolderPickerBusy(true);
    try {
      await addManualRepository(directoryId);
      await refreshRepositories();
      if (!folderInitialPath.trim()) rememberLastSelectedFolderId(directoryId);
      setFolderPickerOpen(false);
      setFolderPicker(null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, '目录添加失败'));
    } finally {
      setFolderPickerBusy(false);
    }
  };

  const removeManualRepository = async (repositoryId: string) => {
    if (!window.confirm('移除后将清理该目录关联的 Zellij Session、Codex 对话和 code-viewer 状态，但不会删除服务器上的文件。是否继续？')) return;
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
            className={`status-trigger${servicesRestarting ? ' restarting' : ''}`}
            type="button"
            aria-label="打开系统状态"
            aria-expanded={systemStatusOpen}
            onClick={() => setSystemStatusOpen(true)}
          ><span className="status-icon" aria-hidden="true">{servicesRestarting ? '⟳' : '◉'}</span> {servicesRestarting ? '重启中…' : '状态'}</button>
          <button
            className="settings-trigger"
            type="button"
            aria-label="打开系统设置"
            aria-expanded={systemSettingsOpen}
            onClick={() => setSystemSettingsOpen(true)}
          ><span className="settings-icon" aria-hidden="true">⚙</span> 设置</button>
        </div>
      </header>

      {systemSettingsOpen && (
        <>
          <button
            className="token-panel-backdrop"
            type="button"
            aria-label="关闭系统设置"
            onClick={() => setSystemSettingsOpen(false)}
          />
          <aside className="token-sidebar system-settings-sidebar" role="dialog" aria-modal="true" aria-label="系统设置">
            <div className="token-sidebar-heading">
              <div><p className="eyebrow">SYSTEM</p><h2>系统设置</h2></div>
              <button type="button" aria-label="关闭系统设置" onClick={() => setSystemSettingsOpen(false)}>×</button>
            </div>
            <section className="settings-section" aria-labelledby="token-settings-heading">
              <div className="settings-section-heading">
                <div><p className="eyebrow">ZELLIJ WEB</p><h3 id="token-settings-heading">Token 管理</h3></div>
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
            </section>
            <section className="settings-section" aria-labelledby="service-settings-heading">
              <div className="settings-section-heading">
                <div><p className="eyebrow">SERVICE</p><h3 id="service-settings-heading">后台服务</h3></div>
              </div>
              <p className="settings-description">重启会暂时断开 Web、编辑器和代码浏览连接，但不会删除 Zellij Session。</p>
              <button className="restart-button settings-restart-button" type="button" disabled={servicesRestarting} onClick={() => void restartAllServices()}>
                {servicesRestarting ? '服务重启中…' : '重启后台服务'}
              </button>
            </section>
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

      {systemStatusOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setSystemStatusOpen(false);
          }}
        >
          <section className="system-status-dialog" role="dialog" aria-modal="true" aria-label="系统状态">
            <div className="panel-heading">
              <div><p className="eyebrow">SYSTEM STATUS</p><h2>系统状态</h2></div>
              <button type="button" aria-label="关闭系统状态" onClick={() => setSystemStatusOpen(false)}>×</button>
            </div>
            <section className="status-grid" aria-label="服务状态">
              <article className="status-card">
                <span>管理服务</span>
                <strong className="status-ok">在线</strong>
                <small className="status-detail">terminal-web 0.1.0</small>
              </article>
              <article className="status-card">
                <span>就绪状态</span>
                <strong className={dashboard?.readiness.status === 'ready' ? 'status-ok' : 'status-warn'}>
                  {dashboard?.readiness.status === 'ready' ? '已就绪' : '未就绪'}
                </strong>
                <small className="status-detail">workspace / runtime checks</small>
              </article>
              <article className="status-card">
                <span>Zellij 工具</span>
                <strong className={dashboard?.readiness.checks.zellij ? 'status-ok' : 'status-warn'}>
                  {dashboard?.readiness.checks.zellij ? '可用' : '版本异常'}
                </strong>
                <small className="status-detail">{dashboard?.readiness.checks.zellij ? 'zellij 0.44.3' : '要求 zellij 0.44.3'}</small>
              </article>
              <article className="status-card">
                <span>code-viewer</span>
                <strong className={dashboard?.readiness.checks.codeViewer ? 'status-ok' : 'status-warn'}>
                  {dashboard?.readiness.checks.codeViewer ? '可用' : '不可用'}
                </strong>
                <small className="status-detail">{dashboard?.readiness.checks.codeViewer ? '0.10.0' : '要求 0.10.0'}</small>
              </article>
              <article className="status-card">
                <span>OpenVSCode</span>
                <strong className="status-ok">已配置</strong>
                <small className="status-detail">openvscode-server 1.109.5</small>
              </article>
              <article className="status-card">
                <span>Codex CLI</span>
                <strong className={codexStatus?.available ? 'status-ok' : 'status-warn'}>
                  {codexStatus?.available ? '可用' : '不可用'}
                </strong>
                {codexStatus?.version && <small className="status-detail">{codexStatus.version}</small>}
              </article>
            </section>
          </section>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      <section className="panel repository-panel">
        <div className="panel-heading directory-heading">
          <div className="workspace-heading-copy">
            <p className="eyebrow">WORKSPACE</p>
            <span className="workspace-root">{repositories?.current.name ?? '—'}</span>
          </div>
          <div className="directory-heading-actions">
            <button
              type="button"
              aria-label="打开会话列表"
              aria-expanded={sessionPanelOpen}
              onClick={() => setSessionPanelOpen(true)}
            >会话列表 <span className="action-count">{dashboard?.sessions.length ?? 0}</span></button>
            <button type="button" onClick={() => void openFolderPicker()}><span className="folder-action-icon" aria-hidden="true">＋</span> 添加文件夹</button>
          </div>
        </div>
        <div className="directory-list">
          {repositories?.entries.map(entry => {
            const codexRunning = runningCodexRepositoryIds.has(entry.id);
            return (
            <article className="directory-row" key={entry.id}>
              <div className={`kind-icon ${entry.kind}`}>{entry.kind === 'repository' ? '</>' : 'DIR'}</div>
              <div className="directory-copy">
                <strong>{entry.name}</strong>
                <span>{entry.relativePath || '.'}</span>
                {(entry.source === 'manual' || entry.kind === 'directory') && (
                  <small className="manual-source">{entry.kind === 'directory' ? '目录' : '手动添加'}</small>
                )}
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
                >{codexRunning ? (
                  <>
                    <span className="codex-link-main">与 Codex 对话</span>
                    <span className="sr-only">，生成中</span>
                  </>
                ) : '与 Codex 对话'}</a>
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
          {repositories?.entries.length === 0 && <p className="empty">Workspace 下没有找到可显示的目录。</p>}
        </div>
      </section>

      {folderPickerOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title">
            <div className="panel-heading">
              <div><p className="eyebrow">OPEN FOLDER</p><h2 id="folder-dialog-title">打开服务器目录</h2></div>
              <button type="button" onClick={() => setFolderPickerOpen(false)}>关闭</button>
            </div>
            <form className="folder-initial-path" onSubmit={event => { event.preventDefault(); void openInitialFolder(); }}>
              <input
                aria-label="初始目录"
                value={folderInitialPath}
                onChange={event => setFolderInitialPath(event.target.value)}
                placeholder="输入初始目录，例如 /data01/home/lihui/projects"
                spellCheck={false}
                disabled={folderPickerBusy}
              />
              <button type="submit" disabled={folderPickerBusy || !folderInitialPath.trim()}>前往</button>
            </form>
            {folderPickerError && <p className="error folder-picker-error" role="alert">{folderPickerError}</p>}
            <div className="folder-toolbar">
              <button
                type="button"
                disabled={!folderPicker?.parentId || folderPickerBusy}
                onClick={() => folderPicker?.parentId && void loadRepositoryFolder(folderPicker.parentId, undefined, true)}
              ><span className="folder-action-icon" aria-hidden="true">↑</span> 上一级</button>
              <strong className="mono">{folderPicker?.current.name ?? '加载中…'}</strong>
              <button
                type="button"
                aria-label="选择当前目录"
                title="选择当前目录"
                disabled={folderPickerBusy}
                onClick={() => folderPicker?.current.id && void selectRepositoryFolder(folderPicker.current.id)}
              ><span className="folder-action-icon" aria-hidden="true">✓</span></button>
            </div>
            <div className="folder-list" aria-busy={folderPickerBusy}>
              {folderPicker?.entries.map(folder => (
                <div className="folder-row" key={folder.id}>
                  <button
                    className="folder-name"
                    type="button"
                    disabled={folderPickerBusy}
                    onClick={() => void loadRepositoryFolder(folder.id, undefined, true)}
                  >📁 {folder.name}</button>
                  <button
                    type="button"
                    aria-label="选择目录"
                    title="选择目录"
                    disabled={folderPickerBusy}
                    onClick={() => void selectRepositoryFolder(folder.id)}
                  ><span className="folder-action-icon" aria-hidden="true">✓</span></button>
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
