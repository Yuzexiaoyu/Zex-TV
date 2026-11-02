// 影视库视图（电视版）。
// 砍掉桌面版的：拖拽排序、右键菜单、磁盘管理、搜索框（电视输入法体验差）、
// hover 切换（电视焦点即预览——焦点落在哪张海报，Hero 就显示哪部）。
// 保留：Hero（跟随焦点）+ 工具栏（添加/筛选/排序，全 chips）+ 海报墙 + 详情入口 + TMDB 进度。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import {
  Film, Play, Plus, Star, Loader2, CheckCheck, Tv,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../store';
import SeriesDetail from './SeriesDetail';
import AddSeriesModal from '../components/AddSeriesModal';
import * as api from '../api';
import TmdbPickerModal from '../components/TmdbPickerModal';
import type { SeriesCard, TmdbSearchResult } from '../types';
import { coverSrc, yearOf } from '../utils/media';
import { reveal } from '../utils/dom';
import { warmBackdrop, warmStill } from '../utils/backdrop';
import { useFocusStore, useGamepadGroup, useGamepadFocus, useFocusIndex } from '../gamepad';
import { useT } from '../i18n';

type FilterKey = 'all' | 'unfinished' | 'finished' | 'favorite';
type SortKey = 'recent' | 'title' | 'rating';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'common.all' },
  { key: 'unfinished', label: 'series.unfinished' },
  { key: 'finished', label: 'series.finished' },
  { key: 'favorite', label: 'series.favorite' },
];

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'recent', label: 'series.sortRecent' },
  { key: 'title', label: 'series.sortTitle' },
  { key: 'rating', label: 'series.sortRating' },
];

const RING_LEN = 2 * Math.PI * 12;

/** 海报卡。memo：遥控器每移一格只有失焦/得焦的两张重渲染（v2 整面海报墙全量重渲染） */
const PosterCard = memo(function PosterCard({ s, index, focused, onOpen, onPreload }: {
  s: SeriesCard;
  index: number;
  focused: boolean;
  onOpen: (id: string) => void;
  onPreload: (id: string) => void;
}) {
  const t = useT();
  const pct = s.episode_count > 0 ? (s.watched_count / s.episode_count) * 100 : 0;
  const done = s.episode_count > 0 && s.watched_count >= s.episode_count;
  return (
    <div data-shelf-item={index} className={clsx('poster-card', focused && 'gamepad-focus')} onClick={() => onOpen(s.id)} onPointerEnter={() => onPreload(s.id)}>
      <div className="poster-frame">
        {s.poster_path ? (
          <img src={coverSrc(s.poster_path, s.updated_at)} alt={s.title} loading="lazy" decoding="async" className="poster-img" draggable={false} />
        ) : (
          <div className="poster-img flex items-center justify-center bg-gradient-to-br from-[#2a1a4e] to-[#0d0d2b]">
            <Film size={42} className="text-text-tertiary" />
          </div>
        )}
        <div className="poster-badges">
          {done && <span className="poster-done"><CheckCheck size={13} />{t('series.finished')}</span>}
        </div>
        {!done && s.media_type === 'tv' && pct > 0 && (
          <span className="poster-ring">
            <svg viewBox="0 0 30 30">
              <circle className="poster-ring-track" cx="15" cy="15" r="12" />
              <circle
                className="poster-ring-fill"
                cx="15" cy="15" r="12"
                strokeDasharray={RING_LEN}
                strokeDashoffset={RING_LEN * (1 - pct / 100)}
              />
            </svg>
            <span className="poster-ring-text"><b>{Math.round(pct)}</b><i>%</i></span>
          </span>
        )}
        <div className="poster-caption">
          <p className="poster-name">{s.title}</p>
          <p className="poster-sub">
            {(s.media_type === 'movie'
              ? [yearOf(s.first_air_date), t('series.movie')]
              : [yearOf(s.first_air_date), s.season_count > 0 ? t('series.seasonCount', { n: s.season_count }) : '', s.episode_count > 0 ? t('series.episodeCount', { n: s.episode_count }) : '']
            ).filter(Boolean).join(' · ') || t('series.noInfo')}
          </p>
        </div>
      </div>
    </div>
  );
});

export default function SeriesView() {
  const t = useT();
  const series = useAppStore((s) => s.series);
  const loadSeries = useAppStore((s) => s.loadSeries);
  // 空库态：海报网格没有可聚焦项，方向键会「合法地无操作」——
  // 空库时网格组退化为 1 项（「添加影视」按钮），保证遥控器始终有得选
  const isEmpty = series.length === 0;

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailReady, setDetailReady] = useState(false);
  const openDetail = useCallback((id: string) => {
    setDetailReady(false);
    setDetailId(id);
  }, []);
  const closeDetail = useCallback(() => { setDetailId(null); setDetailReady(false); }, []);
  const reloadSeries = useCallback(() => { void loadSeries(); }, [loadSeries]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('recent');

  const fetchingTitle = useAppStore((s) => s.metadataFetchingTitle);
  const fetchPct = useAppStore((s) => s.fetchPct);
  const setFetchingTitle = useAppStore((s) => s.setMetadataFetching);
  const setFetchPct = useAppStore((s) => s.setFetchPct);
  const setStageBackdrop = useAppStore((s) => s.setStageBackdrop);
  const setSeriesDetailOpen = useAppStore((s) => s.setSeriesDetailOpen);
  const [picker, setPicker] = useState<{ s: SeriesCard; results: TmdbSearchResult[] } | null>(null);
  // 刮削已耗秒数：进度长时间停在低位时，给「网络慢/查代理」提示，避免用户以为卡死
  const [fetchElapsed, setFetchElapsed] = useState(0);

  // 焦点所在海报 id（焦点即预览，取代桌面版的 hover）
  const [focusPosterId, setFocusPosterId] = useState<string | null>(null);

  const shelfRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadSeries(); }, [loadSeries]);

  useEffect(() => {
    if (!fetchingTitle) return;
    let un: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const stop = await listen<{ done: number; total: number }>('series-cover-progress', (e) => {
        if (!cancelled) setFetchPct(Math.min(100, (e.payload.done / Math.max(1, e.payload.total)) * 100));
      });
      if (cancelled) stop(); else un = stop;
    })();
    return () => { cancelled = true; un?.(); };
  }, [fetchingTitle]);

  // 刮削计时：fetchingTitle 有值时每秒 +1，用于「较慢」提示；结束即归零
  useEffect(() => {
    if (!fetchingTitle) { setFetchElapsed(0); return; }
    setFetchElapsed(0);
    const started = Date.now();
    const id = window.setInterval(() => setFetchElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [fetchingTitle]);

  // ─── 列表：筛选 + 排序 ───────────────────
  const visible = useMemo(() => {
    const matched = series.filter((s) => {
      if (filter === 'favorite') return s.favorite;
      if (filter === 'unfinished') return s.episode_count === 0 || s.watched_count < s.episode_count;
      if (filter === 'finished') return s.episode_count > 0 && s.watched_count >= s.episode_count;
      return true;
    });
    const byText = (a: string, b: string) => a.localeCompare(b, 'zh-Hans-CN');
    return [...matched].sort((a, b) => {
      switch (sort) {
        case 'title': return byText(a.title, b.title);
        case 'rating': return (b.vote_average || 0) - (a.vote_average || 0);
        default: {
          if (a.last_watched_at && b.last_watched_at) return byText(b.last_watched_at, a.last_watched_at);
          if (a.last_watched_at) return -1;
          if (b.last_watched_at) return 1;
          return byText(a.title, b.title);
        }
      }
    });
  }, [series, filter, sort]);

  // ─── Hero：跟随焦点海报，无焦点时回落默认 ──
  const defaultHero = useMemo(() => {
    if (series.length === 0) return null;
    const watching = series
      .filter((s) => s.last_watched_at && s.next_episode)
      .sort((a, b) => (b.last_watched_at || '').localeCompare(a.last_watched_at || ''));
    if (watching.length > 0) return watching[0];
    const withArt = series.filter((s) => s.bg_path || s.poster_path);
    const pool = withArt.length > 0 ? withArt : series;
    return [...pool].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] ?? null;
  }, [series]);

  const hero = useMemo(
    () => (focusPosterId ? series.find((s) => s.id === focusPosterId) ?? defaultHero : defaultHero),
    [focusPosterId, series, defaultHero],
  );

  // ─── 焦点组 ───────────────────────────────
  const posterFocused = useFocusIndex('grid:series');
  const heroPlayFocused = useGamepadFocus('hero', 0);
  const heroDetailFocused = useGamepadFocus('hero', 1);
  const toolbarFocused = useFocusIndex('series-toolbar');
  // 空库时唯一可聚焦项 = 「添加影视」按钮
  const addFocused = useGamepadFocus('grid:series', 0);

  // 焦点海报变化 → 立即更新 hero（无防抖，用户要求）。解码延迟由邻位预取
  // （下个 effect）抵消：大图在焦点移动的同时就开始解码，横幅淡入时图已就绪
  useEffect(() => {
    if (posterFocused < 0 || posterFocused >= visible.length) return;
    setFocusPosterId(visible[posterFocused].id);
  }, [posterFocused, visible]);

  const preloadDetail = useCallback((id: string) => {
    const store = useAppStore.getState();
    const card = store.detailCache[id] ?? store.series.find((s) => s.id === id);
    const path = card?.bg_path || card?.poster_path;
    if (card && path) warmBackdrop(coverSrc(path, card.updated_at));
    void store.fetchDetail(id).then((detail) => {
      const bg = detail.bg_path || detail.poster_path;
      if (bg) warmBackdrop(coverSrc(bg, detail.updated_at));
      // 预热「入口集」剧照：详情默认落点那一集的剧照提前解码，进去预览面板即时有图
      // （否则剧照是详情挂载后才开始拉的，刚进去那一下是空的）。入口 = 首个有未看集的
      // 季里的第一个未看集，与详情 activeSeason/entryIndex 的默认落点一致。
      const season = detail.seasons.find((s) => s.episodes.some((e) => !e.watched)) ?? detail.seasons[0];
      const eps = season?.episodes ?? [];
      const entry = eps.find((e) => !e.watched) ?? eps[0];
      if (entry?.still_path) warmStill(coverSrc(entry.still_path, detail.updated_at));
    }).catch(() => {});
  }, []);

  // 遥控器焦点与默认 Hero 都提前准备数据和背景；鼠标悬停走同一入口。
  useEffect(() => {
    if (hero) preloadDetail(hero.id);
  }, [hero, preloadDetail]);

  // 详情页打开/关闭 → 通知 App 隐藏/恢复顶部导航（详情全屏沉浸盖住导航）
  useEffect(() => {
    setSeriesDetailOpen(detailId != null);
  }, [detailId, setSeriesDetailOpen]);

  // 共享背景层的图源：开着详情时取该剧（与打开瞬间的 Hero 同一张），否则取 Hero。
  // 两者在进详情的那一刻必然相等 → 背景不切换，只是从 Hero 条带展开到整画布。
  useEffect(() => {
    const card = detailId ? (series.find((s) => s.id === detailId) ?? hero) : hero;
    const path = card?.bg_path || card?.poster_path || '';
    setStageBackdrop({
      src: path ? coverSrc(path, card!.updated_at) : '',
      poster: !!card && !card.bg_path && !!card.poster_path,
    });
  }, [detailId, hero, series, setStageBackdrop]);

  useEffect(() => {
    if (isEmpty || posterFocused < 0) return;
    const id = window.setTimeout(() => {
      const s = visible[posterFocused + 1];
      const path = s?.bg_path || s?.poster_path;
      if (s && path) warmBackdrop(coverSrc(path, s.updated_at));
    }, 150);
    return () => window.clearTimeout(id);
  }, [posterFocused, visible, isEmpty]);

  // 切筛选后列表变短，栈里的焦点索引可能越界（如「全部」第 20 张 → 切「收藏」只剩 3 张，
  // 焦点停在 19：无高亮、hero 不跟随、按键像失灵）。项数变化时把越界焦点收到最后一项
  useEffect(() => {
    if (isEmpty) return;
    const s = useFocusStore.getState();
    const top = s.stack[s.stack.length - 1];
    if (top?.group !== 'grid:series') return;
    if (top.index != null && top.index >= visible.length) {
      s.switchTo('grid:series', Math.max(0, visible.length - 1));
    }
  }, [visible.length, isEmpty]);

  // 工具栏项数：[添加, 筛选×4, 排序×4]
  const toolbarCount = 1 + FILTERS.length + SORTS.length;
  const sortStart = 1 + FILTERS.length;

  useGamepadGroup('grid:series', {
    count: isEmpty ? 1 : visible.length, // 空库时 1 = 添加按钮
    cols: isEmpty ? 1 : visible.length, // 单行横排：一行就是全部，左右在行内移动
    wrap: !isEmpty, // 海报行环形：末张按右到首张、首张按左到末张（空库态不绕）
    activate: (i) => {
      if (isEmpty) { setShowAddModal(true); return; }
      const s = visible[i]; if (s) openDetail(s.id);
    },
    scrollIntoView: (i) => reveal(shelfRef.current, `[data-shelf-item="${i}"]`, 'x'),
    leave: (dir, index) => {
      if (isEmpty) {
        // 影视库在顶部导航的序号是 0（焦点落 nav 哪项页面就切到哪项）
        if (dir === 'up') useFocusStore.getState().switchTo('nav', 0);
        return;
      }
      if (dir === 'up') {
        useFocusStore.getState().switchTo('series-toolbar', Math.min(index, toolbarCount - 1));
      }
    },
  });

  useGamepadGroup('series-toolbar', {
    count: toolbarCount,
    cols: toolbarCount,
    activate: (i) => {
      if (i === 0) setShowAddModal(true);
      else if (i < sortStart) setFilter(FILTERS[i - 1].key);
      else setSort(SORTS[i - sortStart].key);
    },
    leave: (dir) => {
      // 无 hero（筛选后一部都不剩）时不能往 hero 跳——那组 count=0 会变成死组，
      // 直接回顶部导航（影视库序号 0）
      if (dir === 'up') useFocusStore.getState().switchTo(hero ? 'hero' : 'nav', 0);
      if (dir === 'down') useFocusStore.getState().switchTo('grid:series');
    },
  });

  useGamepadGroup('hero', {
    count: hero ? 2 : 0,
    cols: 2,
    activate: (i) => {
      if (!hero) return;
      if (i === 0) void playNext(hero);
      else openDetail(hero.id);
    },
    leave: (dir) => {
      // 「上」必须能回顶部导航——hero 是本页最上层，之前只处理 down，
      // 焦点停在 hero 按「上」无声无息，出不去这一页
      if (dir === 'up') useFocusStore.getState().switchTo('nav', 0);
      if (dir === 'down') useFocusStore.getState().switchTo('series-toolbar');
    },
  });

  // ─── 操作 ──────────────────────────────────
  const playNext = async (s: SeriesCard) => {
    const ep = s.next_episode;
    if (!ep) { openDetail(s.id); return; }
    if (!ep.local_path) {
      void message(t('series.epNoFile'), { title: t('series.cannotPlay'), kind: 'warning' });
      return;
    }
    try {
      await api.playEpisode(ep.id);
      void loadSeries();
    } catch (err) {
      void message(t('series.playFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  const runFetch = async (s: SeriesCard, tmdbId?: number) => {
    if (useAppStore.getState().metadataFetchingTitle) return;
    setFetchingTitle(s.title);
    setFetchPct(0);
    try {
      await api.autoFetchSeriesMetadata(s.id, tmdbId);
      await loadSeries();
      useAppStore.getState().bumpData(); // 详情页开着时就地刷新元数据
    } catch (err) {
      void message(t('series.fetchFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    } finally {
      setFetchingTitle(null);
      setFetchPct(0);
    }
  };

  const handleAutoFetch = async (s: SeriesCard) => {
    if (useAppStore.getState().metadataFetchingTitle) return;
    try {
      const results = await api.searchTmdb(s.title, s.media_type);
      if (results.length === 0) {
        void message(t('series.tmdbNotFound', { title: s.title }), { title: t('series.tmdbNotFoundTitle'), kind: 'warning' });
        return;
      }
      if (results.length === 1) { void runFetch(s, results[0].id); return; }
      setPicker({ s, results });
    } catch (err) {
      void message(t('series.searchFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  return (
    <>
      {detailId && (
        <SeriesDetail
          key={detailId}
          seriesId={detailId}
          onReadyChange={setDetailReady}
          initial={series.find((x) => x.id === detailId)}
          onClose={closeDetail}
          onChanged={reloadSeries}
          onAutoFetch={handleAutoFetch}
          onDelete={async (s) => {
            try { await api.deleteSeries(s.id); setDetailId(null); await loadSeries(); }
            catch (err) { void message(t('series.deleteFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' }); }
          }}
        />
      )}
      {/* 单屏三段式：hero / 工具栏 / 海报行全部强制在一屏内，整页不滚动。
          详情页盖在上面时整体只隐藏不卸载：返回时海报行横向滚动位置与焦点原样，
          不必重建上百张海报（重新解码 + 入场动画） */}
      <div className={clsx('h-full flex flex-col overflow-hidden', detailId && detailReady && 'invisible')}>
      {series.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center gap-6">
          <div className="empty-orb"><Tv size={42} /></div>
          <div className="text-center">
            <p className="text-2xl font-bold mb-2">{t('series.emptyTitle')}</p>
            <p className="text-base text-text-tertiary">{t('series.emptyDesc')}</p>
          </div>
          <button
            className={clsx('btn btn-accent gap-2 px-8 py-4 text-lg', addFocused && 'gamepad-focus')}
            onClick={() => setShowAddModal(true)}
          >
            <Plus size={20} />
            {t('series.addSeries')}
          </button>
        </div>
      ) : (
        <>
          {hero && (
            <section className="hero">
              <div className="hero-shade" />
              <div className="hero-content">
                <h1 className="hero-title">{hero.title}</h1>
                <div className="hero-meta">
                  {hero.vote_average > 0 && (
                    <span className="rating-badge">
                      <Star size={14} fill="currentColor" />
                      {hero.vote_average.toFixed(1)}
                    </span>
                  )}
                  {(hero.media_type === 'movie'
                    ? [t('series.movie'), yearOf(hero.first_air_date), hero.status, hero.genres,
                       hero.watched_count > 0 ? t('series.watched') : '']
                    : [yearOf(hero.first_air_date), hero.status, hero.genres,
                       hero.season_count > 0 ? t('series.seasonCount', { n: hero.season_count }) : '',
                       hero.episode_count > 0 ? t('series.watchedCount', { watched: hero.watched_count, total: hero.episode_count }) : '']
                  ).filter(Boolean).map((bit, i) => (
                    <span key={i} className="hero-meta-item">{bit}</span>
                  ))}
                </div>
                {hero.overview && <p className="hero-overview">{hero.overview}</p>}
                <div className="mt-6 flex items-center gap-4">
                  <button className={clsx('btn btn-accent px-7 py-3.5 text-base', heroPlayFocused && 'gamepad-focus')} onClick={() => void playNext(hero)}>
                    <Play size={18} fill="currentColor" />
                    {hero.media_type === 'movie' ? (
                      hero.next_episode ? t('series.playMovie') : t('series.viewDetail')
                    ) : hero.next_episode ? (
                      <>
                        {hero.watched_count > 0 ? t('series.continueWatching') : t('series.startWatching')}
                        <span className="opacity-70 tabular-nums">
                          S{String(hero.next_episode.season_number).padStart(2, '0')}
                          E{String(hero.next_episode.episode_number).padStart(2, '0')}
                        </span>
                      </>
                    ) : t('series.viewDetail')}
                  </button>
                  <button className={clsx('btn btn-glass px-6 py-3.5 text-base', heroDetailFocused && 'gamepad-focus')} onClick={() => openDetail(hero.id)} onPointerEnter={() => preloadDetail(hero.id)}>
                    <Film size={16} />
                    {t('series.episodeDetails')}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* 工具栏：添加 / 筛选 / 排序（单屏布局固定可见，不再吸顶） */}
          <div className="series-toolbar shrink-0 px-8 py-3 flex items-center gap-3">
            <button className={clsx('btn btn-accent gap-2 text-base', toolbarFocused === 0 && 'gamepad-focus')} onClick={() => setShowAddModal(true)}>
              <Plus size={17} />
              {t('series.addSeries')}
            </button>

            <div className="flex items-center gap-2">
              {FILTERS.map((f, i) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={clsx('chip', filter === f.key && 'active', toolbarFocused === i + 1 && 'gamepad-focus')}
                >
                  {t(f.label)}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {SORTS.map((s, i) => (
                <button
                  key={s.key}
                  onClick={() => setSort(s.key)}
                  className={clsx('chip', sort === s.key && 'active', toolbarFocused === sortStart + i && 'gamepad-focus')}
                >
                  {t(s.label)}
                </button>
              ))}
            </div>
          </div>

          {/* 海报行：无论多少部都排成一行，行内横向滚动（页面不动） */}
          <div ref={shelfRef} className="poster-shelf">
            {visible.length === 0 ? (
              <div className="shelf-empty">
                <Film size={34} className="text-text-tertiary" />
                <p className="text-base text-text-secondary">{t('series.noMatch')}</p>
              </div>
            ) : (
              visible.map((s, idx) => (
                <PosterCard key={s.id} s={s} index={idx} focused={idx === posterFocused} onOpen={openDetail} onPreload={preloadDetail} />
              ))
            )}
          </div>
        </>
      )}
      </div>

      {picker && (
        <TmdbPickerModal
          title={picker.s.title}
          results={picker.results}
          currentId={picker.s.tmdb_id}
          onPick={(id) => { const target = picker.s; setPicker(null); void runFetch(target, id); }}
          onClose={() => setPicker(null)}
        />
      )}

      {showAddModal && (
        <AddSeriesModal onClose={() => setShowAddModal(false)} onSuccess={() => { void loadSeries(); }} />
      )}

      {fetchingTitle && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[120] glass-card px-6 py-5 min-w-[360px] flex flex-col gap-3 animate-fade-up">
          <div className="flex items-center gap-3 text-base">
            <Loader2 size={17} className="animate-spin text-[#00d4ff]" />
            <span className="truncate">{t('series.fetchingMeta', { title: fetchingTitle })}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 rounded-full bg-bg-surface-active overflow-hidden">
              <div className="h-full rounded-full bg-[#00d4ff] transition-[width] duration-300" style={{ width: `${fetchPct}%` }} />
            </div>
            <span className="text-sm text-text-secondary w-10 text-right tabular-nums">{Math.round(fetchPct)}%</span>
          </div>
          {fetchElapsed >= 15 && (
            <p className="text-xs text-text-tertiary">
              {fetchElapsed >= 40 ? t('series.fetchVerySlow') : t('series.fetchSlow')}
            </p>
          )}
        </div>
      )}
    </>
  );
}
