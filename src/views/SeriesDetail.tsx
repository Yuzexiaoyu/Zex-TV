// 影视详情页（电视版，v2 重构）。
//
// 结构：左右分栏（TV 标准），不再上下滚长页——
//   左栏（固定不动）  海报 + 标题/元信息/简介/进度 + 操作按钮（播放/收藏/元数据/删除）
//   右栏（内部滚动）  季列表（纵列，OK 进集列表） + 当前季的集列表
// 焦点纵向流动：左栏组 →「右」进右栏；季列表 ↔ 集列表上下两段（顶/末行越界互通）。
// 焦点横向换季：集列表里按左右 = 切季（原交互保留）。
// 返回 = 遥控器 Back（焦点栈弹层）。
//
// 性能（旧版卡顿的根因，全部针对修）：
//   - 整页不再滚动，只有右栏列表滚 → scroll-behavior:smooth 不再拖着整页跑
//   - 集行不再有 fade-up 入场动画（430 行动画同时排队 = 进页面即卡）
//   - transition 只挂焦点相关的具体属性，不用 all
//   - 标记一集只 setState 局部（patchEpisode 保持，但列表渲染经 React.memo
//     的行组件，未变的行不再 diff
//   - 一次只渲染一个季的集（旧版也是，保持），且季标签从 22 个横向 chip
//     改为纵向列表，不再换行堆叠

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import {
  Play, Star, Check, CheckCheck, RotateCcw, Loader2,
  Film, Sparkles, Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import * as api from '../api';
import type { Episode, Season, SeriesCard, SeriesDetailData } from '../types';
import { cleanEpisodeTitle, coverSrc, formatDuration, formatRuntime, watchPercent, yearOf } from '../utils/media';
import { useFocusStore, useGamepadGroup, useFocusIndex } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  seriesId: string;
  onClose: () => void;
  onChanged?: () => void;
  onAutoFetch?: (s: SeriesCard) => void;
  onDelete?: (s: SeriesCard) => void;
}

const DETAIL_GROUPS = ['detail-hero', 'detail-seasons', 'detail-episodes'] as const;

/** 集行。memo：焦点移动/标记一集时，其它行不重渲染（旧版每次全列表 diff，卡顿主因之一） */
const EpRow = memo(function EpRow({ ep, index, isMovie, seriesTitle, focused, onPlay }: {
  ep: Episode;
  index: number;
  isMovie: boolean;
  seriesTitle: string;
  focused: boolean;
  onPlay: (ep: Episode) => void;
}) {
  const t = useT();
  const pct = ep.watched ? 100 : watchPercent(ep.watched_ms, ep.runtime_minutes);
  return (
    <button
      data-ep-row={index}
      onClick={() => onPlay(ep)}
      className={clsx(
        'ep-row2',
        ep.watched && 'watched',
        !ep.watched && pct > 0 && 'watching',
        focused && 'gamepad-focus',
      )}
    >
      <span className="ep-row2-num">E{String(ep.episode_number).padStart(2, '0')}</span>
      <span className="ep-row2-body">
        <span className="ep-row2-title">
          {isMovie
            ? (cleanEpisodeTitle(ep.title, ep.episode_number).replace(/^第 \d+ 集$/, seriesTitle) || seriesTitle)
            : cleanEpisodeTitle(ep.title, ep.episode_number)}
          {ep.vote_average > 0 && (
            <span className="ep-row2-vote"><Star size={11} fill="currentColor" />{ep.vote_average.toFixed(1)}</span>
          )}
          {ep.watched && <Check size={13} className="ep-row2-done-icon" />}
        </span>
        <span className="ep-row2-meta">
          {ep.air_date && <span className="tabular-nums">{ep.air_date.slice(0, 10)}</span>}
          {ep.runtime_minutes > 0 && <span>{formatRuntime(ep.runtime_minutes)}</span>}
          <span className={clsx('truncate', !ep.local_path && 'text-[#f59e0b]/80')}>
            {ep.local_path ? ep.local_path.split(/[/\\]/).pop() : t('series.epNoLocalFile')}
          </span>
        </span>
      </span>
      <span className={clsx('ep-row2-badge', ep.watched ? 'done' : pct > 0 ? 'watching' : '')}>
        {ep.watched ? <Check size={12} strokeWidth={3} /> : pct > 0 ? `${Math.round(pct)}%` : <Play size={12} fill="currentColor" />}
      </span>
    </button>
  );
});

/** 季行 */
const SeasonRow = memo(function SeasonRow({ season, active, focused, onPick }: {
  season: Season & { episodes: Episode[] };
  active: boolean;
  focused: boolean;
  onPick: (id: string) => void;
}) {
  const t = useT();
  const watched = season.episodes.filter((e) => e.watched).length;
  const done = season.episodes.length > 0 && watched === season.episodes.length;
  return (
    <button
      data-season-row={season.id}
      onClick={() => onPick(season.id)}
      className={clsx('season-row2', active && 'active', focused && 'gamepad-focus')}
    >
      <span className="season-row2-num">{season.season_number}</span>
      <span className="season-row2-body">
        <span className={clsx('season-row2-name', done && 'done')}>
          {season.name?.trim() || t('series.seasonN', { n: season.season_number })}
        </span>
        <span className="season-row2-count tabular-nums">
          {watched}/{season.episodes.length}
        </span>
      </span>
      <span className="season-row2-bar">
        <span
          className="season-row2-bar-fill"
          style={{ width: `${season.episodes.length > 0 ? (watched / season.episodes.length) * 100 : 0}%` }}
        />
      </span>
    </button>
  );
});

export default function SeriesDetail({ seriesId, onClose, onChanged, onAutoFetch, onDelete }: Props) {
  const t = useT();
  const [data, setData] = useState<SeriesDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSeason, setActiveSeason] = useState('');
  const epListRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (keepSeason = true) => {
    const detail = await api.getSeriesDetail(seriesId);
    setData(detail);
    setActiveSeason((prev) => {
      if (keepSeason && prev && detail.seasons.some((s) => s.id === prev)) return prev;
      return detail.next_episode?.season_id || detail.seasons[0]?.id || '';
    });
    return detail;
  }, [seriesId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    load(false)
      .catch((err) => { void message(t('series.loadFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [load]);

  // 播放器退出后进度/已看变了，重拉详情。App 回前台（app-resumed）即刷新：
  // 系统播放器退出回到本页时观看状态/进度已经变了（「看完了吗」回执也会触发）
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const stop = await listen<void>('app-resumed', () => { void load(); });
      if (cancelled) stop(); else un = stop;
    })();
    return () => { cancelled = true; un?.(); };
  }, [load]);

  const season = useMemo(
    () => data?.seasons.find((s) => s.id === activeSeason) ?? data?.seasons[0],
    [data, activeSeason],
  );

  const progressPct = data && data.episode_count > 0
    ? (data.watched_count / data.episode_count) * 100
    : 0;

  const isMovie = data?.media_type === 'movie';
  const nextEp = data?.next_episode;
  const seasons = data?.seasons ?? [];
  const episodes = season?.episodes ?? [];

  // ─── 焦点组 ───────────────────────────────
  const heroFocused = useFocusIndex('detail-hero');
  const seasonsFocused = useFocusIndex('detail-seasons');
  const episodesFocused = useFocusIndex('detail-episodes');
  const [lastHeroRow, setLastHeroRow] = useState(0);
  const [lastSeasonRow, setLastSeasonRow] = useState(0);
  const [lastEpisodeRow, setLastEpisodeRow] = useState(0);

  useEffect(() => { if (heroFocused >= 0) setLastHeroRow(heroFocused); }, [heroFocused]);
  useEffect(() => { if (seasonsFocused >= 0) setLastSeasonRow(seasonsFocused); }, [seasonsFocused]);
  useEffect(() => { if (episodesFocused >= 0) setLastEpisodeRow(episodesFocused); }, [episodesFocused]);

  // 左栏：[播放/继续, 收藏, 元数据, 删除] 一列
  const heroCount = 4;
  useGamepadGroup('detail-hero', {
    count: heroCount,
    cols: 1,
    activate: (i) => {
      if (!data) return;
      if (i === 0) {
        if (nextEp) {
          const target = data.seasons.flatMap((s) => s.episodes).find((e) => e.id === nextEp.id);
          if (target) void playEpisode(target);
          return;
        }
        const movieFile = isMovie ? data.seasons[0]?.episodes[0] : undefined;
        if (movieFile) void playEpisode(movieFile);
        return;
      }
      if (i === 1) { void toggleFavorite(); return; }
      const card: SeriesCard = toCard(data);
      if (i === 2) onAutoFetch?.(card);
      else onDelete?.(card);
    },
    leave: (dir) => {
      // 上键只停在左侧操作区顶部，返回详情使用 Back/Escape。
      // 「右」进右栏：剧集 → 季列表；电影不渲染季面板 → 直达文件行
      if (dir === 'right') {
        if (!isMovie && seasons.length > 0) {
          useFocusStore.getState().switchTo('detail-seasons', Math.min(lastSeasonRow, seasons.length - 1));
        } else if (episodes.length > 0) {
          useFocusStore.getState().switchTo('detail-episodes', Math.min(lastEpisodeRow, episodes.length - 1));
        }
      }
    },
    exit: onClose,
  });

  // 季列表（纵向）。OK 只选择当前季；右键进入集列表，左键回左栏
  useGamepadGroup('detail-seasons', {
    count: seasons.length,
    cols: 1,
    activate: (i) => {
      const s = seasons[i];
      if (!s) return;
      if (s.id !== activeSeason) {
        setActiveSeason(s.id);
        useFocusStore.getState().switchTo('detail-episodes', 0);
      }
    },
    scrollIntoView: (i) => {
      document.querySelector(`[data-season-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    },
    leave: (dir) => {
      if (dir === 'left') useFocusStore.getState().switchTo('detail-hero', lastHeroRow);
      else if (dir === 'right' && episodes.length > 0) useFocusStore.getState().switchTo('detail-episodes', Math.min(lastEpisodeRow, episodes.length - 1));
      else if (dir === 'down' && episodes.length > 0) useFocusStore.getState().switchTo('detail-episodes', Math.min(lastEpisodeRow, episodes.length - 1));
    },
    exit: onClose,
  });

  // 集列表（纵向，OK = 播放）。左右 = 切季（文件头声明的原交互）；上到头回季列表。
  useGamepadGroup('detail-episodes', {
    count: episodes.length,
    cols: 1,
    activate: (i) => { const ep = episodes[i]; if (ep) void playEpisode(ep); },
    scrollIntoView: (i) => {
      const rows = epListRef.current?.querySelectorAll('[data-ep-row]');
      (rows?.[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    },
    leave: (dir) => {
      // 用解析后的当前季定位（activeSeason 无效时 memo 回退 seasons[0]）
      const curIdx = seasons.findIndex((s) => s.id === season?.id);
      if (dir === 'left') {
        // 上一季；第一季回季列表。电影不渲染季面板（后端仍建了 1 季），
        // seasons.length>0 会把焦点送进不可见组——电影直接回左栏
        if (curIdx > 0) {
          setActiveSeason(seasons[curIdx - 1].id);
          useFocusStore.getState().switchTo('detail-episodes', 0);
        } else if (!isMovie && seasons.length > 0) {
          useFocusStore.getState().switchTo('detail-seasons', Math.min(lastSeasonRow, seasons.length - 1));
        } else {
          useFocusStore.getState().switchTo('detail-hero', lastHeroRow);
        }
      } else if (dir === 'right') {
        // 下一季；最后一季停在原地
        if (curIdx >= 0 && curIdx < seasons.length - 1) {
          setActiveSeason(seasons[curIdx + 1].id);
          useFocusStore.getState().switchTo('detail-episodes', 0);
        }
      } else if (dir === 'up') {
        // 集列表顶行按上 → 季列表；电影没有季面板 → 回左栏（导航闭环）
        if (!isMovie && seasons.length > 0) useFocusStore.getState().switchTo('detail-seasons', Math.min(lastSeasonRow, seasons.length - 1));
        else useFocusStore.getState().switchTo('detail-hero', lastHeroRow);
      }
    },
    exit: onClose,
  });

  // 打开详情 → 焦点先落在左栏播放键（最常用的动作）
  useEffect(() => {
    useFocusStore.getState().push('detail-hero', 0);
    return () => {
      const s = useFocusStore.getState();
      const top = s.stack.length ? s.stack[s.stack.length - 1] : undefined;
      if ((DETAIL_GROUPS as readonly string[]).includes(top?.group ?? '')) s.back();
    };
  }, []);

  // 切季后集数变少时，栈里的焦点索引可能指向不存在的集（第 24 集的季 → 第 6 集的季，
  // 焦点停在 23：整屏无高亮）。集数变化时把越界焦点收到最后一集
  useEffect(() => {
    const s = useFocusStore.getState();
    const top = s.stack[s.stack.length - 1];
    if (top?.group !== 'detail-episodes') return;
    if (top.index != null && top.index >= episodes.length) {
      s.switchTo('detail-episodes', Math.max(0, episodes.length - 1));
    }
  }, [episodes.length]);

  const playEpisode = async (ep: Episode) => {
    if (!ep.local_path) {
      void message(t('series.epNoFileThis'), { title: t('series.cannotPlay'), kind: 'warning' });
      return;
    }
    try {
      await api.playEpisode(ep.id);
      onChanged?.();
    } catch (err) {
      void message(t('series.playFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  const setSeasonWatched = async (watched: boolean) => {
    if (!season) return;
    try {
      await api.markSeasonWatched(season.id, watched);
      await load();
      onChanged?.();
    } catch (err) {
      void message(t('series.opFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  const toggleFavorite = async () => {
    if (!data) return;
    const next = !data.favorite;
    setData({ ...data, favorite: next });
    try {
      await api.setSeriesFavorite(data.id, next);
      onChanged?.();
    } catch (err) {
      setData({ ...data, favorite: !next });
      void message(t('series.favoriteFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  if (loading || !data) {
    return (
      <div className="h-full flex items-center justify-center gap-3 text-text-secondary">
        <Loader2 size={20} className="animate-spin text-[#00d4ff]" />
        {t('series.loading')}
      </div>
    );
  }

  const backdrop = data.bg_path || data.poster_path;
  const year = yearOf(data.first_air_date);
  const movieFile = isMovie ? data.seasons[0]?.episodes[0] : undefined;
  const metaBits = (isMovie
    ? [t('series.movie'), year, data.status, data.genres, formatRuntime(movieFile?.runtime_minutes ?? 0)]
    : [year, data.status, data.genres,
       data.seasons.length > 0 ? t('series.seasonCount', { n: data.seasons.length }) : '',
       data.episode_count > 0 ? t('series.episodeCount', { n: data.episode_count }) : '']
  )
    .concat(data.total_seconds > 0 ? [t('series.watchedTotal', { time: formatDuration(data.total_seconds) })] : [])
    .filter(Boolean);

  // 播放键文案
  const playLabel = isMovie
    ? t('series.playMovie')
    : nextEp
      ? (data.watched_count > 0 ? t('series.continueWatching') : t('series.startWatching'))
      : (data.episode_count > 0 ? t('series.allWatched') : '');
  const playSub = !isMovie && nextEp
    ? `S${String(nextEp.season_number).padStart(2, '0')}E${String(nextEp.episode_number).padStart(2, '0')}`
    : '';

  return (
    <div className="detail2-root">
      {/* 背景图：fixed 覆盖整块画布（画布方案下 fixed 相对 #root），单张、无动画重复 */}
      {backdrop ? (
        <div className="detail2-backdrop">
          <img src={coverSrc(backdrop, data.updated_at)} alt="" />
          <div className="detail2-backdrop-fade" />
        </div>
      ) : (
        <div className="detail2-backdrop detail2-backdrop-fallback" />
      )}

      <div className="detail2-grid">
        {/* ─── 左栏：信息 + 操作（不滚动） ─── */}
        <div className="detail2-left">
          <div className="detail2-poster-wrap">
            {data.poster_path ? (
              <img src={coverSrc(data.poster_path, data.updated_at)} alt={data.title} className="detail2-poster" />
            ) : (
              <div className="detail2-poster detail2-poster-fallback">
                <Film size={44} className="text-text-tertiary" />
              </div>
            )}
          </div>

          <div className="detail2-info">
            <h1 className="detail2-title">{data.title}</h1>
            {data.aliases && data.aliases !== data.title && (
              <p className="detail2-aliases">{data.aliases}</p>
            )}

            <div className="detail2-meta">
              {data.vote_average > 0 && (
                <span className="rating-badge">
                  <Star size={14} fill="currentColor" />
                  {data.vote_average.toFixed(1)}
                </span>
              )}
              {metaBits.map((bit, i) => (
                <span key={i} className="detail2-meta-item">{bit}</span>
              ))}
            </div>

            {data.overview ? (
              <p className="detail2-overview">{data.overview}</p>
            ) : (
              <p className="detail2-overview detail2-overview-empty">{t('series.noOverview')}</p>
            )}

            {!isMovie && data.episode_count > 0 && (
              <div className="detail2-progress">
                <div className="detail2-progress-bar">
                  <div className="detail2-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                <span className="detail2-progress-text tabular-nums">
                  {t('series.watchedCount', { watched: data.watched_count, total: data.episode_count })}
                </span>
              </div>
            )}
          </div>

          {/* 操作列：播放 → 收藏 → 元数据 → 删除 */}
          <div className="detail2-actions">
            <button
              onClick={() => {
                if (nextEp) {
                  const target = data.seasons.flatMap((s) => s.episodes).find((e) => e.id === nextEp.id);
                  if (target) void playEpisode(target);
                  return;
                }
                if (movieFile) void playEpisode(movieFile);
              }}
              className={clsx('detail2-btn primary', heroFocused === 0 && 'gamepad-focus')}
            >
              {playLabel === t('series.allWatched')
                ? <CheckCheck size={17} className="text-green-400" />
                : <Play size={17} fill="currentColor" />}
              <span className="truncate">{playLabel}</span>
              {playSub && <span className="detail2-btn-sub tabular-nums">{playSub}</span>}
            </button>

            <button
              onClick={() => void toggleFavorite()}
              className={clsx('detail2-btn', data.favorite && 'fav-on', heroFocused === 1 && 'gamepad-focus')}
            >
              <Star size={16} className={data.favorite ? 'text-[#ffd75e]' : ''} fill={data.favorite ? 'currentColor' : 'none'} />
              {data.favorite ? t('series.favorited') : t('series.favorite')}
            </button>

            <button
              onClick={() => onAutoFetch?.(toCard(data))}
              className={clsx('detail2-btn', heroFocused === 2 && 'gamepad-focus')}
            >
              <Sparkles size={16} />
              {t('series.fetchMeta')}
            </button>

            <button
              onClick={() => onDelete?.(toCard(data))}
              className={clsx('detail2-btn danger', heroFocused === 3 && 'gamepad-focus')}
            >
              <Trash2 size={16} />
              {t('series.deleteSeries')}
            </button>
          </div>
        </div>

        {/* ─── 右栏：季列表 + 集列表（各自内部滚动） ─── */}
        <div className="detail2-right">
          {!isMovie && seasons.length > 0 && (
            <div className="detail2-seasons">
              <div className="detail2-panel-head">
                <h2 className="detail2-panel-title">{t('series.seasonsTitle')}</h2>
                {season && episodes.length > 0 && (
                  <div className="detail2-panel-tools">
                    <button
                      onClick={() => setSeasonWatched(true)}
                      className="detail2-tool"
                    >
                      <CheckCheck size={13} />
                      {t('series.markSeasonWatched')}
                    </button>
                    <button
                      onClick={() => setSeasonWatched(false)}
                      className="detail2-tool"
                    >
                      <RotateCcw size={13} />
                      {t('series.resetSeason')}
                    </button>
                  </div>
                )}
              </div>
              <div className="detail2-seasons-scroll">
                {seasons.map((s, i) => (
                  <div key={s.id} data-season-idx={i}>
                    <SeasonRow
                      season={s}
                      active={s.id === (season?.id ?? '')}
                      focused={seasonsFocused === i}
                      onPick={setActiveSeason}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="detail2-eps">
            <div className="detail2-panel-head">
              <h2 className="detail2-panel-title">
                {season?.name?.trim() || (season ? t('series.seasonN', { n: season.season_number }) : '')}
              </h2>
            </div>
            <div ref={epListRef} className="detail2-eps-scroll">
              {episodes.length === 0 ? (
                <div className="detail2-eps-empty">
                  <Film size={34} className="text-text-tertiary" />
                  <p>{isMovie ? t('series.noEpMovie') : t('series.noEpSeason')}</p>
                </div>
              ) : (
                episodes.map((ep, i) => (
                  <EpRow
                    key={ep.id}
                    ep={ep}
                    index={i}
                    isMovie={!!isMovie}
                    seriesTitle={data.title}
                    focused={episodesFocused === i}
                    onPlay={playEpisode}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 详情 data → SeriesCard（元数据/删除回调的入参形状） */
function toCard(data: SeriesDetailData): SeriesCard {
  return {
    id: data.id, title: data.title, aliases: data.aliases, overview: data.overview,
    poster_path: data.poster_path, bg_path: data.bg_path, first_air_date: data.first_air_date,
    status: data.status, tmdb_id: data.tmdb_id, tvdb_id: data.tvdb_id, tags: data.tags,
    favorite: data.favorite, vote_average: data.vote_average, genres: data.genres,
    sort_order: data.sort_order, media_type: data.media_type, total_seconds: data.total_seconds,
    created_at: data.created_at, updated_at: data.updated_at,
    season_count: data.seasons.length, episode_count: data.episode_count,
    watched_count: data.watched_count, local_count: 0, last_watched_at: '',
    next_episode: data.next_episode,
  };
}
