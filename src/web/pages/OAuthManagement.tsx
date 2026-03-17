import { useEffect, useState, type ReactNode } from 'react';
import { api, type OAuthConnectionInfo, type OAuthProviderInfo, type OAuthStartInstructions } from '../api.js';

const POLL_INTERVAL_MS = 1500;
const CONNECTION_PAGE_LIMIT = 100;

type ActiveSession = {
  provider: string;
  state: string;
  authorizationUrl: string;
  instructions: OAuthStartInstructions;
};

function openOAuthPopup(provider: string, authorizationUrl: string) {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return;
  const popup = window.open(
    authorizationUrl,
    `oauth-${provider}`,
    'popup=yes,width=540,height=760,resizable=yes,scrollbars=yes,noopener,noreferrer',
  );
  if (popup) {
    try {
      popup.opener = null;
    } catch {
      // Ignore cross-window opener hardening failures.
    }
  }
  if (popup && typeof popup.focus === 'function') {
    popup.focus();
  }
}

function resolveConnectionStatusLabel(status?: string): string {
  return status === 'abnormal' ? '异常' : '正常';
}

function renderCodeBlock(value: string) {
  return (
    <code style={{
      display: 'block',
      padding: '10px 12px',
      borderRadius: 'var(--radius-sm)',
      background: 'color-mix(in srgb, var(--color-primary) 6%, var(--color-bg))',
      border: '1px solid color-mix(in srgb, var(--color-primary) 18%, var(--color-border))',
      color: 'var(--color-text-primary)',
      fontSize: 12,
      lineHeight: 1.5,
      wordBreak: 'break-all',
      whiteSpace: 'pre-wrap',
    }}
    >
      {value}
    </code>
  );
}

function renderGuideCard(title: string, description: string, children?: ReactNode) {
  return (
    <div style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg)',
      padding: 14,
      display: 'grid',
      gap: 10,
    }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>{description}</div>
      </div>
      {children}
    </div>
  );
}

export default function OAuthManagement() {
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
  const [connections, setConnections] = useState<OAuthConnectionInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [sessionMessage, setSessionMessage] = useState('');
  const [actionLoadingKey, setActionLoadingKey] = useState('');
  const [manualCallbackVisible, setManualCallbackVisible] = useState(false);
  const [manualCallbackUrl, setManualCallbackUrl] = useState('');
  const [manualCallbackSubmitting, setManualCallbackSubmitting] = useState(false);

  const loadConnections = async () => {
    const response = await api.getOAuthConnections({
      limit: CONNECTION_PAGE_LIMIT,
      offset: 0,
    });
    setConnections(Array.isArray(response?.items) ? response.items : []);
  };

  const load = async () => {
    try {
      const [providersResponse] = await Promise.all([
        api.getOAuthProviders(),
        loadConnections(),
      ]);
      setProviders(Array.isArray(providersResponse?.providers) ? providersResponse.providers : []);
    } catch (error) {
      console.error('failed to load oauth management data', error);
      setSessionMessage('OAuth 管理数据加载失败');
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!activeSession) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const session = await api.getOAuthSession(activeSession.state);
        if (cancelled) return;

        if (session.status === 'pending') {
          setSessionMessage('等待授权完成');
          timer = setTimeout(poll, POLL_INTERVAL_MS);
          return;
        }

        if (session.status === 'success') {
          setSessionMessage('授权成功');
          await loadConnections();
          setActiveSession(null);
          return;
        }

        setSessionMessage(`授权失败：${session.error || '未知错误'}`);
        setActiveSession(null);
      } catch (error: any) {
        if (cancelled) return;
        setSessionMessage(error?.message || 'OAuth 会话状态查询失败');
        setActiveSession(null);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeSession]);

  useEffect(() => {
    if (!activeSession) {
      setManualCallbackVisible(false);
      setManualCallbackUrl('');
      setManualCallbackSubmitting(false);
      return;
    }

    setManualCallbackVisible(false);
    setManualCallbackUrl('');
    setManualCallbackSubmitting(false);

    const timer = setTimeout(() => {
      setManualCallbackVisible(true);
    }, Math.max(0, activeSession.instructions.manualCallbackDelayMs || 0));

    return () => clearTimeout(timer);
  }, [activeSession]);

  const handleStart = async (provider: OAuthProviderInfo, accountId?: number) => {
    const actionKey = `start:${provider.provider}:${accountId || 0}`;
    setActionLoadingKey(actionKey);
    try {
      const projectId = provider.requiresProjectId
        ? (() => {
          if (typeof window === 'undefined' || typeof window.prompt !== 'function') return undefined;
          const value = window.prompt('输入 Google Cloud Project ID');
          return typeof value === 'string' && value.trim() ? value.trim() : undefined;
        })()
        : undefined;
      if (provider.requiresProjectId && !projectId && !accountId) {
        setSessionMessage('Gemini CLI 连接需要 Project ID');
        return;
      }
      const started = accountId
        ? await api.rebindOAuthConnection(accountId)
        : await api.startOAuthProvider(provider.provider, { projectId });
      setSessionMessage('等待授权完成');
      setActiveSession({
        provider: started.provider,
        state: started.state,
        authorizationUrl: started.authorizationUrl,
        instructions: started.instructions,
      });
      openOAuthPopup(provider.provider, started.authorizationUrl);
    } catch (error: any) {
      setSessionMessage(error?.message || '无法启动 OAuth 授权');
    } finally {
      setActionLoadingKey('');
    }
  };

  const handleSubmitManualCallback = async () => {
    if (!activeSession) return;
    const callbackUrl = manualCallbackUrl.trim();
    if (!callbackUrl) {
      setSessionMessage('请输入完整的回调 URL');
      return;
    }
    setManualCallbackSubmitting(true);
    try {
      await api.submitOAuthManualCallback(activeSession.state, callbackUrl);
      setSessionMessage('回调已提交，等待授权完成');
    } catch (error: any) {
      setSessionMessage(error?.message || '提交回调 URL 失败');
    } finally {
      setManualCallbackSubmitting(false);
    }
  };

  const handleDelete = async (accountId: number) => {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const confirmed = window.confirm('确定要删除这个 OAuth 连接吗？');
      if (!confirmed) return;
    }
    const actionKey = `delete:${accountId}`;
    setActionLoadingKey(actionKey);
    try {
      await api.deleteOAuthConnection(accountId);
      setSessionMessage('连接已删除');
      await loadConnections();
    } catch (error: any) {
      setSessionMessage(error?.message || '删除 OAuth 连接失败');
    } finally {
      setActionLoadingKey('');
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <div className="page-title">OAuth 管理</div>
          <div className="page-subtitle">统一管理需要浏览器授权的上游连接，包括 Codex、Claude 和 Gemini CLI。</div>
        </div>
      </div>

      {sessionMessage && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{sessionMessage}</div>
        </div>
      )}

      {activeSession && (
        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>授权指引</div>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{
              padding: 12,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              background: 'color-mix(in srgb, var(--color-primary) 5%, var(--color-bg-card))',
            }}
            >
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>固定回调地址</div>
              {renderCodeBlock(activeSession.instructions.redirectUri)}
            </div>

            {renderGuideCard(
              '本地部署',
              'metapi 和浏览器在同一台机器时，不需要 SSH 隧道。直接点击“连接”，在弹窗里完成授权即可。',
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                如果浏览器能直接访问上面的 localhost 回调地址，授权完成后会自动回到 metapi。
              </div>,
            )}

            {activeSession.instructions.sshTunnelCommand
              ? renderGuideCard(
                '云端部署',
                'metapi 部署在 VPS、容器或远程主机时，浏览器访问到的是你自己电脑的 localhost。先在本地开 SSH 隧道，再继续登录。',
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>常规 SSH 隧道</div>
                  {renderCodeBlock(activeSession.instructions.sshTunnelCommand)}
                  {activeSession.instructions.sshTunnelKeyCommand && (
                    <>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>SSH Key 隧道</div>
                      {renderCodeBlock(activeSession.instructions.sshTunnelKeyCommand)}
                    </>
                  )}
                </div>,
              )
              : renderGuideCard(
                '云端部署',
                '当前没有检测到远程主机地址。如果你实际是云端部署，请用能访问服务器 127.0.0.1 回调端口的 SSH 隧道方式完成授权。',
              )}

            {renderGuideCard(
              '手动回调',
              `如果浏览器停在 localhost 错误页，复制浏览器地址栏里的完整 URL，等待 ${Math.max(1, Math.round(activeSession.instructions.manualCallbackDelayMs / 1000))} 秒后粘贴回来。`,
              manualCallbackVisible ? (
                <div style={{ display: 'grid', gap: 10 }}>
                  <textarea
                    value={manualCallbackUrl}
                    onChange={(event) => setManualCallbackUrl(event.target.value)}
                    placeholder="粘贴完整的 callback URL，例如 http://localhost:1455/auth/callback?code=..."
                    rows={3}
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--color-border)',
                      background: 'var(--color-bg-card)',
                      color: 'var(--color-text-primary)',
                      resize: 'vertical',
                      fontSize: 13,
                      lineHeight: 1.5,
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleSubmitManualCallback}
                      disabled={manualCallbackSubmitting}
                    >
                      {manualCallbackSubmitting ? '提交中...' : '提交回调 URL'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => openOAuthPopup(activeSession.provider, activeSession.authorizationUrl)}
                    >
                      重新打开授权页
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>手动回调入口将在几秒后可用。</div>
              ),
            )}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>授权入口</div>
        <div style={{ display: 'grid', gap: 12 }}>
          {providers.map((provider) => {
            const actionKey = `start:${provider.provider}:0`;
            return (
              <div key={provider.provider} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{provider.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {provider.platform}
                    {provider.requiresProjectId ? ' · 需要 Project ID' : ''}
                    {provider.supportsNativeProxy ? ' · 原生代理' : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleStart(provider)}
                  disabled={actionLoadingKey === actionKey}
                >
                  {actionLoadingKey === actionKey ? '启动中...' : `连接 ${provider.label}`}
                </button>
              </div>
            );
          })}
          {loaded && providers.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>当前没有可用的 OAuth Provider。</div>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>已连接账号</div>
        <div style={{ display: 'grid', gap: 12 }}>
          {connections.map((connection) => {
            const rebindActionKey = `start:${connection.provider}:${connection.accountId}`;
            const deleteActionKey = `delete:${connection.accountId}`;
            return (
              <div key={connection.accountId} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{connection.email || connection.username || connection.provider}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                      {connection.planType || 'unknown'} · {connection.modelCount} 个模型
                    </div>
                    {connection.accountKey && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                        连接标识: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', color: 'var(--color-text-primary)' }}>{connection.accountKey}</span>
                      </div>
                    )}
                    {connection.projectId && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                        Project: {connection.projectId}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                      {resolveConnectionStatusLabel(connection.status)} · {connection.routeChannelCount || 0} 条路由
                    </div>
                    {connection.lastModelSyncAt && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                        最近同步: {connection.lastModelSyncAt}
                      </div>
                    )}
                    {connection.lastModelSyncError && (
                      <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 4 }}>
                        {connection.lastModelSyncError}
                      </div>
                    )}
                    {connection.modelsPreview.length > 0 && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 6 }}>
                        {connection.modelsPreview.join(', ')}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleStart(
                        providers.find((provider) => provider.provider === connection.provider) || {
                          provider: connection.provider,
                          label: connection.provider,
                          platform: connection.site?.platform || connection.provider,
                          enabled: true,
                          loginType: 'oauth',
                          requiresProjectId: false,
                          supportsDirectAccountRouting: true,
                          supportsCloudValidation: true,
                          supportsNativeProxy: false,
                        },
                        connection.accountId,
                      )}
                      disabled={actionLoadingKey === rebindActionKey || actionLoadingKey === deleteActionKey}
                    >
                      {actionLoadingKey === rebindActionKey ? '启动中...' : '重新授权'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleDelete(connection.accountId)}
                      disabled={actionLoadingKey === rebindActionKey || actionLoadingKey === deleteActionKey}
                    >
                      {actionLoadingKey === deleteActionKey ? '删除中...' : '删除连接'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {loaded && connections.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>还没有 OAuth 连接。</div>
          )}
        </div>
      </div>
    </div>
  );
}
