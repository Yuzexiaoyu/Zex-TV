// 播放回执弹窗：系统播放器退出后弹「看完了吗」确认框。
// 电视系统播放器进度不可回传，返回 App 后由用户手动标记。
// 选「看完了」→ markEpisodeWatched(true) + 刷新；「没看完」→ 不标记（保留观看进度）。
// 焦点默认落在「看完了」（电视用户多数情况是看完返回）。

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { clsx } from 'clsx';
import * as api from '../api';
import { useFocusIndex, useModalGamepad } from '../gamepad';
import { useT } from '../i18n';
import { useAppStore } from '../store';

interface Props {
  episodeId: string;
  onClose: () => void;
}

export default function WatchedPromptModal({ episodeId, onClose }: Props) {
  const t = useT();
  const loadSeries = useAppStore((s) => s.loadSeries);
  const loadStats = useAppStore((s) => s.loadStats);
  const [busy, setBusy] = useState(false);

  // 焦点默认在「看完了」（index 1），电视用户看完返回占多数
  useModalGamepad('modal:watched-prompt', {
    onClose,
    count: 2,
    cols: 2,
    initialIndex: 1,
    activate: (i) => void handlePick(i === 1),
    // 两键单行网格，上下越界时给个轻反馈（否则按键全哑，像卡死）。
    // 弹窗没有更上/下层，方向键就地抖一下就够——挪动焦点位次即可
    leave: () => { /* 单行两键：上下无去处，静默吸收（有 Back 关闭路径） */ },
  });
  const focused = useFocusIndex('modal:watched-prompt');

  const handlePick = async (watched: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (watched) {
        await api.markEpisodeWatched(episodeId, true);
        useAppStore.getState().bumpData();
        await Promise.allSettled([loadSeries(), loadStats()]);
      }
    } catch {
      /* 静默：标记失败不影响关闭 */
    } finally {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-8">
      <div className="absolute inset-0 bg-black/75 animate-fade-in" />
      <div className="relative glass-modal shadow-2xl animate-scale-in px-10 py-8 flex flex-col items-center gap-6">
        <div className="empty-orb mx-auto" style={{ width: 72, height: 72 }}>
          <Check size={36} />
        </div>
        <h2 className="text-2xl font-bold">{t('play.watchedPrompt')}</h2>
        <div className="flex items-center gap-4">
          <button
            onClick={() => void handlePick(false)}
            className={clsx('btn btn-glass px-8 py-4 text-lg', focused === 0 && 'gamepad-focus')}
          >
            <X size={20} />
            {t('play.watchedNo')}
          </button>
          <button
            onClick={() => void handlePick(true)}
            className={clsx('btn btn-accent px-8 py-4 text-lg', focused === 1 && 'gamepad-focus')}
          >
            <Check size={20} />
            {t('play.watchedYes')}
          </button>
        </div>
      </div>
    </div>
  );
}
