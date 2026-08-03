import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadinessResult, RepositoryListing, SessionInfo, ZellijWebTokenInfo } from '../domain/types.js';
import {
  createSession,
  createViewer,
  deleteSession,
  deleteZellijToken,
  getReadiness,
  getRepositories,
  getSessions,
  getZellijToken,
  regenerateZellijToken,
} from './api.js';

interface DashboardState {
  readiness: ReadinessResult;
  sessions: SessionInfo[];
  zellijToken: ZellijWebTokenInfo | null;
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [repositories, setRepositories] = useState<RepositoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyRepositoryId, setBusyRepositoryId] = useState<string | null>(null);
  const [busySessionName, setBusySessionName] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const copyFeedbackTimer = useRef<number | undefined>(undefined);

  const refreshDashboard = useCallback(async () => {
    try {
      const [readiness, sessions, zellijToken] = await Promise.all([
        getReadiness(), getSessions(), getZellijToken(),
      ]);
      setDashboard({ readiness, sessions, zellijToken });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败');
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
      setError(caught instanceof Error ? caught.message : 'Zellij Session 创建失败');
    } finally {
      setBusyRepositoryId(null);
    }
  };

  const removeRepositorySession = async (repositoryId: string, sessionName: string) => {
    const confirmation = window.prompt(`删除会终止 Session 中的所有进程。请输入 ${sessionName} 确认删除：`);
    if (confirmation !== sessionName) return;
    setBusyRepositoryId(repositoryId);
    try {
      await deleteSession(sessionName);
      await Promise.all([refreshDashboard(), refreshRepositories()]);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Zellij Session 删除失败');
    } finally {
      setBusyRepositoryId(null);
    }
  };

  const removeManagedSession = async (sessionName: string) => {
    const confirmation = window.prompt(`删除会终止 Session 中的所有进程。请输入 ${sessionName} 确认删除：`);
    if (confirmation !== sessionName) return;
    setBusySessionName(sessionName);
    try {
      await deleteSession(sessionName);
      await Promise.all([refreshDashboard(), refreshRepositories()]);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Zellij Session 删除失败');
    } finally {
      setBusySessionName(null);
    }
  };

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
      setError(caught instanceof Error ? caught.message : 'code-viewer 启动失败');
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
      setError(caught instanceof Error ? caught.message : 'Token 创建失败');
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
      setError(caught instanceof Error ? caught.message : 'Token 删除失败');
    } finally {
      setTokenBusy(false);
    }
  };

  const refreshRepositories = useCallback(async () => {
    try {
      setRepositories(await getRepositories());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '目录加载失败');
    }
  }, []);

  useEffect(() => {
    void refreshDashboard();
    void refreshRepositories();
    let timer: number | undefined;
    const updateTimer = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = document.hidden ? undefined : window.setInterval(() => void refreshDashboard(), 10_000);
    };
    const onVisibilityChange = () => {
      updateTimer();
      if (!document.hidden) void refreshDashboard();
    };
    updateTimer();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      if (copyFeedbackTimer.current !== undefined) window.clearTimeout(copyFeedbackTimer.current);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshDashboard, refreshRepositories]);

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <h1>CodePilot Web</h1>
          <p className="hero-title-subtitle">Zellij管理与代码浏览</p>
          <p className="subtitle">通过公司内网 HTTPS 入口管理 Zellij Session 并浏览代码。</p>
        </div>
      </header>

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

      <section className="panel token-panel" aria-label="Zellij Web Token">
        <div className="panel-heading">
          <div><p className="eyebrow">ZELLIJ WEB</p><h2>登录 Token</h2></div>
          <div className="token-actions">
            {dashboard?.zellijToken && (
              <button type="button" onClick={() => void copyToken()}>{tokenCopied ? '已复制' : '复制 Token'}</button>
            )}
            <span className="copy-feedback" role="status" aria-live="polite">
              {tokenCopied ? 'Token 已复制' : ''}
            </span>
            <button type="button" onClick={() => void regenerateToken()} disabled={tokenBusy}>
              {dashboard?.zellijToken ? '重新创建' : '创建 Token'}
            </button>
            {dashboard?.zellijToken && <button className="danger-button" type="button" onClick={() => void removeToken()} disabled={tokenBusy}>删除 Token</button>}
          </div>
        </div>
        {dashboard?.zellijToken ? (
          <div className="token-content">
            <span>名称：<strong>{dashboard.zellijToken.name}</strong></span>
            <code>{dashboard.zellijToken.value}</code>
          </div>
        ) : <p className="empty">当前没有 Zellij Web Token。</p>}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">SESSIONS</p><h2>Zellij 会话</h2></div>
          <button type="button" onClick={() => void refreshDashboard()} disabled={loading}>刷新</button>
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
                        onClick={session.repositoryId ? () => void copyToken() : undefined}
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

      <section className="panel">
        <div className="panel-heading directory-heading">
          <div><p className="eyebrow">WORKSPACE</p><h2>Git 仓库</h2></div>
          <span className="workspace-root">{repositories?.current.name ?? '—'}</span>
        </div>
        <div className="directory-list">
          {repositories?.entries.map(entry => (
            <article className="directory-row" key={entry.id}>
              <div className="kind-icon repository">&lt;/&gt;</div>
              <div className="directory-copy">
                <strong>{entry.name}</strong>
                <span>{entry.relativePath || '.'}</span>
                {entry.markers.length > 0 && <div className="markers">{entry.markers.map(marker => <small key={marker}>{marker}</small>)}</div>}
              </div>
              <div className="repository-actions">
                {entry.session ? (
                  <>
                    <a
                      className="button-link"
                      href={entry.session.webUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => void copyToken()}
                    >
                      打开 Zellij Web
                    </a>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => void removeRepositorySession(entry.id, entry.session!.name)}
                      disabled={busyRepositoryId === entry.id || dashboard?.readiness.status !== 'ready'}
                    >删除 Session</button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void createRepositorySession(entry.id)}
                    disabled={busyRepositoryId === entry.id || dashboard?.readiness.status !== 'ready'}
                  >创建 Zellij Session</button>
                )}
                <button
                  type="button"
                  onClick={() => void browseCode(entry.id)}
                  disabled={busyRepositoryId === entry.id || dashboard?.readiness.status !== 'ready'}
                >打开 code-viewer</button>
              </div>
            </article>
          ))}
          {repositories?.entries.length === 0 && <p className="empty">Workspace 下没有找到 Git 仓库。</p>}
        </div>
      </section>
    </main>
  );
}
