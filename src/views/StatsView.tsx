// 统计页（电视版）：只有影视一列。砍掉桌面版的多列/隐藏库/右键调整时长。
// 焦点组 'stats:col:video'，上下在列内移动，「上」越顶回顶部导航。

import { useEffect, useState } from 'react';
import { BarChart3, Film } from 'lucide-react';import { useAppStore } from '../store';
import { useFocusIndex, useFocusStore, useGamepadGroup } from '../gamepad';
import { RowCard, VIDEO_COLOR, longDur } from '../components/StatsCovers';
import { useT } from '../i18n';

const GROUP = 'stats:col:video';
// 统计页在顶部导航的序号（「上」越顶回导航要落回本页那一项——
// 焦点落 nav 哪项页面就切到哪项，落 0 会把页面带回影视库）
const NAV_IDX = 1;

// 焦点组必须在视图顶层注册：空态/加载态没有 ColSection，组若跟着消失，
// 方向键就落在已注销的组上——count=0 且无 leave，遥控器像死机。
// 只在 StatsView 主体注册一处（count 由数据实时反算），ColSection 不再重复注册：
// 同名组两处注册会互相覆盖，且父组件 effect 后跑，会用 count=0 盖掉真实列表。

function ColSection() {
  const t = useT();
  const stats = useAppStore((s) => s.stats);
  const focusedIndex = useFocusIndex(GROUP);

  const d = stats?.video;
  const top = d?.top ?? [];

  // 焦点组只在 StatsView 顶层注册一处（见下）：两处注册同名组会互相覆盖，而且
  // 父组件 effect 比子组件后跑 → 顶层那次（count 0）会把这里 count=top.length 盖掉，
  // 结果列表「往下只能停在第一项」。这里只读焦点高亮，不再重复注册。

  if (!stats || !d) return null;

  return (
    <section className="stats-col" style={{ ['--cc' as string]: VIDEO_COLOR }}>
      <div className="stats-col-head">
        <h2><Film size={18} />{t('stats.video')}</h2>
        <span className="stats-col-total">{longDur(d.total_seconds)}</span>
      </div>

      <div className="stats-col-sub">
        <span>{d.played_count}/{d.library_count} {t('stats.unitVideo')}</span>
        <span>{t('stats.watchedEpisodes', { watched: stats.total_watched_episodes, total: stats.total_episodes })}</span>
      </div>

      {top.length > 0 ? (
        <div className="stats-col-rows">
          {top.map((e, i) => (
            <RowCard
              key={e.id}
              entry={e}
              color={VIDEO_COLOR}
              rank={i + 1}
              focused={focusedIndex === i}
              anchor={`video-${i}`}
            />
          ))}
        </div>
      ) : (
        <div className="stats-col-empty">{t('stats.noRecords')}</div>
      )}
    </section>
  );
}

export default function StatsView() {
  const t = useT();
  const stats = useAppStore((s) => s.stats);
  const loadStats = useAppStore((s) => s.loadStats);
  const [error, setError] = useState<string | null>(null);

  // 焦点组唯一注册处：StatsView 常驻（空态/加载/出错也在），count 由数据实时反算，
  // ColSection 不再重复注册（否则同名组互相覆盖，列表往下停不动）。
  const top = stats?.video?.top ?? [];
  useGamepadGroup(GROUP, {
    count: top.length,
    cols: 1,
    scrollIntoView: (i) => {
      document.querySelector(`[data-stat-cover="video-${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    },
    activate: () => {},
    leave: (dir) => {
      if (dir === 'up') useFocusStore.getState().switchTo('nav', NAV_IDX);
    },
  });

  // 数据刷新后排行变短时，栈里的焦点索引可能越界（无高亮、按键像失灵）
  useEffect(() => {
    const s = useFocusStore.getState();
    const cur = s.stack[s.stack.length - 1];
    if (cur?.group !== GROUP) return;
    if (cur.index != null && cur.index >= top.length) {
      s.switchTo(GROUP, Math.max(0, top.length - 1));
    }
  }, [top.length]);

  useEffect(() => {
    setError(null);
    loadStats().catch((e) => setError(typeof e === 'string' ? e : (e?.message ?? String(e))));
  }, [loadStats]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center px-8">
        <div className="text-center">
          <BarChart3 size={44} className="mx-auto mb-3 text-text-tertiary" />
          <p className="text-lg font-semibold mb-1">{t('stats.loadFailed')}</p>
          <p className="text-base text-text-secondary">{error}</p>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="stats-skeleton-pulse text-text-tertiary text-base">{t('stats.loading')}</div>
      </div>
    );
  }

  const hasData = stats.video.library_count > 0;

  if (!hasData) {
    return (
      <div className="h-full flex items-center justify-center px-8">
        <div className="text-center animate-fade-up">
          <div className="empty-orb mx-auto mb-6"><BarChart3 size={42} /></div>
          <h2 className="text-2xl font-bold mb-2">{t('stats.emptyTitle')}</h2>
          <p className="text-base text-text-secondary max-w-md mx-auto leading-relaxed">
            {t('stats.emptyDesc')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <div className="stats-page">
        <div className="stats-cols" style={{ ['--cols' as string]: 1 }}>
          <ColSection />
        </div>
      </div>
    </div>
  );
}
