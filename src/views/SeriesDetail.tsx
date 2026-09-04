// 影视详情页（电视版，v3 重构）。
//
// 动线（v2 三个纵向列表互相横跳 → v3 单纵列高速路）：
//   右栏自上而下三条横排：操作行（播放/收藏/元数据/删除）→ 季 chips → 集列表。
//   下/上 = 在三条排之间移动；左/右 = 只在排内移动，行首/行尾停住。
//   每个键的行为唯一可预期，v2 的「集列表左右=换季」隐形跳转废除。
//
//   - 季 chips 焦点即预览：焦点移到哪个 chip，集列表实时切到该季
//     （与影视库「焦点落在哪张海报 Hero 就显示哪部」同一套语言）。
//   - OK/下 从 chips 进集列表，落到该季第一个未看集（全看完落第 0 集）。
//   - 长按 OK：集行 → 单集操作表（播放/标记已看未看）；季 chip → 整季操作表
//     （整季标已看/重置）。v2 的头部小按钮遥控器聚焦不到，只能鼠标点。
//   - 删除影视走确认弹窗，默认焦点在「取消」（v2 里 OK 落在删除键 = 立即删除）。
//   - 电影不渲染季 chips：操作行「下」直达文件行，文件行「上」回操作行。
//   - 返回 = 遥控器 Back（焦点栈弹层 → onClose）。
//
// 性能（沿用 v2 结论）：整页不滚动、只有集列表内部滚；行组件 React.memo；
// 一次只渲染一季；transition 只挂焦点相关属性（电视 GPU 弱，all 会卡）。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import {
  Play, Star, Check, CheckCheck, RotateCcw, Loader2,
  Film, Sparkles, Trash2, X,
} from 'lucide-react';
import { clsx } from 'clsx';
import * as api from '../api';
import type { Episode, Season, SeriesCard, SeriesDetailData } from '../types';
import { cleanEpisodeTitle, coverSrc, formatDuration, formatRuntime, watchPercent, yearOf } from '../utils/media';
import { useFocusStore, useGamepadGroup, useFocusIndex } from '../gamepad';
import ActionSheet from '../components/ActionSheet';
import { useT } from '../i18n';

interface Props {
  seriesId: string;
  onClose: () => void;
  onChanged?: () => void;
  onAutoFetch?: (s: SeriesCard) => void;
  onDelete?: (s: SeriesCard) => void;
}

const DETAIL_GROUPS = ['detail-actions', 'detail-seasons', 'detail-episodes'] as const;

/** 进集列表的落点：该季第一个未看集（都看完了落第 0 集） */
function entryIndex(eps: Episode[]): number {
  const i = eps.findIndex((e) => !e.watched);
  return i >= 0 ? i : 0;
}

/** 集行。memo：焦点移动/标记一集时，其它行不重渲染 */
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

/** 季 chip（横向） */
const SeasonChip = memo(function SeasonChip({ season, index, active, focused, onPick }: {
  season: Season & { episodes: Episode[] };
  index: number;
  active: boolean;
  focused: boolean;
  onPick: (id: string) => void;
}) {
  const t = useT();
  const watched = season.episodes.filter((e) => e.watched).length;
  const total = season.episodes.length;
  const done = total > 0 && watched === total;
  return (
    <button
      data-season-chip={index}
      onClick={() => onPick(season.id)}
      className={clsx('season-chip', active && 'active', focused && 'gamepad-focus')}
    >
      <span className="season-chip-name">
        {season.name?.trim() || t('series.seasonN', { n: season.season_number })}
      </span>
      <span className={clsx('season-chip-count tabular-nums', done && 'done')}>
        {watched}/{total}
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

  // 长按 OK 弹出的操作表（集/季）与删除确认
  const [epSheet, setEpSheet] = useState<Episode | null>(null);
  const [seasonSheet, setSeasonSheet] = useState<(Season & { episodes: Episode[] }) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
  // 季 chips 是否渲染（电影/无季的剧集不渲染：操作行「下」直达集列表）
  const chipsVisible = !!data && !isMovie && seasons.length > 0;
  const curSeasonIdx = Math.max(0, seasons.findIndex((s) => s.id === season?.id));

  // ─── 焦点组 ───────────────────────────────
  const actionsFocused = useFocusIndex('detail-actions');
  const seasonsFocused = useFocusIndex('detail-seasons');
  const episodesFocused = useFocusIndex('detail-episodes');
  const [lastActionIdx, setLastActionIdx] = useState(0);

  useEffect(() => { if (actionsFocused >= 0) setLastActionIdx(actionsFocused); }, [actionsFocused]);

  // 季 chips 焦点即预览：焦点移到哪个 chip，下方集列表实时切到该季
  useEffect(() => {
    if (seasonsFocused >= 0 && seasons[seasonsFocused]) {
      setActiveSeason(seasons[seasonsFocused].id);
    }
  }, [seasonsFocused, seasons]);

  const enterEpisodes = useCallback(() => {
    if (episodes.length === 0) return; // 空季不进入（死组）
    useFocusStore.getState().switchTo('detail-episodes', entryIndex(episodes));
  }, [episodes]);

  const playNextOrMovie = useCallback(() => {
    if (!data) return;
    if (nextEp) {
      const target = data.seasons.flatMap((s) => s.episodes).find((e) => e.id === nextEp.id);
      if (target) void playEpisode(target);
      return;
    }
    const movieFile = isMovie ? data.seasons[0]?.episodes[0] : undefined;
    if (movieFile) void playEpisode(movieFile);
  }, [data, nextEp, isMovie]);

  // 操作行（横向）：播放 → 收藏 → 元数据 → 删除。删除走确认弹窗
  useGamepadGroup('detail-actions', {
    count: 4,
    cols: 4,
    activate: (i) => {
      if (!data) return;
      if (i === 0) { playNextOrMovie(); return; }
      if (i === 1) { void toggleFavorite(); return; }
      if (i === 2) { onAutoFetch?.(toCard(data)); return; }
      setConfirmDelete(true);
    },
    leave: (dir) => {
      if (dir !== 'down') return; // 上=页面顶部（Back 退出）；左右行首行尾停住
      if (chipsVisible) useFocusStore.getState().switchTo('detail-seasons', curSeasonIdx);
      else enterEpisodes();
    },
    exit: onClose,
  });

  // 季 chips（横向）。焦点即预览（移动=切季）；OK/下 进集列表；长按 OK 整季操作
  useGamepadGroup('detail-seasons', {
    count: chipsVisible ? seasons.length : 0,
    cols: chipsVisible ? seasons.length : 1,
    activate: () => enterEpisodes(),
    scrollIntoView: (i) => {
      document.querySelector(`[data-season-chip="${i}"]`)
        ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    },
    leave: (dir) => {
      if (dir === 'up') useFocusStore.getState().switchTo('detail-actions', lastActionIdx);
      else if (dir === 'down') enterEpisodes();
    },
    longPress: (i) => {
      const s = seasons[i];
      if (s && s.episodes.length > 0) setSeasonSheet(s);
    },
    exit: onClose,
  });

  // 集列表（纵向，OK = 播放，长按 OK = 单集操作）。上到头回季 chips（电影回操作行）
  useGamepadGroup('detail-episodes', {
    count: episodes.length,
    cols: 1,
    activate: (i) => { const ep = episodes[i]; if (ep) void playEpisode(ep); },
    scrollIntoView: (i) => {
      const rows = epListRef.current?.querySelectorAll('[data-ep-row]');
      (rows?.[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    },
    leave: (dir) => {
      if (dir !== 'up') return; // 左右在纵列原地停住；下到底停住
      if (chipsVisible) useFocusStore.getState().switchTo('detail-seasons', curSeasonIdx);
      else useFocusStore.getState().switchTo('detail-actions', lastActionIdx);
    },
    longPress: (i) => {
      const ep = episodes[i];
      if (ep) setEpSheet(ep);
    },
    exit: onClose,
  });

  // 打开详情 → 焦点先落在操作行的播放键（最常用的动作）
  useEffect(() => {
    useFocusStore.getState().push('detail-actions', 0);
    return () => {
      const s = useFocusStore.getState();
      const top = s.stack.length ? s.stack[s.stack.length - 1] : undefined;
      if ((DETAIL_GROUPS as readonly string[]).includes(top?.group ?? '')) s.back();
    };
  }, []);

  // 切季/重刮后列表变短时，栈里的焦点索引可能越界（第 24 集的季 → 第 6 集的季，
  // 焦点停在 23：整屏无高亮）。把越界焦点收到最后一项
  useEffect(() => {
    const s = useFocusStore.getState();
    const top = s.stack[s.stack.length - 1];
    if (top?.group === 'detail-episodes' && top.index != null && top.index >= episodes.length) {
      s.switchTo('detail-episodes', Math.max(0, episodes.length - 1));
    }
    if (top?.group === 'detail-seasons' && top.index != null && top.index >= seasons.length) {
      s.switchTo('detail-seasons', Math.max(0, seasons.length - 1));
    }
  }, [episodes.length, seasons.length]);

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

  const markEpisode = async (ep: Episode, watched: boolean) => {
    try {
      await api.markEpisodeWatched(ep.id, watched);
      await load();
      onChanged?.();
    } catch (err) {
      void message(t('series.markFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  const setSeasonWatchedById = async (seasonId: string, watched: boolean) => {
    try {
      await api.markSeasonWatched(seasonId, watched);
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

  const epSheetSe = epSheet
    ? `S${String(seasons.find((s) => s.id === epSheet.season_id)?.season_number ?? 1).padStart(2, '0')}E${String(epSheet.episode_number).padStart(2, '0')}`
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
        {/* ─── 左栏：海报 + 总进度（纯展示，不聚焦） ─── */}
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

          {!isMovie && data.episode_count > 0 && (
            <div className="detail2-progress-block">
              <div className="detail2-progress-bar">
                <div className="detail2-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <span className="detail2-progress-text tabular-nums">
                {t('series.watchedCount', { watched: data.watched_count, total: data.episode_count })}
              </span>
            </div>
          )}
        </div>

        {/* ─── 右栏：标题区 → 操作行 → 季 chips → 集列表（单纵列动线） ─── */}
        <div className="detail2-right">
          <div className="detail2-head">
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
          </div>

          {/* 操作行：播放 → 收藏 → 元数据 → 删除（删除弹确认） */}
          <div className="detail2-actions">
            <button
              onClick={playNextOrMovie}
              className={clsx('detail2-btn primary', actionsFocused === 0 && 'gamepad-focus')}
            >
              {playLabel === t('series.allWatched')
                ? <CheckCheck size={17} className="text-green-400" />
                : <Play size={17} fill="currentColor" />}
              <span className="truncate">{playLabel}</span>
              {playSub && <span className="detail2-btn-sub tabular-nums">{playSub}</span>}
            </button>

            <button
              onClick={() => void toggleFavorite()}
              className={clsx('detail2-btn', data.favorite && 'fav-on', actionsFocused === 1 && 'gamepad-focus')}
            >
              <Star size={16} className={data.favorite ? 'text-[#ffd75e]' : ''} fill={data.favorite ? 'currentColor' : 'none'} />
              {data.favorite ? t('series.favorited') : t('series.favorite')}
            </button>

            <button
              onClick={() => onAutoFetch?.(toCard(data))}
              className={clsx('detail2-btn', actionsFocused === 2 && 'gamepad-focus')}
            >
              <Sparkles size={16} />
              {t('series.fetchMeta')}
            </button>

            <button
              onClick={() => setConfirmDelete(true)}
              className={clsx('detail2-btn danger', actionsFocused === 3 && 'gamepad-focus')}
            >
              <Trash2 size={16} />
              {t('series.deleteSeries')}
            </button>
          </div>

          {/* 季 chips（焦点即预览；电影不渲染） */}
          {chipsVisible && (
            <div className="detail2-chips">
              <div className="detail2-chips-scroll">
                {seasons.map((s, i) => (
                  <SeasonChip
                    key={s.id}
                    season={s}
                    index={i}
                    active={s.id === (season?.id ?? '')}
                    focused={seasonsFocused === i}
                    onPick={setActiveSeason}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 集列表 */}
          <div className="detail2-eps">
            <div className="detail2-panel-head">
              <h2 className="detail2-panel-title">
                {isMovie
                  ? t('series.movie')
                  : (season?.name?.trim() || (season ? t('series.seasonN', { n: season.season_number }) : ''))}
              </h2>
              <span className="detail2-hint">{t('series.hintEpsKeys')}</span>
              {season && episodes.length > 0 && !isMovie && (
                <div className="detail2-panel-tools">
                  <button
                    onClick={() => void setSeasonWatchedById(season.id, true)}
                    className="detail2-tool"
                  >
                    <CheckCheck size={13} />
                    {t('series.markSeasonWatched')}
                  </button>
                  <button
                    onClick={() => void setSeasonWatchedById(season.id, false)}
                    className="detail2-tool"
                  >
                    <RotateCcw size={13} />
                    {t('series.resetSeason')}
                  </button>
                </div>
              )}
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

      {/* 长按 OK：单集操作表 */}
      {epSheet && (
        <ActionSheet
          title={t('series.epActionsTitle')}
          subtitle={`${epSheetSe} · ${cleanEpisodeTitle(epSheet.title, epSheet.episode_number)}`}
          items={[
            {
              icon: Play,
              label: t('series.playEp', { se: epSheetSe }),
              onSelect: () => void playEpisode(epSheet),
            },
            epSheet.watched
              ? {
                  icon: RotateCcw,
                  label: t('series.markUnwatched'),
                  onSelect: () => void markEpisode(epSheet, false),
                }
              : {
                  icon: Check,
                  label: t('series.markWatched'),
                  onSelect: () => void markEpisode(epSheet, true),
                },
          ]}
          onClose={() => setEpSheet(null)}
        />
      )}

      {/* 长按 OK：整季操作表 */}
      {seasonSheet && (
        <ActionSheet
          title={t('series.seasonActionsTitle')}
          subtitle={seasonSheet.name?.trim() || t('series.seasonN', { n: seasonSheet.season_number })}
          items={[
            {
              icon: CheckCheck,
              label: t('series.markSeasonWatched'),
              onSelect: () => void setSeasonWatchedById(seasonSheet.id, true),
            },
            {
              icon: RotateCcw,
              label: t('series.resetSeason'),
              onSelect: () => void setSeasonWatchedById(seasonSheet.id, false),
            },
          ]}
          onClose={() => setSeasonSheet(null)}
        />
      )}

      {/* 删除确认（默认焦点在「取消」） */}
      {confirmDelete && (
        <ActionSheet
          title={t('series.deleteSeries')}
          subtitle={t('series.deleteConfirm', { title: data.title })}
          items={[
            { icon: X, label: t('common.cancel'), onSelect: () => {} },
            {
              icon: Trash2,
              label: t('common.delete'),
              danger: true,
              onSelect: () => onDelete?.(toCard(data)),
            },
          ]}
          onClose={() => setConfirmDelete(false)}
        />
      )}
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
