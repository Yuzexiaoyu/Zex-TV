// 添加影视弹窗：选 NAS → 选共享 → 选文件夹（OK 即添加）。
// 电视版取向：一次 OK 全搞定——不问名称（用文件夹名，后端清洗噪声）、不问类型
// （后端按视频文件数判定：1 个 = 电影，多个 = 剧集）、加完立刻自动 TMDB 刮削。
// 剧集文件夹放在共享根目录，所以 folder 步不提供「进入子目录」——点一下就是添加它。

import { useEffect, useState } from 'react';
import { Plus, X, Server, Folder, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import * as api from '../api';
import type { SmbServer, SmbShareInfo, SmbDirEntry } from '../types';
import { useFocusIndex, useFocusStore, useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  onClose: () => void;
  onSuccess?: () => void;
}

type Step = 'nas' | 'share' | 'folder';

/** 添加进度（仅入库；刮削已移到详情页「获取元数据」手动触发）。null = 空闲 */
type Progress = { title: string } | null;

export default function AddSeriesModal({ onClose, onSuccess }: Props) {
  const t = useT();
  const [servers, setServers] = useState<SmbServer[]>([]);
  const [serverId, setServerId] = useState<string>('');
  const [shares, setShares] = useState<SmbShareInfo[]>([]);
  const [share, setShare] = useState('');
  const [entries, setEntries] = useState<SmbDirEntry[]>([]);
  const [step, setStep] = useState<Step>('nas');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSmbServers().then(setServers).catch(() => {});
  }, []);

  // 单台 NAS 时跳过选择步：出厂预置就一台，多按一次 OK 没有意义
  useEffect(() => {
    if (step === 'nas' && servers.length === 1 && !serverId && !busy) {
      void pickServer(servers[0].id);
    }
  }, [servers, step, serverId, busy]);

  // ─── 焦点组：当前步的行 + 叉 ─────────────
  const rows = step === 'nas' ? servers.length : step === 'share' ? shares.length : entries.length;
  const closeIdx = rows; // 叉永远是最后一项
  const total = rows + 1;

  const focused = useFocusIndex('modal:add-series');
  useModalGamepad('modal:add-series', {
    // enabled 恒 true：跟着 busy 变会在加载期间把本组弹栈，
    // 方向键就跑到弹窗背后的海报墙上去了，回来焦点还被重置到第 0 项
    onClose: () => { if (!busy) onClose(); },
    count: total,
    cols: 1,
    activate: (i) => {
      if (busy) return; // 扫描/刮削进行中不接受操作
      if (i === closeIdx) { onClose(); return; }
      if (step === 'nas') { const s = servers[i]; if (s) void pickServer(s.id); return; }
      if (step === 'share') { const s = shares[i]; if (s) void pickShare(s.name); return; }
      // folder 步：OK = 直接添加这个文件夹（不进入子目录）
      const e = entries[i];
      if (e) void addFolder(e.name);
    },
    scrollIntoView: (i) => {
      const sel = i === closeIdx ? '[data-add-close]' : `[data-add-row="${i}"]`;
      document.querySelector(sel)?.scrollIntoView({ block: 'nearest' });
    },
  });

  // 步骤切换后项数会变小，栈里的焦点索引可能指向已不存在的项
  // （如 12 个共享 → 下一步只有 2 个文件夹，焦点停在 7：整屏无高亮）
  useEffect(() => {
    const s = useFocusStore.getState();
    const top = s.stack[s.stack.length - 1];
    if (top?.group !== 'modal:add-series') return;
    if (top.index != null && top.index >= total) s.switchTo('modal:add-series', 0);
  }, [total, step]);

  const pickServer = async (id: string) => {
    setServerId(id);
    setBusy(true);
    setError(null);
    try {
      const list = await api.listSmbShares(id);
      setShares(list);
      setStep('share');
    } catch (err) {
      setError(t('settings.nasTestFail', { msg: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const pickShare = async (s: string) => {
    setShare(s);
    setBusy(true);
    setError(null);
    try {
      const list = await api.listSmbDir(serverId, s, '');
      setEntries(list.filter((e) => e.is_directory && e.name !== '.' && e.name !== '..'));
      setStep('folder');
    } catch (err) {
      setError(t('settings.nasTestFail', { msg: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  // 点文件夹 = 扫描 + 建库，一步入库即完成。不主动刮削——刮削改到详情页
  // 「获取元数据」手动触发，进度走底部迷你浮层（不挡操作，见 SeriesView）。
  // 添加成功即关窗回影视库（失败则留在弹窗显示错误、可重试）。
  const addFolder = async (folder: string) => {
    setBusy(true);
    setError(null);
    setProgress({ title: folder });
    try {
      await api.addSeriesBySmb({
        serverId,
        share,
        path: folder,
        title: '',        // 空 = 后端用文件夹名（清洗年份/分辨率/字幕组标记）
        mediaType: 'auto', // 后端按视频文件数判定电影/剧集
      });
      onSuccess?.();
      onClose(); // 添加完成 → 直接回主页，不保留窗口
    } catch (err) {
      setError(t('add.failed', { msg: String(err) }));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const stepHint = step === 'nas'
    ? t('add.pickNas')
    : step === 'share'
      ? t('add.pickShare')
      : t('add.pickFolderHint');

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-8" onClick={() => { if (!busy) onClose(); }}>
      <div className="absolute inset-0 bg-black/80 animate-fade-in" />
      <div
        className="relative w-full max-w-2xl max-h-full flex flex-col glass-modal shadow-2xl animate-scale-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-7 py-6 border-b border-border-glass shrink-0">
          <div className="min-w-0">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Plus size={22} className="text-[#00d4ff]" />
              {t('add.title')}
            </h2>
            <p className="mt-1.5 text-sm text-text-secondary truncate">
              {stepHint}
              {step === 'folder' && share && <span className="ml-2 text-text-tertiary">{share}</span>}
            </p>
          </div>
          <button
            data-add-close
            onClick={onClose}
            className={clsx(
              'w-11 h-11 shrink-0 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all',
              focused === closeIdx && 'gamepad-focus',
            )}
          >
            <X size={22} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-7 space-y-2.5">
          {servers.length === 0 && step === 'nas' && (
            <div className="py-8 text-center text-base text-text-secondary">
              {t('add.noServers')}
            </div>
          )}

          {step === 'nas' && servers.map((s, i) => (
            <button
              key={s.id}
              data-add-row={i}
              onClick={() => void pickServer(s.id)}
              className={clsx('add-pick-row', focused === i && 'gamepad-focus')}
            >
              <Server size={20} className="text-[#00d4ff]" />
              <span className="flex-1 text-left text-base">{s.name}</span>
              <span className="text-sm text-text-tertiary">{s.host}:{s.port}</span>
            </button>
          ))}

          {step === 'share' && shares.map((s, i) => (
            <button
              key={s.name}
              data-add-row={i}
              onClick={() => void pickShare(s.name)}
              className={clsx('add-pick-row', focused === i && 'gamepad-focus')}
            >
              <Folder size={20} className="text-[#a855f7]" />
              <span className="flex-1 text-left text-base">{s.name}</span>
            </button>
          ))}

          {step === 'folder' && (
            entries.length === 0 ? (
              <div className="py-8 text-center text-base text-text-secondary">{t('add.noFolders')}</div>
            ) : (
              entries.map((e, i) => (
                <button
                  key={e.name}
                  data-add-row={i}
                  onClick={() => void addFolder(e.name)}
                  disabled={busy}
                  className={clsx('add-pick-row', focused === i && 'gamepad-focus')}
                >
                  <Folder size={20} className="text-[#a855f7]" />
                  <span className="flex-1 text-left text-base truncate">{e.name}</span>
                  <Plus size={18} className="text-text-tertiary shrink-0" />
                </button>
              ))
            )
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        {/* 进度条：扫描入库期间盖在底部，明确告诉用户在忙什么（电视上没有鼠标指针转圈） */}
        {progress && (
          <div className="px-7 py-5 border-t border-border-glass flex items-center gap-3 shrink-0">
            <Loader2 size={18} className="animate-spin text-[#00d4ff] shrink-0" />
            <span className="text-base truncate">{t('add.scanningFolder', { title: progress.title })}</span>
          </div>
        )}
      </div>
    </div>
  );
}
