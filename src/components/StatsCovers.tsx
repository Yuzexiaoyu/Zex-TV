// 统计页封面行（电视版裁剪：只留 video，去 game/music/右键）。

import { clsx } from 'clsx';
import { Film } from 'lucide-react';
import type { TopEntry } from '../types';
import { coverSrc } from '../utils/media';
import { t } from '../i18n';

// 电视版只有影视一类，配色固定紫
export const VIDEO_COLOR = '#a855f7';

// 秒 → "1021h48m" / "18m" / "42s"
export function shortDur(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// 秒 → "1021 小时 48 分" / "42 分钟"
export function longDur(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0
    ? t('common.duration.hoursMinutes', { h, m })
    : t('common.duration.hours', { n: h });
  if (m > 0) return t('common.duration.minutes', { n: m });
  return s > 0 ? t('common.duration.underMinute') : t('common.duration.zero');
}

export function RowCard({ entry, color, rank, focused, anchor }: {
  entry: TopEntry;
  color: string;
  rank: number;
  focused?: boolean;
  anchor?: string;
}) {
  const imgSrc = entry.wide_path || entry.cover_path;

  return (
    <div
      className={clsx('stats-row', focused && 'stats-row-focus')}
      style={{ ['--cc' as string]: color }}
      data-stat-cover={anchor}
    >
      <div className={clsx(
        'stats-row-cover',
        entry.wide_path ? 'stats-row-cover-wide' : 'stats-row-cover-portrait',
      )}>
        {imgSrc ? (
          <img className="stats-row-img" src={coverSrc(imgSrc)} alt="" loading="lazy" draggable={false} />
        ) : (
          <div className="stats-row-img stats-row-blank"><Film size={22} /></div>
        )}
        <span className="stats-row-rank" style={{ background: color }}>{rank}</span>
      </div>

      <div className="stats-row-body">
        <p className="stats-row-name" title={entry.name}>{entry.name}</p>
        {entry.sub && <p className="stats-row-sub" title={entry.sub}>{entry.sub}</p>}
      </div>

      <div className="stats-row-meta">
        <span className="stats-row-time" style={{ color }}>
          {entry.seconds <= 0 ? t('stats.notPlayed') : longDur(entry.seconds)}
        </span>
      </div>
    </div>
  );
}
