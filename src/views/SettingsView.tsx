// 设置页（电视版）：单屏两列布局，无整页滚动（像桌面版 ZEX 一样分区同屏展示）。
// 左列 NAS 服务器管理（大区，行多时卡片内部滚动）；右列 TMDB / 代理 / 语言 纵向堆叠。
// 焦点：左右两个板块组（'settings:nas' / 'settings:right'）。
// 上下只在板块内移动（越顶回导航）；左右只在两板块之间切换，各板块记住自己的焦点行。

import { useEffect, useState } from 'react';
import { Server, Plus, Trash2, Loader2, Key, Globe, Languages, Check, Pencil, Eraser } from 'lucide-react';
import { clsx } from 'clsx';
import * as api from '../api';
import type { SmbServer } from '../types';
import { useFocusIndex, useGamepadGroup, useFocusStore, useModalGamepad } from '../gamepad';
import { useT, useLang, setLang, LANGUAGES, type Lang } from '../i18n';
import { useAppStore } from '../store';

const EMPTY_SERVER: SmbServer = { id: '', name: '', host: '', port: 445, username: '', password: '', created_at: '' };

// 构建时间戳（vite.config.ts 里 define 注入）：每次打包都变，真机看它确认装的是新包
const buildStamp = typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : '';

export default function SettingsView() {
  const t = useT();
  const lang = useLang();
  const [tmdbKey, setTmdbKey] = useState('');
  const [proxy, setProxy] = useState('');
  const [servers, setServers] = useState<SmbServer[]>([]);
  const [version, setVersion] = useState('');
  const [editing, setEditing] = useState<SmbServer | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  // 清除数据：null = 未触发；数字 = 待确认（值为库里的剧数，确认框里显示）
  const [clearAsk, setClearAsk] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void api.getSetting('tmdb_api_key').then((v) => setTmdbKey(v ?? '')).catch(() => {});
    void api.getSetting('http_proxy').then((v) => setProxy(v ?? '')).catch(() => {});
    void api.getSmbServers().then(setServers).catch(() => {});
    void api.getVersion().then(setVersion).catch(() => {});
  }, []);

  // ─── 左模块：添加 NAS → NAS 列表 → 删除 ─────────
  // 左右只切换模块；上下严格按这三个纵向区域移动。
  const addIdx = 0;
  const nasStart = 1;
  const deleteStart = 1 + servers.length;
  const nasTotal = deleteStart + servers.length;
  const deleteIdx = (i: number) => deleteStart + i;

  // ─── 右板块：TMDB → 代理 → 语言 → 清除数据（纵向）─────────
  const R = { tmdb: 0, proxy: 1, lang: 2, clear: 3 } as const;
  const rightTotal = 4;

  const nasFocused = useFocusIndex('settings:nas');
  const rightFocused = useFocusIndex('settings:right');
  // 两个大模块各自记住最后一行；左右切换时只读取目标模块的位置。
  const [lastNasRow, setLastNasRow] = useState(0);
  const [lastRightRow, setLastRightRow] = useState(0);

  useEffect(() => {
    if (nasFocused >= 0) setLastNasRow(Math.min(nasFocused, Math.max(0, nasTotal - 1)));
  }, [nasFocused, nasTotal]);
  useEffect(() => {
    if (rightFocused >= 0) setLastRightRow(Math.min(rightFocused, rightTotal - 1));
  }, [rightFocused]);

  // 删掉 NAS 后 nasTotal 变小，栈里的焦点索引可能指向已消失的行（界面无高亮，
  // 按键像失灵）。项数变化时把越界焦点收到最后一项（通常就是「添加」按钮）
  useEffect(() => {
    const s = useFocusStore.getState();
    const top = s.stack[s.stack.length - 1];
    if (top?.group !== 'settings:nas') return;
    if (top.index != null && top.index >= nasTotal) s.switchTo('settings:nas', Math.max(0, nasTotal - 1));
  }, [nasTotal]);

  // 左模块：添加 NAS → NAS 列表 → 删除；左右切到右模块。
  useGamepadGroup('settings:nas', {
    count: nasTotal,
    cols: 1,
    activate: (i) => {
      if (i === addIdx) setEditing({ ...EMPTY_SERVER });
      else if (i >= nasStart && i < deleteStart) setEditing({ ...servers[i - nasStart], password: '' });
      else if (i >= deleteStart) void delServer(servers[i - deleteStart]?.id);
    },
    scrollIntoView: (i) => {
      document.querySelector(`[data-set-item="nas-${i}"]`)?.scrollIntoView({ block: 'nearest' });
    },
    leave: (dir) => {
      // 设置页在顶部导航的序号是 2（焦点落 nav 哪项页面就切到哪项）
      if (dir === 'up') useFocusStore.getState().switchTo('nav', 2);
      if (dir === 'right') {
        useFocusStore.getState().switchTo('settings:right', Math.min(lastRightRow, rightTotal - 1));
      }
    },
  });

  // 右板块：上下板块内移动；左右切回左板块；左键越顶也回左板块
  useGamepadGroup('settings:right', {
    count: rightTotal,
    cols: 1,
    activate: (i) => {
      if (i === R.tmdb) {
        document.querySelector<HTMLInputElement>('[data-set-input="tmdb"]')?.focus();
      } else if (i === R.proxy) {
        document.querySelector<HTMLInputElement>('[data-set-input="proxy"]')?.focus();
      } else if (i === R.lang) {
        setLang(lang === 'zh' ? 'en' : 'zh');
      } else if (i === R.clear) {
        void askClear();
      }
    },
    scrollIntoView: () => {},
    leave: (dir) => {
      if (dir === 'up') useFocusStore.getState().switchTo('nav', 2);
      if (dir === 'left') {
        useFocusStore.getState().switchTo('settings:nas', Math.min(lastNasRow, nasTotal - 1));
      }
    },
  });

  const saveTmdbKey = async () => {
    setSavingKey(true);
    try { await api.setSetting('tmdb_api_key', tmdbKey.trim()); } finally { setSavingKey(false); }
  };
  const saveProxy = async () => {
    setSavingKey(true);
    try { await api.setSetting('http_proxy', proxy.trim()); } finally { setSavingKey(false); }
  };

  const delServer = async (id: string) => {
    await api.deleteSmbServer(id);
    void api.getSmbServers().then(setServers);
  };

  // 清除前先问一句：不可逆操作，且要让用户看清会删掉多少部。
  // 库本来就空就不弹框了（弹一个「确定清除 0 部吗」很蠢），直接提示
  const askClear = async () => {
    const list = await api.getSeriesLibrary().catch(() => []);
    if (list.length === 0) {
      setToast(t('settings.clearAllEmpty'));
      return;
    }
    setClearAsk(list.length);
  };

  const doClear = async () => {
    setClearAsk(null);
    setClearing(true);
    try {
      const n = await api.clearAllMedia();
      // 刷新全局 store：不刷的话切回影视库还是旧卡片、统计还是旧数字
      await Promise.allSettled([
        useAppStore.getState().loadSeries(),
        useAppStore.getState().loadStats(),
      ]);
      setToast(t('settings.clearAllDone', { n }));
    } catch (err) {
      setToast(t('settings.clearFailed', { msg: String(err) }));
    } finally {
      setClearing(false);
    }
  };

  // toast 自动消失（电视上没有鼠标可以点掉它）
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <div className="h-full overflow-hidden flex flex-col">
      <div className="px-8 pt-4 pb-2 shrink-0 flex items-baseline">
        <h1 className="text-2xl font-bold">{t('nav.settings')}</h1>
        {/* 版本号 = 应用版本 + 构建时间戳（vite 注入，每次打包必变），真机一眼确认装的是不是新包 */}
        <span className="ml-auto text-sm text-text-tertiary">
          v{version || '…'}{buildStamp ? ` · ${buildStamp}` : ''}
        </span>
      </div>

      {/* 两列单屏：左 NAS（大）· 右 其它设置（堆叠） */}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-5 px-8 pb-4">
        {/* 左板块：NAS 服务器 */}
        <section
          className={clsx('set-section flex flex-col min-h-0', nasFocused >= 0 && 'gamepad-focus-target')}
        >
          <div className="set-section-head shrink-0">
            <Server size={18} className="text-[#00d4ff]" />
            <span className="text-lg font-semibold">{t('settings.nasServers')}</span>
            <button
              data-set-item={`nas-${addIdx}`}
              onClick={() => setEditing({ ...EMPTY_SERVER })}
              className={clsx('btn btn-accent ml-auto py-2 px-4 text-sm gap-2', nasFocused === addIdx && 'gamepad-focus')}
            >
              <Plus size={16} />{t('settings.addNas')}
            </button>
          </div>

          {servers.length === 0 ? (
            <p className="text-base text-text-tertiary mt-3 flex-1 flex items-center justify-center">
              {t('settings.nasNoServers')}
            </p>
          ) : (
            // NAS 行多时仅此卡片内部滚动；四周留 6px + scroll-padding，否则
            // .gamepad-focus 的 outline/辉光会被滚动口边缘硬切掉
            <div className="mt-3 flex-1 min-h-0 overflow-y-auto p-1.5 scroll-p-1.5 space-y-2">
              {servers.map((s, i) => (
                <div key={s.id}>
                  <div
                    data-set-item={`nas-${nasStart + i}`}
                    className={clsx('nas-row', nasFocused === nasStart + i && 'gamepad-focus')}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-semibold truncate">{s.name}</p>
                      <p className="text-sm text-text-tertiary">{s.host}:{s.port} · {s.username || 'guest'}</p>
                    </div>
                    <button onClick={() => setEditing({ ...s, password: '' })} className="nas-action" title={t('settings.editNas')}>
                      <Pencil size={16} />
                    </button>
                  </div>
                  <button
                    data-set-item={`nas-${deleteIdx(i)}`}
                    onClick={() => void delServer(s.id)}
                    className={clsx(
                      'nas-action w-full mt-1 text-red-400 justify-center',
                      nasFocused === deleteIdx(i) && 'gamepad-focus',
                    )}
                    title={t('common.delete')}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 右板块：TMDB / 代理 / 语言 纵向堆叠（gap 收紧保单屏） */}
        <div className="flex flex-col gap-3 min-h-0">
          <section data-set-item={`right-${R.tmdb}`} className={clsx('set-section', rightFocused === R.tmdb && 'gamepad-focus-target')}>
            <div className="set-section-head">
              <Key size={18} className="text-[#00d4ff]" />
              <span className="text-lg font-semibold">{t('settings.tmdb')}</span>
            </div>
            <input
              data-set-input="tmdb"
              value={tmdbKey}
              onChange={(e) => setTmdbKey(e.target.value)}
              onBlur={() => void saveTmdbKey()}
              placeholder={t('settings.tmdbApiKeyPlaceholder')}
              className="input text-base mt-2"
            />
          </section>

          <section data-set-item={`right-${R.proxy}`} className={clsx('set-section', rightFocused === R.proxy && 'gamepad-focus-target')}>
            <div className="set-section-head">
              <Globe size={18} className="text-[#00d4ff]" />
              <span className="text-lg font-semibold">{t('settings.proxy')}</span>
            </div>
            <input
              data-set-input="proxy"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              onBlur={() => void saveProxy()}
              placeholder={t('settings.proxyPlaceholder')}
              className="input text-base mt-2"
            />
          </section>

          <section data-set-item={`right-${R.lang}`} className={clsx('set-section', rightFocused === R.lang && 'gamepad-focus-target')}>
            <div className="set-section-head">
              <Languages size={18} className="text-[#00d4ff]" />
              <span className="text-lg font-semibold">{t('settings.language')}</span>
            </div>
            <div className="flex items-center gap-3 mt-2">
              {LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  onClick={() => setLang(l.code as Lang)}
                  className={clsx('chip text-base', lang === l.code && 'active')}
                >
                  {lang === l.code && <Check size={15} />}
                  {l.label}
                </button>
              ))}
            </div>
          </section>

          {/* 数据：清除全部影视。flex-1 放在这块——它是右列最后一块，
              让它吃掉剩余空间，整列高度就恰好铺满一屏，不会溢出 */}
          <section
            data-set-item={`right-${R.clear}`}
            className={clsx('set-section flex-1 min-h-0 flex flex-col', rightFocused === R.clear && 'gamepad-focus-target')}
          >
            <div className="set-section-head">
              <Eraser size={18} className="text-[#00d4ff]" />
              <span className="text-lg font-semibold">{t('settings.data')}</span>
            </div>
            <p className="mt-1.5 text-sm text-text-tertiary leading-snug">{t('settings.clearAllHint')}</p>
            <button
              onClick={() => void askClear()}
              disabled={clearing}
              className={clsx(
                'btn mt-2.5 py-2 px-4 text-sm gap-2 self-start border border-[rgba(239,68,68,0.35)] text-red-400 hover:bg-[rgba(239,68,68,0.12)]',
                rightFocused === R.clear && 'gamepad-focus',
              )}
            >
              {clearing ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              {clearing ? t('settings.clearing') : t('settings.clearAll')}
            </button>
          </section>
        </div>
      </div>

      {/* NAS 编辑弹窗 */}
      {editing && (
        <NasEditModal
          server={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); void api.getSmbServers().then(setServers); }}
        />
      )}

      {/* 清除全部数据的二次确认（不可逆，必须问） */}
      {clearAsk != null && (
        <ClearConfirmModal
          count={clearAsk}
          onCancel={() => setClearAsk(null)}
          onConfirm={() => void doClear()}
        />
      )}

      {savingKey && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] glass-card px-5 py-3 flex items-center gap-2 text-sm">
          <Loader2 size={15} className="animate-spin text-[#00d4ff]" />
          {t('common.saving')}
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] glass-card px-5 py-3 text-sm max-w-[70%] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── 清除全部数据确认弹窗 ────────────────────
// 焦点两项：0 = 取消，1 = 确认清除。刻意让「取消」是第 0 项——
// 弹窗打开时焦点默认落第一项，不小心连按两次 OK 也不会把库清了
function ClearConfirmModal({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const focused = useFocusIndex('modal:clear-confirm');
  useModalGamepad('modal:clear-confirm', {
    onClose: onCancel,
    count: 2,
    cols: 1,
    activate: (i) => {
      if (i === 0) onCancel();
      else onConfirm();
    },
    scrollIntoView: () => {},
  });

  return (
    <div className="fixed inset-0 z-[260] flex items-center justify-center p-8" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-md animate-fade-in" />
      <div
        className="relative w-full max-w-lg glass-modal shadow-2xl animate-scale-in p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold flex items-center gap-2 text-red-400">
          <Trash2 size={20} />
          {t('settings.clearAll')}
        </h2>
        <p className="mt-3 text-base text-text-secondary leading-relaxed">
          {t('settings.clearAllConfirm', { n: count })}
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className={clsx('btn btn-glass py-2.5 px-5 text-sm', focused === 0 && 'gamepad-focus')}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className={clsx(
              'btn py-2.5 px-5 text-sm gap-2 bg-[rgba(239,68,68,0.18)] border border-[rgba(239,68,68,0.45)] text-red-400',
              focused === 1 && 'gamepad-focus',
            )}
          >
            <Trash2 size={15} />
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── NAS 编辑/添加弹窗 ──────────────────────
// 焦点：5 个输入框 → 测试 → 保存 → 取消（纵向一列，上下移动，OK 激活）。
// 输入框 OK = 聚焦进去调软键盘（再按 OK 由 service.ts blur 退出输入态）。
function NasEditModal({ server, onClose, onSaved }: {
  server: SmbServer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<SmbServer>(server);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<number | null>(null);

  // 焦点序号：0..4 = 名称/地址/端口/用户名/密码，5 = 测试，6 = 保存，7 = 取消
  const F = { name: 0, host: 1, port: 2, user: 3, pass: 4, test: 5, save: 6, cancel: 7 } as const;
  const FIELD_KEYS = ['name', 'host', 'port', 'user', 'pass'] as const;
  const focused = useFocusIndex('modal:nas-edit');

  useModalGamepad('modal:nas-edit', {
    // enabled 恒 true：若跟着 busy 变，测试/保存期间本组会被弹栈，
    // 焦点掉回背后的设置页（方向键在弹窗后面乱跑），回来还得重新压栈复位
    onClose: () => { if (!busy) onClose(); },
    count: 8,
    cols: 1,
    activate: (i) => {
      if (busy) return; // 测试/保存进行中不接受操作
      if (i === F.test) { void test(); return; }
      if (i === F.save) { void save(); return; }
      if (i === F.cancel) { onClose(); return; }
      // 输入框：聚焦 → 电视弹软键盘
      document.querySelector<HTMLInputElement>(`[data-nas-field="${FIELD_KEYS[i]}"]`)?.focus();
    },
    scrollIntoView: (i) => {
      const sel = i >= F.test ? `[data-nas-btn="${i}"]` : `[data-nas-field="${FIELD_KEYS[i]}"]`;
      document.querySelector(sel)?.scrollIntoView({ block: 'nearest' });
    },
  });

  const save = async () => {
    if (!form.name.trim() || !form.host.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveSmbServer(form);
      onSaved();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const test = async () => {
    if (!form.name.trim() || !form.host.trim()) return;
    setBusy(true);
    setError(null);
    setTestOk(null);
    try {
      const saved = await api.saveSmbServer(form);
      const shares = await api.listSmbShares(saved.id);
      setTestOk(shares.length);
    } catch (err) {
      setError(t('settings.nasTestFail', { msg: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-8" onClick={onClose}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-md animate-fade-in" />
      <div
        className="relative w-full max-w-lg glass-modal shadow-2xl animate-scale-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-7 py-6 border-b border-border-glass">
          <h2 className="text-xl font-bold">
            {server.id ? t('settings.editNas') : t('settings.addNas')}
          </h2>
        </div>

        <div className="p-7 space-y-4">
          <Field label={t('settings.nasName')}>
            <input
              data-nas-field="name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={clsx('input text-base', focused === F.name && 'gamepad-focus')}
            />
          </Field>
          <Field label={t('settings.nasHost')}>
            <input
              data-nas-field="host"
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              className={clsx('input text-base', focused === F.host && 'gamepad-focus')}
              placeholder="192.168.1.100"
            />
          </Field>
          <Field label={t('settings.nasPort')}>
            <input
              data-nas-field="port"
              type="number"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 445 })}
              className={clsx('input text-base w-32', focused === F.port && 'gamepad-focus')}
            />
          </Field>
          <Field label={t('settings.nasUser')}>
            <input
              data-nas-field="user"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className={clsx('input text-base', focused === F.user && 'gamepad-focus')}
              placeholder="guest"
            />
          </Field>
          <Field label={t('settings.nasPassword')}>
            <input
              data-nas-field="pass"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className={clsx('input text-base', focused === F.pass && 'gamepad-focus')}
              placeholder={server.id ? t('settings.nasPasswordKeep') : ''}
            />
          </Field>

          {testOk !== null && (
            <p className="text-sm text-green-400 flex items-center gap-1.5">
              <Check size={15} />
              {t('settings.nasTestOk', { n: testOk })}
            </p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="px-7 py-5 border-t border-border-glass flex items-center gap-3">
          <button
            data-nas-btn={F.test}
            onClick={() => void test()}
            disabled={busy}
            className={clsx('btn btn-glass px-5 py-3 text-base', focused === F.test && 'gamepad-focus')}
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : t('settings.nasTesting')}
          </button>
          <button
            data-nas-btn={F.save}
            onClick={() => void save()}
            disabled={busy || !form.name.trim() || !form.host.trim()}
            className={clsx('btn btn-accent ml-auto px-6 py-3 text-base', focused === F.save && 'gamepad-focus')}
          >
            {t('common.save')}
          </button>
          <button
            data-nas-btn={F.cancel}
            onClick={onClose}
            className={clsx('btn btn-glass px-5 py-3 text-base', focused === F.cancel && 'gamepad-focus')}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm text-text-secondary block mb-2">{label}</label>
      {children}
    </div>
  );
}
