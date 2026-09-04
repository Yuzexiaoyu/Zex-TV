// TMDB 同名作品消歧弹窗（电视版，照搬桌面版，仅微调字号）。

import { Check, Film, Star, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { TmdbSearchResult } from '../types';
import { useFocusIndex, useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  title: string;
  results: TmdbSearchResult[];
  currentId?: number;
  onPick: (id: number) => void;
  onClose: () => void;
}

export default function TmdbPickerModal({ title, results, currentId, onPick, onClose }: Props) {
  const t = useT();
  const focused = useFocusIndex('modal:tmdb-picker');
  useModalGamepad('modal:tmdb-picker', {
    onClose,
    count: results.length + 1, // +1 = 叉按钮
    cols: 1,
    scrollIntoView: (i) => document.querySelector(`[data-tmdb-opt="${i}"]`)?.scrollIntoView({ block: 'nearest' }),
    activate: (i) => {
      if (i === results.length) { onClose(); return; } // 叉
      onPick(results[i].id);
    },
  });

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-8" onClick={onClose}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-md animate-fade-in" />

      <div
        className="relative w-full max-w-4xl max-h-full flex flex-col glass-modal shadow-2xl animate-scale-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-7 py-6 border-b border-border-glass shrink-0">
          <div>
            <h2 className="text-xl font-bold">{t('misc.tmdbPickTitle')}</h2>
            <p className="mt-1.5 text-sm text-text-secondary">
              {t('misc.tmdbPickDesc', { title, n: results.length })}
            </p>
          </div>
          <button
            onClick={onClose}
            className={clsx(
              'w-11 h-11 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all',
              focused === results.length && 'gamepad-focus',
            )}
            title={t('common.cancel')}
          >
            <X size={22} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
          {results.map((r, i) => {
            const isCurrent = currentId !== undefined && currentId > 0 && currentId === r.id;
            return (
              <button
                key={r.id}
                data-tmdb-opt={i}
                onClick={() => onPick(r.id)}
                className={clsx('tmdb-option', isCurrent && 'current', focused === i && 'gamepad-focus')}
              >
                {r.poster_url ? (
                  <img src={r.poster_url} alt="" className="tmdb-option-poster" loading="lazy" />
                ) : (
                  <div className="tmdb-option-poster flex items-center justify-center bg-gradient-to-br from-[#2a1a4e] to-[#0d0d2b] tmdb-option-poster-fallback">
                    <Film size={24} className="text-text-tertiary" />
                  </div>
                )}

                <div className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-semibold text-text-primary">{r.name || r.original_name}</span>
                    {r.date && <span className="text-sm text-text-tertiary tabular-nums">{r.date.slice(0, 4)}</span>}
                    {r.vote_average > 0 && (
                      <span className="flex items-center gap-1 text-sm text-yellow-400/90">
                        <Star size={12} fill="currentColor" />
                        {r.vote_average.toFixed(1)}
                      </span>
                    )}
                  </div>
                  {r.original_name && r.original_name !== r.name && (
                    <p className="mt-0.5 text-sm text-text-tertiary truncate">{r.original_name}</p>
                  )}
                  <p className="mt-1.5 text-sm leading-relaxed text-text-secondary line-clamp-2">
                    {r.overview || t('misc.tmdbNoOverview')}
                  </p>
                </div>

                <span className="tmdb-option-pick"><Check size={18} /></span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
