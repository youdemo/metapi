import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import { clearFocusParams, readFocusSiteId } from './helpers/navigationFocus.js';
import { tr } from '../i18n.js';
import { buildCustomReorderUpdates, sortItemsForDisplay, type SortMode } from './helpers/listSorting.js';
import {
  buildSiteSaveAction,
  emptySiteForm,
  siteFormFromSite,
  type SiteEditorState,
  type SiteForm,
} from './helpers/sitesEditor.js';

type SiteRow = {
  id: number;
  name: string;
  url: string;
  platform?: string;
  status?: string;
  apiKey?: string;
  proxyUrl?: string | null;
  isPinned?: boolean;
  sortOrder?: number;
  totalBalance?: number;
  createdAt?: string;
};

const platformColors: Record<string, string> = {
  'new-api': 'badge-info',
  'one-api': 'badge-success',
  veloera: 'badge-warning',
  'one-hub': 'badge-muted',
  'done-hub': 'badge-muted',
  sub2api: 'badge-muted',
  openai: 'badge-success',
  claude: 'badge-warning',
  gemini: 'badge-info',
};

export default function Sites() {
  const location = useLocation();
  const navigate = useNavigate();
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('custom');
  const [highlightSiteId, setHighlightSiteId] = useState<number | null>(null);
  const [editor, setEditor] = useState<SiteEditorState | null>(null);
  const [form, setForm] = useState<SiteForm>(emptySiteForm());
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [togglingSiteId, setTogglingSiteId] = useState<number | null>(null);
  const [orderingSiteId, setOrderingSiteId] = useState<number | null>(null);
  const [pinningSiteId, setPinningSiteId] = useState<number | null>(null);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const highlightTimerRef = useRef<number | null>(null);
  const toast = useToast();

  const isEditing = editor?.mode === 'edit';
  const isAdding = editor?.mode === 'add';

  const load = async () => {
    try {
      const rows = await api.getSites();
      setSites(rows || []);
    } catch {
      toast.error('加载站点列表失败');
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const sortedSites = useMemo(
    () => sortItemsForDisplay(sites, sortMode, (site) => site.totalBalance || 0),
    [sites, sortMode],
  );

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const focusSiteId = readFocusSiteId(location.search);
    if (!focusSiteId || !loaded) return;

    const row = rowRefs.current.get(focusSiteId);
    const cleanedSearch = clearFocusParams(location.search);
    if (!row) {
      navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
      return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightSiteId(focusSiteId);
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightSiteId((current) => (current === focusSiteId ? null : current));
    }, 2200);

    navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
  }, [loaded, location.pathname, location.search, navigate, sortedSites]);

  const closeEditor = () => {
    setEditor(null);
    setForm(emptySiteForm());
  };

  const openAdd = () => {
    if (isAdding) {
      closeEditor();
      return;
    }
    setEditor({ mode: 'add' });
    setForm(emptySiteForm());
  };

  const openEdit = (site: SiteRow) => {
    setEditor({ mode: 'edit', editingSiteId: site.id });
    setForm(siteFormFromSite(site));
  };

  const handleSave = async () => {
    if (!editor) return;
    const payload = {
      name: form.name.trim(),
      url: form.url.trim(),
      platform: form.platform.trim(),
      apiKey: form.apiKey.trim(),
      proxyUrl: form.proxyUrl.trim(),
    };
    if (!payload.name || !payload.url) {
      toast.error('请填写站点名称和 URL');
      return;
    }

    setSaving(true);
    try {
      const action = buildSiteSaveAction(editor, payload);
      if (action.kind === 'add') {
        await api.addSite(action.payload);
        toast.success(`站点 "${payload.name}" 已添加`);
      } else {
        await api.updateSite(action.id, action.payload);
        toast.success(`站点 "${payload.name}" 已更新`);
      }
      closeEditor();
      await load();
    } catch (e: any) {
      toast.error(e.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDetect = async () => {
    if (!form.url.trim()) {
      toast.error('请先输入 URL');
      return;
    }
    setDetecting(true);
    try {
      const result = await api.detectSite(form.url.trim());
      if (result?.platform) {
        setForm((prev) => ({ ...prev, platform: result.platform }));
        toast.success(`检测到平台: ${result.platform}`);
      } else {
        toast.error(result?.error || '无法识别平台类型');
      }
    } catch (e: any) {
      toast.error(e.message || '自动检测失败');
    } finally {
      setDetecting(false);
    }
  };

  const handleDelete = async (site: SiteRow) => {
    setDeleting(site.id);
    try {
      await api.deleteSite(site.id);
      toast.success(`站点 "${site.name}" 已删除`);
      await load();
    } catch (e: any) {
      toast.error(e.message || '删除失败');
    } finally {
      setDeleting(null);
    }
  };

  const handleToggleStatus = async (site: SiteRow) => {
    const nextStatus = site.status === 'disabled' ? 'active' : 'disabled';
    setTogglingSiteId(site.id);
    try {
      await api.updateSite(site.id, { status: nextStatus });
      toast.success(nextStatus === 'disabled' ? `站点 "${site.name}" 已禁用` : `站点 "${site.name}" 已启用`);
      await load();
    } catch (e: any) {
      toast.error(e.message || '切换站点状态失败');
    } finally {
      setTogglingSiteId(null);
    }
  };

  const handleTogglePin = async (site: SiteRow) => {
    const nextPinned = !site.isPinned;
    setPinningSiteId(site.id);
    try {
      await api.updateSite(site.id, { isPinned: nextPinned });
      toast.success(nextPinned ? `站点 "${site.name}" 已置顶` : `站点 "${site.name}" 已取消置顶`);
      await load();
    } catch (e: any) {
      toast.error(e.message || '切换置顶失败');
    } finally {
      setPinningSiteId(null);
    }
  };

  const handleMoveCustomOrder = async (site: SiteRow, direction: 'up' | 'down') => {
    const updates = buildCustomReorderUpdates(sites, site.id, direction);
    if (updates.length === 0) return;

    setOrderingSiteId(site.id);
    try {
      await Promise.all(updates.map((update) => api.updateSite(update.id, { sortOrder: update.sortOrder })));
      await load();
    } catch (e: any) {
      toast.error(e.message || '更新排序失败');
    } finally {
      setOrderingSiteId(null);
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">{tr('站点管理')}</h2>
        <div className="page-actions sites-page-actions">
          <div className="sites-sort-select" style={{ minWidth: 156, position: 'relative', zIndex: 20 }}>
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
          <button onClick={openAdd} className="btn btn-primary">
            {isAdding ? '取消' : '+ 添加站点'}
          </button>
        </div>
      </div>

      {editor && (
        <div className="card animate-scale-in" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {isEditing ? '编辑站点' : '添加站点'}
            </div>
            <button onClick={closeEditor} className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}>
              取消
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              placeholder="站点名称"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              style={{
                width: '100%',
                padding: '10px 14px',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 13,
                outline: 'none',
                background: 'var(--color-bg)',
                color: 'var(--color-text-primary)',
              }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                placeholder="站点 URL (例如 https://api.example.com)"
                value={form.url}
                onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
                onBlur={() => {
                  if (form.url.trim() && !form.platform.trim()) {
                    handleDetect();
                  }
                }}
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                  outline: 'none',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text-primary)',
                }}
              />
              <button
                onClick={handleDetect}
                disabled={detecting || !form.url.trim()}
                className="btn btn-ghost"
                style={{ padding: '10px 14px', minWidth: 96, border: '1px solid var(--color-border)' }}
              >
                {detecting ? <><span className="spinner spinner-sm" /> 检测中</> : '自动检测'}
              </button>
            </div>
            <input
              placeholder="平台类型（可自动检测）"
              value={form.platform}
              onChange={(e) => setForm((prev) => ({ ...prev, platform: e.target.value }))}
              style={{
                width: '100%',
                padding: '10px 14px',
                border: `1px solid ${form.platform.trim() ? 'color-mix(in srgb, var(--color-success) 48%, transparent)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-sm)',
                fontSize: 13,
                outline: 'none',
                background: form.platform.trim() ? 'color-mix(in srgb, var(--color-success) 10%, var(--color-bg))' : 'var(--color-bg)',
                color: 'var(--color-text-primary)',
                transition: 'all 0.2s',
              }}
            />
            <input
              placeholder="API Key（可选）"
              value={form.apiKey}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              style={{
                width: '100%',
                padding: '10px 14px',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 13,
                outline: 'none',
                background: 'var(--color-bg)',
                color: 'var(--color-text-primary)',
              }}
            />
            <input
              placeholder="出站代理 URL（可选，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）"
              value={form.proxyUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, proxyUrl: e.target.value }))}
              style={{
                width: '100%',
                padding: '10px 14px',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 13,
                outline: 'none',
                background: 'var(--color-bg)',
                color: 'var(--color-text-primary)',
              }}
            />
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim() || !form.url.trim()}
              className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}
            >
              {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : (isEditing ? '保存修改' : '保存站点')}
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        {sites.length > 0 ? (
          <table className="data-table sites-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>URL</th>
                <th>总余额</th>
                <th>状态</th>
                <th>平台</th>
                <th>创建时间</th>
                <th className="sites-actions-col" style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sortedSites.map((site, i) => (
                <tr
                  key={site.id}
                  ref={(node) => {
                    if (node) rowRefs.current.set(site.id, node);
                    else rowRefs.current.delete(site.id);
                  }}
                  className={`animate-slide-up stagger-${Math.min(i + 1, 5)} ${highlightSiteId === site.id ? 'row-focus-highlight' : ''}`}
                >
                  <td style={{ fontWeight: 600 }}>
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: 'var(--color-text-primary)',
                        textDecoration: 'underline',
                      }}
                    >
                      {site.name}
                    </a>
                  </td>
                  <td className="sites-url-cell" style={{ maxWidth: 300 }}>
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="sites-url-link"
                      style={{
                        fontSize: 12,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-primary)',
                        textDecoration: 'underline',
                        wordBreak: 'break-all',
                      }}
                    >
                      {site.url}
                    </a>
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    ${(site.totalBalance || 0).toFixed(2)}
                  </td>
                  <td>
                    <span className={`badge ${site.status === 'disabled' ? 'badge-muted' : 'badge-success'}`} style={{ fontSize: 11 }}>
                      {site.status === 'disabled' ? '禁用' : '启用'}
                    </span>
                  </td>
                  <td>
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ textDecoration: 'none' }}
                    >
                      <span className={`badge ${platformColors[site.platform || ''] || 'badge-muted'}`}>
                        {site.platform || '-'}
                      </span>
                    </a>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--color-text-muted)', textDecoration: 'underline' }}
                    >
                      {formatDateTimeLocal(site.createdAt)}
                    </a>
                  </td>
                  <td className="sites-actions-cell" style={{ textAlign: 'right' }}>
                    <div className="sites-row-actions">
                      <button
                        onClick={() => handleTogglePin(site)}
                        disabled={pinningSiteId === site.id}
                        className={`btn btn-link ${site.isPinned ? 'btn-link-warning' : 'btn-link-primary'}`}
                      >
                        {pinningSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.isPinned ? '取消置顶' : '置顶')}
                      </button>
                      {sortMode === 'custom' && (
                        <>
                          <button
                            onClick={() => handleMoveCustomOrder(site, 'up')}
                            disabled={orderingSiteId === site.id}
                            className="btn btn-link btn-link-muted"
                          >
                            ↑
                          </button>
                          <button
                            onClick={() => handleMoveCustomOrder(site, 'down')}
                            disabled={orderingSiteId === site.id}
                            className="btn btn-link btn-link-muted"
                          >
                            ↓
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => openEdit(site)}
                        className="btn btn-link btn-link-primary"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => handleToggleStatus(site)}
                        disabled={togglingSiteId === site.id}
                        className={`btn btn-link ${site.status === 'disabled' ? 'btn-link-primary' : 'btn-link-warning'}`}
                      >
                        {togglingSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.status === 'disabled' ? '启用' : '禁用')}
                      </button>
                      <button
                        onClick={() => handleDelete(site)}
                        disabled={deleting === site.id}
                        className="btn btn-link btn-link-danger"
                      >
                        {deleting === site.id ? <span className="spinner spinner-sm" /> : null}
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"
              />
            </svg>
            <div className="empty-state-title">暂无站点</div>
            <div className="empty-state-desc">点击“+ 添加站点”开始使用。</div>
          </div>
        )}
      </div>
    </div>
  );
}
