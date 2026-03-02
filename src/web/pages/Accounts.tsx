import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { getAccountsAddPanelStyle } from './helpers/accountsPanelStyle.js';
import { clearFocusParams, readFocusAccountIntent } from './helpers/navigationFocus.js';
import { tr } from '../i18n.js';
import { buildCustomReorderUpdates, sortItemsForDisplay, type SortMode } from './helpers/listSorting.js';

export default function Accounts() {
  const location = useLocation();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('custom');
  const [highlightAccountId, setHighlightAccountId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<'token' | 'login'>('token');
  const [loginForm, setLoginForm] = useState({ siteId: 0, username: '', password: '' });
  const [tokenForm, setTokenForm] = useState({ siteId: 0, accessToken: '', platformUserId: '' });
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [rebindTarget, setRebindTarget] = useState<any | null>(null);
  const [rebindForm, setRebindForm] = useState({ accessToken: '', platformUserId: '' });
  const [rebindVerifyResult, setRebindVerifyResult] = useState<any>(null);
  const [rebindVerifying, setRebindVerifying] = useState(false);
  const [rebindSaving, setRebindSaving] = useState(false);
  const [highlightRebindPanel, setHighlightRebindPanel] = useState(false);
  const [rebindFocusTrigger, setRebindFocusTrigger] = useState(0);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rebindPanelRef = useRef<HTMLDivElement | null>(null);
  const rebindPanelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();

  const load = async () => {
    const [accountsResult, sitesResult] = await Promise.allSettled([
      api.getAccounts(),
      api.getSites(),
    ]);
    if (accountsResult.status === 'fulfilled') {
      setAccounts(accountsResult.value || []);
    } else {
      toast.error('加载账号列表失败');
    }
    if (sitesResult.status === 'fulfilled') {
      setSites(sitesResult.value || []);
    }
    setLoaded(true);
  };
  useEffect(() => { void load(); }, []);

  const sortedAccounts = useMemo(
    () => sortItemsForDisplay(accounts, sortMode, (account) => account.balance || 0),
    [accounts, sortMode],
  );

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
      if (rebindPanelTimerRef.current) {
        clearTimeout(rebindPanelTimerRef.current);
      }
    };
  }, []);

  const handleLoginAdd = async () => {
    if (!loginForm.siteId || !loginForm.username || !loginForm.password) return;
    setSaving(true);
    try {
      const result = await api.loginAccount(loginForm);
      if (result.success) {
        setShowAdd(false);
        setLoginForm({ siteId: 0, username: '', password: '' });
        const msg = result.apiTokenFound
          ? `账号 "${loginForm.username}" 已添加，API Key 已自动获取`
          : `账号 "${loginForm.username}" 已添加（未找到 API Key，请手动设置）`;
        toast.success(msg);
        load();
      } else {
        toast.error(result.message || '登录失败');
      }
    } catch (e: any) {
      toast.error(e.message || '登录请求失败');
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyToken = async () => {
    if (!tokenForm.siteId || !tokenForm.accessToken) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await api.verifyToken({
        siteId: tokenForm.siteId,
        accessToken: tokenForm.accessToken,
        platformUserId: tokenForm.platformUserId ? parseInt(tokenForm.platformUserId) : undefined,
      });
      setVerifyResult(result);
      if (result.success) {
        toast.success(`验证成功: ${result.userInfo?.username || '未知用户'}`);
      } else {
        toast.error(result.message || 'Token 无效');
      }
    } catch (e: any) {
      toast.error(e.message || '验证失败');
      setVerifyResult({ success: false, message: e.message });
    } finally {
      setVerifying(false);
    }
  };

  const handleTokenAdd = async () => {
    if (!tokenForm.siteId || !tokenForm.accessToken) return;
    if (!verifyResult?.success) {
      toast.error('请先验证 Token 成功后再添加账号');
      return;
    }
    setSaving(true);
    try {
      const result = await api.addAccount({
        siteId: tokenForm.siteId,
        accessToken: tokenForm.accessToken,
        platformUserId: tokenForm.platformUserId ? parseInt(tokenForm.platformUserId) : undefined,
      });
      setShowAdd(false);
      setTokenForm({ siteId: 0, accessToken: '', platformUserId: '' });
      setVerifyResult(null);
      if (result.tokenType === 'apikey') {
        toast.success('已添加为 API Key 账号（可用于代理转发）');
      } else {
        const parts: string[] = [];
        if (result.usernameDetected) parts.push('用户名已自动识别');
        if (result.apiTokenFound) parts.push('API Key 已自动获取');
        const extra = parts.length ? `（${parts.join('，')}）` : '';
        toast.success(`账号已添加${extra}`);
      }
      load();
    } catch (e: any) {
      toast.error(e.message || '添加失败');
    } finally {
      setSaving(false);
    }
  };

  const withLoading = async (key: string, fn: () => Promise<any>, successMsg?: string) => {
    setActionLoading(s => ({ ...s, [key]: true }));
    try { await fn(); if (successMsg) toast.success(successMsg); }
    catch (e: any) { toast.error(e.message || '操作失败'); }
    finally {
      setActionLoading(s => ({ ...s, [key]: false }));
      void load();
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', fontSize: 13, outline: 'none',
    background: 'var(--color-bg)', color: 'var(--color-text-primary)',
  };

  const runtimeHealthMap: Record<string, {
    label: string;
    cls: string;
    dotClass: string;
    pulse: boolean;
  }> = {
    healthy: { label: '健康', cls: 'badge-success', dotClass: 'status-dot-success', pulse: true },
    unhealthy: { label: '异常', cls: 'badge-error', dotClass: 'status-dot-error', pulse: true },
    degraded: { label: '降级', cls: 'badge-warning', dotClass: 'status-dot-pending', pulse: true },
    disabled: { label: '已禁用', cls: 'badge-muted', dotClass: 'status-dot-muted', pulse: false },
    unknown: { label: '未知', cls: 'badge-muted', dotClass: 'status-dot-pending', pulse: false },
  };

  const resolveRuntimeHealth = (account: any) => {
    const fallbackState = account.status === 'disabled' || account.site?.status === 'disabled'
      ? 'disabled'
      : (account.status === 'expired' ? 'unhealthy' : 'unknown');
    const state = account.runtimeHealth?.state || fallbackState;
    const cfg = runtimeHealthMap[state] || runtimeHealthMap.unknown;
    const reason = account.runtimeHealth?.reason
      || (state === 'disabled'
        ? '账号或站点已禁用'
        : (state === 'unhealthy' ? '最近健康检查失败' : '尚未获取运行健康信息'));
    return { state, reason, ...cfg };
  };

  const handleRefreshRuntimeHealth = async () => {
    setActionLoading((s) => ({ ...s, 'health-refresh': true }));
    try {
      const res = await api.refreshAccountHealth();
      if (res?.queued) {
        toast.info(res.message || '账号状态刷新任务已提交，完成后会自动更新。');
      } else {
        toast.success(res?.message || '账号状态已刷新');
      }
      load();
    } catch (e: any) {
      toast.error(e.message || '刷新账号状态失败');
    } finally {
      setActionLoading((s) => ({ ...s, 'health-refresh': false }));
    }
  };

  const handleToggleCheckin = async (account: any) => {
    const key = `checkin-toggle-${account.id}`;
    const nextEnabled = !account.checkinEnabled;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await api.updateAccount(account.id, { checkinEnabled: nextEnabled });
      toast.success(nextEnabled ? '已开启签到' : '已关闭签到（全部签到会忽略此账号）');
      load();
    } catch (e: any) {
      toast.error(e.message || '切换签到状态失败');
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const handleTogglePin = async (account: any) => {
    const key = `pin-toggle-${account.id}`;
    const nextPinned = !account.isPinned;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await api.updateAccount(account.id, { isPinned: nextPinned });
      toast.success(nextPinned ? '账号已置顶' : '账号已取消置顶');
      load();
    } catch (e: any) {
      toast.error(e.message || '切换账号置顶失败');
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const handleMoveCustomOrder = async (account: any, direction: 'up' | 'down') => {
    const key = `reorder-${account.id}`;
    const updates = buildCustomReorderUpdates(accounts, account.id, direction);
    if (updates.length === 0) return;

    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await Promise.all(updates.map((update) => api.updateAccount(update.id, { sortOrder: update.sortOrder })));
      load();
    } catch (e: any) {
      toast.error(e.message || '更新账号排序失败');
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const extractPlatformUserId = (account: any): string => {
    try {
      const parsed = JSON.parse(account?.extraConfig || '{}');
      const raw = parsed?.platformUserId;
      const value = Number.parseInt(String(raw ?? ''), 10);
      if (Number.isFinite(value) && value > 0) return String(value);
    } catch {}
    const guessed = Number.parseInt(String(account?.username || '').match(/(\d{3,8})$/)?.[1] || '', 10);
    return Number.isFinite(guessed) && guessed > 0 ? String(guessed) : '';
  };

  const openRebindPanel = (account: any) => {
    setRebindTarget(account);
    setRebindForm({
      accessToken: '',
      platformUserId: extractPlatformUserId(account),
    });
    setRebindVerifyResult(null);
    setRebindFocusTrigger((value) => value + 1);
  };

  const closeRebindPanel = () => {
    setRebindTarget(null);
    setRebindForm({ accessToken: '', platformUserId: '' });
    setRebindVerifyResult(null);
    setRebindVerifying(false);
    setRebindSaving(false);
    setHighlightRebindPanel(false);
  };

  useEffect(() => {
    if (!rebindTarget || rebindFocusTrigger <= 0) return;

    setHighlightRebindPanel(true);
    rebindPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (rebindPanelTimerRef.current) {
      clearTimeout(rebindPanelTimerRef.current);
    }
    rebindPanelTimerRef.current = setTimeout(() => {
      setHighlightRebindPanel(false);
    }, 2200);
  }, [rebindFocusTrigger, rebindTarget]);

  const handleVerifyRebindToken = async () => {
    if (!rebindTarget || !rebindForm.accessToken.trim()) return;
    setRebindVerifying(true);
    setRebindVerifyResult(null);
    try {
      const result = await api.verifyToken({
        siteId: rebindTarget.siteId,
        accessToken: rebindForm.accessToken.trim(),
        platformUserId: rebindForm.platformUserId ? Number.parseInt(rebindForm.platformUserId, 10) : undefined,
      });
      setRebindVerifyResult(result);
      if (result.success && result.tokenType === 'session') {
        toast.success('Session Token 验证成功，可以重新绑定');
      } else if (result.success && result.tokenType !== 'session') {
        toast.error('当前是 API Key，不是 Session Token');
      } else {
        toast.error(result.message || 'Token 无效');
      }
    } catch (e: any) {
      toast.error(e.message || '验证失败');
      setRebindVerifyResult({ success: false, message: e.message });
    } finally {
      setRebindVerifying(false);
    }
  };

  const handleSubmitRebind = async () => {
    if (!rebindTarget || !rebindForm.accessToken.trim()) return;
    if (!(rebindVerifyResult?.success && rebindVerifyResult?.tokenType === 'session')) {
      toast.error('请先验证新的 Session Token 成功');
      return;
    }
    setRebindSaving(true);
    try {
      await api.rebindAccountSession(rebindTarget.id, {
        accessToken: rebindForm.accessToken.trim(),
        platformUserId: rebindForm.platformUserId ? Number.parseInt(rebindForm.platformUserId, 10) : undefined,
      });
      toast.success('账号重新绑定成功，状态已恢复');
      closeRebindPanel();
      load();
    } catch (e: any) {
      toast.error(e.message || '重新绑定失败');
    } finally {
      setRebindSaving(false);
    }
  };

  useEffect(() => {
    const { accountId, openRebind } = readFocusAccountIntent(location.search);
    if (!accountId || !loaded) return;

    const target = sortedAccounts.find((account) => account.id === accountId);
    const row = rowRefs.current.get(accountId);
    const cleanedSearch = clearFocusParams(location.search);
    if (!target || !row) {
      navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
      return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightAccountId(accountId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightAccountId((current) => (current === accountId ? null : current));
    }, 2200);

    if (openRebind && target.status === 'expired') {
      setShowAdd(false);
      if (!rebindTarget || rebindTarget.id !== target.id) {
        openRebindPanel(target);
      }
    }

    navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
  }, [loaded, location.pathname, location.search, navigate, openRebindPanel, rebindTarget, sortedAccounts]);

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">{tr('账号管理')}</h2>
        <div className="page-actions accounts-page-actions">
          <div className="accounts-sort-select" style={{ minWidth: 156, position: 'relative', zIndex: 20 }}>
            <ModernSelect
              size="sm"
              value={sortMode}
              onChange={(nextValue) => setSortMode(nextValue as SortMode)}
              options={[
                { value: 'custom', label: '自定义排序' },
                { value: 'balance-desc', label: '余额高到低' },
                { value: 'balance-asc', label: '余额低到高' },
              ]}
              placeholder="自定义排序"
            />
          </div>
          <button onClick={() => withLoading('checkin-all', () => api.triggerCheckinAll(), '已触发全部签到')} disabled={actionLoading['checkin-all']}
            className="btn btn-soft-primary">
            {actionLoading['checkin-all'] ? <><span className="spinner spinner-sm" />{tr('签到中...')}</> : tr('全部签到')}
          </button>
          <button
            onClick={handleRefreshRuntimeHealth}
            disabled={actionLoading['health-refresh']}
            className="btn btn-soft-primary"
          >
            {actionLoading['health-refresh'] ? <><span className="spinner spinner-sm" />{tr('刷新状态中...')}</> : tr('刷新账户状态')}
          </button>
          <button onClick={() => { setShowAdd(!showAdd); setAddMode('token'); setVerifyResult(null); }} className="btn btn-primary">
            {showAdd ? tr('取消') : tr('+ 添加账号')}
          </button>
        </div>
      </div>

      {/* Add Panel */}
      {showAdd && (
        <div className="card animate-scale-in" style={getAccountsAddPanelStyle()}>
          {/* Mode tabs */}
          <div style={{ display: 'flex', gap: 0, background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', padding: 3, marginBottom: 16 }}>
            <button onClick={() => { setAddMode('token'); setVerifyResult(null); }}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 6, fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer', transition: 'all 0.2s',
                background: addMode === 'token' ? 'var(--color-bg-card)' : 'transparent',
                color: addMode === 'token' ? 'var(--color-primary)' : 'var(--color-text-muted)',
                boxShadow: addMode === 'token' ? 'var(--shadow-sm)' : 'none'
              }}>
              Cookie / Token 导入
            </button>
            <button onClick={() => { setAddMode('login'); setVerifyResult(null); }}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 6, fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer', transition: 'all 0.2s',
                background: addMode === 'login' ? 'var(--color-bg-card)' : 'transparent',
                color: addMode === 'login' ? 'var(--color-primary)' : 'var(--color-text-muted)',
                boxShadow: addMode === 'login' ? 'var(--shadow-sm)' : 'none'
              }}>
              账号密码登录
            </button>
          </div>

          {addMode === 'token' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="info-tip">
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>支持两种凭证类型，系统自动识别</div>
                  <div><strong>API Key</strong>（在站点「令牌」页面生成）→ 用于代理转发</div>
                  <div><strong>Session Cookie</strong>（从浏览器获取）→ 支持签到、余额查询等全部功能</div>
                  <div style={{ opacity: 0.7, borderTop: '1px solid rgba(0,0,0,0.1)', paddingTop: 6, marginTop: 6 }}>
                    获取 Session Cookie: <kbd style={{ padding: '1px 5px', background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 3, fontSize: 11 }}>F12</kbd> → Application → Local Storage</div>
                </div>
              </div>
              <ModernSelect
                value={String(tokenForm.siteId || 0)}
                onChange={(nextValue) => {
                  const nextSiteId = Number.parseInt(nextValue, 10) || 0;
                  setTokenForm((f) => ({ ...f, siteId: nextSiteId }));
                  setVerifyResult(null);
                }}
                options={[
                  { value: '0', label: '选择站点' },
                  ...sites.map((s: any) => ({
                    value: String(s.id),
                    label: `${s.name} (${s.platform})`,
                  })),
                ]}
                placeholder="选择站点"
              />
              <textarea placeholder="粘贴 Session Cookie 或 API Key&#10;（系统会自动识别凭证类型）"
                value={tokenForm.accessToken}
                onChange={e => { setTokenForm(f => ({ ...f, accessToken: e.target.value.trim() })); setVerifyResult(null); }}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)', height: 72, resize: 'none' as const }} />

              {/* Verify results */}
              {verifyResult && verifyResult.success && verifyResult.tokenType === 'session' && (
                <div className="alert alert-success animate-scale-in">
                  <div className="alert-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    Session Cookie 有效
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                    <div>用户名: <strong>{verifyResult.userInfo?.username || '未知'}</strong></div>
                    {verifyResult.balance && <div>余额: <strong>${(verifyResult.balance.balance || 0).toFixed(2)}</strong></div>}
                    <div>API Key: <span style={{ fontWeight: 500, color: verifyResult.apiToken ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                      {verifyResult.apiToken ? '已找到 (' + verifyResult.apiToken.substring(0, 8) + '...)' : '未找到'}
                    </span></div>
                  </div>
                </div>
              )}
              {verifyResult && verifyResult.success && verifyResult.tokenType === 'apikey' && (
                <div className="alert alert-info animate-scale-in">
                  <div className="alert-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                    识别为 API Key
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                    <div>可用模型: <strong>{verifyResult.modelCount} 个</strong></div>
                    {verifyResult.models && <div style={{ color: 'var(--color-text-muted)' }}>包含: {verifyResult.models.join(', ')}{verifyResult.modelCount > 10 ? ' ...' : ''}</div>}
                  </div>
                </div>
              )}
              {verifyResult && !verifyResult.success && verifyResult.needsUserId && (
                <div className="alert alert-warning animate-scale-in">
                  <div className="alert-title">
                    Token 已识别，但此站点需要提供用户 ID
                  </div>
                  <input placeholder="用户 ID（数字）" value={tokenForm.platformUserId}
                    onChange={e => setTokenForm(f => ({ ...f, platformUserId: e.target.value.replace(/\D/g, '') }))}
                    style={{ ...inputStyle, borderColor: 'color-mix(in srgb, var(--color-warning) 45%, transparent)' }} />
                </div>
              )}
              {verifyResult && !verifyResult.success && !verifyResult.needsUserId && (
                <div className="alert alert-error animate-scale-in">
                  <div className="alert-title">
                    {verifyResult.message || 'Token 无效或已过期'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>请检查 Token 是否正确</div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleVerifyToken} disabled={verifying || !tokenForm.siteId || !tokenForm.accessToken}
                  className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}>
                  {verifying ? <><span className="spinner spinner-sm" />验证中...</> : '验证 Token'}
                </button>
                <button onClick={handleTokenAdd} disabled={saving || !tokenForm.siteId || !tokenForm.accessToken || !verifyResult?.success}
                  className="btn btn-success">
                  {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />添加中...</> : '添加账号'}
                </button>
              </div>
              {!verifyResult?.success && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  请先点击“验证 Token”，验证成功后才能添加账号
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="info-tip">
                输入目标站点的账号密码，将自动登录并获取访问令牌和 API Key
              </div>
              <ModernSelect
                value={String(loginForm.siteId || 0)}
                onChange={(nextValue) => {
                  const nextSiteId = Number.parseInt(nextValue, 10) || 0;
                  setLoginForm((f) => ({ ...f, siteId: nextSiteId }));
                }}
                options={[
                  { value: '0', label: '选择站点' },
                  ...sites.map((s: any) => ({
                    value: String(s.id),
                    label: `${s.name} (${s.platform})`,
                  })),
                ]}
                placeholder="选择站点"
              />
              <input placeholder="用户名" value={loginForm.username} onChange={e => setLoginForm(f => ({ ...f, username: e.target.value }))} style={inputStyle} />
              <input type="password" placeholder="密码" value={loginForm.password} onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))} onKeyDown={e => e.key === 'Enter' && handleLoginAdd()} style={inputStyle} />
              <button onClick={handleLoginAdd} disabled={saving || !loginForm.siteId || !loginForm.username || !loginForm.password}
                className="btn btn-success" style={{ alignSelf: 'flex-start' }}>
                {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />登录并添加...</> : '登录并添加'}
              </button>
            </div>
          )}
        </div>
      )}

      {rebindTarget && (
        <div
          ref={rebindPanelRef}
          className={`card animate-scale-in rebind-panel ${highlightRebindPanel ? 'rebind-panel-highlight' : ''}`}
          style={{ marginBottom: 16, padding: 16 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-primary)' }}>
              重新绑定 Session Token
            </div>
            <button className="btn btn-ghost" onClick={closeRebindPanel}>关闭</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            账号: {rebindTarget.username || '未命名'} @ {rebindTarget.site?.name || '-'}。请粘贴新的 Session Token，验证成功后再绑定。
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 10, marginBottom: 10 }}>
            <textarea
              placeholder="粘贴新的 Session Token"
              value={rebindForm.accessToken}
              onChange={(e) => {
                setRebindForm((prev) => ({ ...prev, accessToken: e.target.value.trim() }));
                setRebindVerifyResult(null);
              }}
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)', height: 74, resize: 'none' as const }}
            />
            <input
              placeholder="用户 ID（可选）"
              value={rebindForm.platformUserId}
              onChange={(e) => {
                setRebindForm((prev) => ({ ...prev, platformUserId: e.target.value.replace(/\D/g, '') }));
                setRebindVerifyResult(null);
              }}
              style={inputStyle}
            />
          </div>

          {rebindVerifyResult && rebindVerifyResult.success && rebindVerifyResult.tokenType === 'session' && (
            <div className="alert alert-success animate-scale-in" style={{ marginBottom: 10 }}>
              <div className="alert-title">Session Token 有效</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                用户: {rebindVerifyResult.userInfo?.username || '未知'}
                {rebindVerifyResult.apiToken ? `，已识别 API Key (${String(rebindVerifyResult.apiToken).slice(0, 8)}...)` : ''}
              </div>
            </div>
          )}
          {rebindVerifyResult && (!rebindVerifyResult.success || rebindVerifyResult.tokenType !== 'session') && (
            <div className="alert alert-error animate-scale-in" style={{ marginBottom: 10 }}>
              <div className="alert-title">
                {rebindVerifyResult.message || 'Token 无效或类型不正确'}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleVerifyRebindToken}
              disabled={rebindVerifying || !rebindForm.accessToken.trim()}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {rebindVerifying ? <><span className="spinner spinner-sm" />验证中...</> : '验证 Token'}
            </button>
            <button
              onClick={handleSubmitRebind}
              disabled={rebindSaving || !(rebindVerifyResult?.success && rebindVerifyResult?.tokenType === 'session')}
              className="btn btn-success"
            >
              {rebindSaving
                ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />绑定中...</>
                : '确认重新绑定'}
            </button>
          </div>
        </div>
      )}

      {/* Accounts Table */}
      <div className="card" style={{ overflowX: 'auto' }}>
        {accounts.length > 0 ? (
          <table className="data-table accounts-table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>站点</th>
                <th>运行健康状态</th>
                <th>余额</th>
                <th>已用</th>
                <th>签到</th>
                <th className="accounts-actions-col" style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sortedAccounts.map((a: any, i: number) => (
                <tr
                  key={a.id}
                  ref={(node) => {
                    if (node) rowRefs.current.set(a.id, node);
                    else rowRefs.current.delete(a.id);
                  }}
                  className={`animate-slide-up stagger-${Math.min(i + 1, 5)} ${highlightAccountId === a.id ? 'row-focus-highlight' : ''}`}
                >
                  <td style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{a.username || '未命名'}</td>
                  <td>
                    {a.site?.url ? (
                      <a
                        href={a.site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="badge-link"
                      >
                        <span className="badge badge-muted" style={{ fontSize: 11 }}>
                          {a.site?.name || '-'}
                        </span>
                      </a>
                    ) : (
                      <span className="badge badge-muted" style={{ fontSize: 11 }}>
                        {a.site?.name || '-'}
                      </span>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const health = resolveRuntimeHealth(a);
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span className={`badge ${health.cls}`} style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, width: 'fit-content' }}>
                            <span className={`status-dot ${health.dotClass} ${health.pulse ? 'animate-pulse-dot' : ''}`} style={{ marginRight: 0 }} />
                            {health.label}
                          </span>
                          <span
                            style={{
                              fontSize: 11,
                              color: 'var(--color-text-muted)',
                              maxWidth: 200,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={health.reason}
                          >
                            {health.reason}
                          </span>
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>${(a.balance || 0).toFixed(2)}</div>
                    <div style={{ fontSize: 11, color: (a.todayReward || 0) > 0 ? 'var(--color-success)' : 'var(--color-text-muted)', fontWeight: 500 }}>
                      +{(a.todayReward || 0).toFixed(2)}
                    </div>
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                    <div>${(a.balanceUsed || 0).toFixed(2)}</div>
                    <div style={{ fontSize: 11, color: (a.todaySpend || 0) > 0 ? 'var(--color-danger)' : 'var(--color-text-muted)', fontWeight: 500 }}>
                      -{(a.todaySpend || 0).toFixed(2)}
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`checkin-toggle-badge ${a.checkinEnabled ? 'is-on' : 'is-off'}`}
                      onClick={() => handleToggleCheckin(a)}
                      disabled={!!actionLoading[`checkin-toggle-${a.id}`]}
                      title={a.checkinEnabled ? '点击关闭签到，全部签到会忽略此账号' : '点击开启签到'}
                    >
                      {actionLoading[`checkin-toggle-${a.id}`]
                        ? <span className="spinner spinner-sm" />
                        : (a.checkinEnabled ? '开启' : '关闭')}
                    </button>
                  </td>
                  <td className="accounts-actions-cell" style={{ textAlign: 'right' }}>
                    <div className="accounts-row-actions">
                      <button
                        onClick={() => handleTogglePin(a)}
                        disabled={!!actionLoading[`pin-toggle-${a.id}`]}
                        className={`btn btn-link ${a.isPinned ? 'btn-link-warning' : 'btn-link-primary'}`}
                      >
                        {actionLoading[`pin-toggle-${a.id}`] ? <span className="spinner spinner-sm" /> : (a.isPinned ? '取消置顶' : '置顶')}
                      </button>
                      {sortMode === 'custom' && (
                        <>
                          <button
                            onClick={() => handleMoveCustomOrder(a, 'up')}
                            disabled={!!actionLoading[`reorder-${a.id}`]}
                            className="btn btn-link btn-link-muted"
                          >
                            ↑
                          </button>
                          <button
                            onClick={() => handleMoveCustomOrder(a, 'down')}
                            disabled={!!actionLoading[`reorder-${a.id}`]}
                            className="btn btn-link btn-link-muted"
                          >
                            ↓
                          </button>
                        </>
                      )}
                      <button onClick={() => withLoading(`refresh-${a.id}`, () => api.refreshBalance(a.id), '余额已刷新')} disabled={actionLoading[`refresh-${a.id}`]}
                        className="btn btn-link btn-link-primary">
                        {actionLoading[`refresh-${a.id}`] ? <span className="spinner spinner-sm" /> : '刷新'}
                      </button>
                      <button onClick={() => withLoading(`models-${a.id}`, () => api.checkModels(a.id), '模型已更新')} disabled={actionLoading[`models-${a.id}`]}
                        className="btn btn-link btn-link-info">
                        {actionLoading[`models-${a.id}`] ? <span className="spinner spinner-sm" /> : '模型'}
                      </button>
                      <button onClick={() => withLoading(`checkin-${a.id}`, () => api.triggerCheckin(a.id), '签到完成')} disabled={actionLoading[`checkin-${a.id}`]}
                        className="btn btn-link btn-link-warning">
                        {actionLoading[`checkin-${a.id}`] ? <span className="spinner spinner-sm" /> : '签到'}
                      </button>
                      {a.status === 'expired' && (
                        <button
                          onClick={() => openRebindPanel(a)}
                          className="btn btn-link btn-link-warning"
                        >
                          重新绑定
                        </button>
                      )}
                      <button onClick={() => withLoading(`delete-${a.id}`, () => api.deleteAccount(a.id), '已删除')} disabled={actionLoading[`delete-${a.id}`]}
                        className="btn btn-link btn-link-danger">
                        {actionLoading[`delete-${a.id}`] ? <span className="spinner spinner-sm" /> : '删除'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            <div className="empty-state-title">暂无账号</div>
            <div className="empty-state-desc">请先添加站点，然后添加账号</div>
          </div>
        )}
      </div>
    </div>
  );
}
