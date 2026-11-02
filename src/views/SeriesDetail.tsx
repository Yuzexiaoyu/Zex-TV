// 影视详情页（电视版 v5，完全重构）。
//
// 布局：全屏沉浸（盖住顶部导航），整幅剧照铺底 + 左/下渐变压暗。
//   上：标题 / 元信息 / 简介 / 操作行（播放 · 收藏 · 元数据 · 删除）
//   下：季标签（带进度）+ 左侧集列表 + 右侧单集预览（剧照 / 单集简介 / 文件）
//   电影：无季标签、无预览，只有一行影片文件。
//
// 动线（沿用 v3 的单纵列高速路，已经过真机验证）：
//   操作行 ↕ 季标签 ↕ 集列表；横排行内左/右移动，行首/行尾停住；
//   焦点在集列表时左右 = 翻上/下一季（同集序号续走，首尾季停住）。
//   - 季标签焦点即预览：焦点移到哪季，集列表与预览面板立刻切过去。
//   - OK/下 从季标签进集列表，落在该季第一个未看集。
//   - 长按 OK：集 → 单集操作表（播放 / 标记 / 标记此集及之前）；季 → 整季操作表。
//   - 删除走确认表，默认焦点在「取消」。Back = 关详情。
//
// 性能：
//   - 整页不滚动，只有集列表内滚；滚动用 scrollTop 手算（scrollIntoView 会连带
//     滚动 overflow:hidden 的祖先，布局会被整体顶歪）。
//   - 行/季标签/预览都 memo；标记已看只替换受影响的季对象，其余行不重渲染。
//   - 预览（文字+剧照）即时跟随焦点：剧照复用同一个 <img> 直接换 src，浏览器
//     保留旧帧直到新图解码完（永不闪空）；邻集（±1/±2）剧照预取让落点即点即显。
//   - 不用 backdrop-filter；transition 只挂 transform/颜色。
//   - 标记已看乐观更新：先改界面再请求，失败回滚（遥控器按下即见结果）。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import {
  Play, Star, Check, CheckCheck, RotateCcw, Loader2, Film, Sparkles, Trash2, X, ListChecks,
} from 'lucide-react';
import { clsx } from 'clsx';
import * as api from '../api';
import type { Episode, SeasonWithEpisodes, SeriesCard, SeriesDetailData } from '../types';
import {
  cleanEpisodeTitle, coverSrc, formatDuration, formatRuntime, watchPercent, yearOf,
} from '../utils/media';
import { reveal } from '../utils/dom';
import { warmStill } from '../utils/backdrop';
import { useFocusStore, useGamepadGroup, useFocusIndex } from '../gamepad';
import { useAppStore } from '../store';
import ActionSheet, { type ActionSheetItem } from '../components/ActionSheet';
import { t as tr, useT } from '../i18n';

interface Props {
  seriesId: string;
  /** 影视库卡片：详情还在加载时先用它画出头部（标题/剧照/简介），打开即有画面 */
  initial?: SeriesCard;
  onClose: () => void;
  onReadyChange?: (ready: boolean) => void;
  onChanged?: () => void;
  onAutoFetch?: (s: SeriesCard) => void;
  onDelete?: (s: SeriesCard) => void;
}

const DETAIL_GROUPS = ['detail-actions', 'detail-seasons', 'detail-episodes'] as const;

const pad2 = (n: number) => String(n).padStart(2, '0');
const seLabel = (s: number, e: number) => `S${pad2(s)}E${pad2(e)}`;
const seasonName = (s: SeasonWithEpisodes) => s.name?.trim() || tr('series.seasonN', { n: s.season_number });

/** 进集列表的落点：该季第一个未看集（都看完了落第 0 集） */
function entryIndex(eps: Episode[]): number {
  const i = eps.findIndex((e) => !e.watched);
  return i >= 0 ? i : 0;
}

function remainingMin(ep: Episode): number {
  if (!ep.runtime_minutes || !ep.watched_ms || ep.watched) return 0;
  return Math.max(1, Math.round(ep.runtime_minutes - ep.watched_ms / 60000));
}

function episodeTitle(ep: Episode, isMovie: boolean, seriesTitle: string): string {
  const cleaned = cleanEpisodeTitle(ep.title, ep.episode_number);
  if (!isMovie) return cleaned;
  return cleaned.replace(/^第 \d+ 集$/, seriesTitle) || seriesTitle;
}

const fileNameOf = (path: string) => (path ? path.split(/[/\\]/).pop() ?? '' : '');

// ─── 集行 ──────────────────────────────────────
const EpRow = memo(function EpRow({ ep, index, title, sub, focused, onPlay }: {
  ep: Episode;
  index: number;
  title: string;
  sub: string;
  focused: boolean;
  onPlay: (ep: Episode) => void;
}) {
  const pct = ep.watched ? 100 : watchPercent(ep.watched_ms, ep.runtime_minutes);
  const partial = !ep.watched && pct > 0;
  return (
    <button
      data-ep-row={index}
      onClick={() => onPlay(ep)}
      className={clsx(
        'dt-ep',
        ep.watched && 'watched',
        !ep.local_path && 'nofile',
        focused && 'gamepad-focus',
      )}
    >
      <span className="dt-ep-num">{pad2(ep.episode_number)}</span>
      <span className="dt-ep-main">
        <span className="dt-ep-title">{title}</span>
        {sub && <span className="dt-ep-sub">{sub}</span>}
      </span>
      <span className="dt-ep-dur">{formatRuntime(ep.runtime_minutes)}</span>
      <span className={clsx('dt-ep-badge', ep.watched ? 'done' : partial ? 'partial' : '')}>
        {ep.watched
          ? <Check size={15} strokeWidth={3} />
          : partial ? `${Math.round(pct)}%` : <Play size={13} fill="currentColor" />}
      </span>
      {partial && <span className="dt-ep-progress"><i style={{ width: `${pct}%` }} /></span>}
    </button>
  );
});

// ─── 季标签 ────────────────────────────────────
const SeasonTab = memo(function SeasonTab({ season, index, active, focused, onPick }: {
  season: SeasonWithEpisodes;
  index: number;
  active: boolean;
  focused: boolean;
  onPick: (id: string) => void;
}) {
  const total = season.episodes.length;
  const watched = season.episodes.reduce((n, e) => n + (e.watched ? 1 : 0), 0);
  const done = total > 0 && watched === total;
  return (
    <button
      data-season-tab={index}
      onClick={() => onPick(season.id)}
      className={clsx('dt-tab', active && 'active', done && 'done', focused && 'gamepad-focus')}
    >
      <span className="dt-tab-name">{seasonName(season)}</span>
      <span className="dt-tab-count tabular-nums">
        {done ? <CheckCheck size={14} /> : `${watched}/${total}`}
      </span>
      <span className="dt-tab-bar"><i style={{ width: total ? `${(watched / total) * 100}%` : '0%' }} /></span>
    </button>
  );
});

// ─── 单集预览 ──────────────────────────────────
// 剧照即时切换：复用同一个 <img> 直接换 src（不能加 key——重挂载会清掉已显示
// 的帧），浏览器保留旧帧直到新图解码完成，即解码即显示，全程不闪空。
const EpisodePreview = memo(function EpisodePreview({ ep, seasonNo, kicker, title, version }: {
  ep: Episode;
  seasonNo: number;
  kicker: string;
  title: string;
  version: string;
}) {
  const t = useT();
  const target = ep.still_path ? coverSrc(ep.still_path, version) : '';

  // 剧照用「已解码节点」挂入（见 utils/backdrop）：首次进详情时入口集剧照已在
  // 预取阶段解码好，这里直接挂同一个节点 → 和整页一起出现，不再慢一两帧。
  // 换集时新节点解码完才替换，旧帧保留，不闪空。
  const stillHostRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const host = stillHostRef.current;
    if (!host) return;
    if (!target) { host.replaceChildren(); return; }
    const entry = warmStill(target);
    let cancelled = false;
    const put = (ok: boolean) => { if (!cancelled && ok) host.replaceChildren(entry.image); };
    if (entry.ready) put(true);
    else void entry.promise.then(put);
    return () => { cancelled = true; };
  }, [target]);
  const pct = ep.watched ? 0 : watchPercent(ep.watched_ms, ep.runtime_minutes);
  const left = remainingMin(ep);
  const meta = [
    ep.air_date ? ep.air_date.slice(0, 10) : '',
    formatRuntime(ep.runtime_minutes),
    left ? t('series.remainingMin', { n: left }) : '',
  ].filter(Boolean);
  const file = fileNameOf(ep.local_path);

  return (
    <aside className="dt-preview">
      <div className="dt-still">
        <span className="dt-still-fallback">{seLabel(seasonNo, ep.episode_number)}</span>
        <span ref={stillHostRef} className="dt-still-img" />
        {ep.watched && (
          <span className="dt-still-flag"><Check size={13} strokeWidth={3} />{t('series.watched')}</span>
        )}
        {pct > 0 && <span className="dt-still-progress"><i style={{ width: `${pct}%` }} /></span>}
      </div>
      <p className="dt-pv-kicker">{kicker}</p>
      <h3 className="dt-pv-title">{title}</h3>
      {(meta.length > 0 || ep.vote_average > 0) && (
        <div className="dt-pv-meta">
          {ep.vote_average > 0 && (
            <span className="dt-pv-vote"><Star size={12} fill="currentColor" />{ep.vote_average.toFixed(1)}</span>
          )}
          {meta.map((m) => <span key={m}>{m}</span>)}
        </div>
      )}
      <p className={clsx('dt-pv-overview', !ep.overview && 'empty')}>
        {ep.overview || t('series.noEpOverview')}
      </p>
      <p className={clsx('dt-pv-file', !file && 'missing')}>{file || t('series.epNoLocalFile')}</p>
    </aside>
  );
});

export default function SeriesDetail({ seriesId, initial, onClose, onReadyChange, onChanged, onAutoFetch, onDelete }: Props) {
  const t = useT();
  // 打开即时出：优先用「焦点停留时预取」的缓存渲染（stale-while-revalidate，load() 仍拉最新回写）
  const [data, setData] = useState<SeriesDetailData | null>(() => useAppStore.getState().detailCache[seriesId] ?? null);
  const [activeSeason, setActiveSeason] = useState(() => {
    const c = useAppStore.getState().detailCache[seriesId];
    if (!c) return '';
    return (c.seasons.find((s) => s.episodes.some((e) => !e.watched)) ?? c.seasons[0])?.id ?? '';
  });

  const epListRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  // 长按 OK 弹出的操作表（集/季）与删除确认
  const [epSheet, setEpSheet] = useState<Episode | null>(null);
  const [seasonSheet, setSeasonSheet] = useState<SeasonWithEpisodes | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ─── 数据 ─────────────────────────────────
  const cachedAtMount = useRef(!!useAppStore.getState().detailCache[seriesId]); // 挂载时是否已有预取数据
  const loadSequence = useRef(0);
  useEffect(() => () => { loadSequence.current++; }, []);
  const load = useCallback(async (fresh = true) => {
    const seq = ++loadSequence.current;
    const detail = await useAppStore.getState().fetchDetail(seriesId, fresh);
    if (seq !== loadSequence.current) return;
    setData(detail);
    setActiveSeason((prev) => {
      if (prev && detail.seasons.some((s) => s.id === prev)) return prev;
      const next = detail.seasons.find((s) => s.episodes.some((e) => !e.watched));
      return next?.id || detail.seasons[0]?.id || '';
    });
  }, [seriesId]);

  useEffect(() => {
    if (cachedAtMount.current) return; // 有预取数据则跳过开屏重复拉取（省 ~600ms IPC+重渲染）；新鲜度由 dataVersion/app-resumed 兜底
    load(false).catch((err) => {
      void message(t('series.loadFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    });
  }, [load]);

  // data 变化（load 完成 / 标记已看 / 收藏）→ 回写预取缓存，下次打开即时且最新
  useEffect(() => {
    if (data) useAppStore.getState().cacheDetail(seriesId, data);
  }, [data, seriesId]);

  // 系统播放器退出、App 回前台、肃正协议合并了对端进度：进度/已看可能变了，重拉。
  // progress-synced 在同步合并完成后才发（晚于 app-resumed），所以两个都听。
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const reload = () => { void load().catch(() => {}); };
      const stopA = await listen<void>('app-resumed', reload);
      const stopB = await listen<number>('progress-synced', reload);
      const stop = () => { stopA(); stopB(); };
      if (cancelled) stop(); else un = stop;
    })();
    return () => { cancelled = true; un?.(); };
  }, [load]);

  // 视图外的改动（「看完了吗」回执标记、刮削完成）→ 就地重拉。跳过挂载时的初值
  const dataVersion = useAppStore((s) => s.dataVersion);
  const seenVersion = useRef(dataVersion);
  useEffect(() => {
    if (dataVersion === seenVersion.current) return;
    seenVersion.current = dataVersion;
    void load().catch(() => {});
  }, [dataVersion, load]);

  // ─── 派生 ─────────────────────────────────
  const isMovie = (data?.media_type ?? initial?.media_type) === 'movie';
  const seasons = data?.seasons ?? [];
  const season = seasons.find((s) => s.id === activeSeason) ?? seasons[0];
  const episodes = season?.episodes ?? [];
  // 单季剧不显示季标签(「第一季」那个小标签):只有 >1 季才需要切季的标签行。
  // 单季时整行退化成 else 分支的「剧集」标题,焦点动线也自动跳过季标签行
  // (操作行↓直接进集列表、集列表↑直接回操作行),与电影/无季一致。
  const chipsVisible = !isMovie && seasons.length > 1;
  const curSeasonIdx = Math.max(0, seasons.findIndex((s) => s.id === season?.id));

  // 全剧进度与「下一集」在前端按季集顺序推导（乐观更新后立即正确，不等后端回包）
  const progress = useMemo(() => {
    let total = 0;
    let watched = 0;
    let next: { ep: Episode; seasonNo: number } | null = null;
    for (const s of seasons) {
      for (const e of s.episodes) {
        total++;
        if (e.watched) watched++;
        else if (!next) next = { ep: e, seasonNo: s.season_number };
      }
    }
    return { total, watched, next };
  }, [seasons]);

  const movieFile = isMovie ? seasons[0]?.episodes[0] : undefined;

  // ─── 焦点 ─────────────────────────────────
  const actionsFocused = useFocusIndex('detail-actions');
  const seasonsFocused = useFocusIndex('detail-seasons');
  const episodesFocused = useFocusIndex('detail-episodes');
  const lastActionIdx = useRef(0);
  if (actionsFocused >= 0) lastActionIdx.current = actionsFocused;

  // 季标签焦点即预览
  useEffect(() => {
    if (seasonsFocused >= 0 && seasons[seasonsFocused]) setActiveSeason(seasons[seasonsFocused].id);
  }, [seasonsFocused, seasons]);

  // 换季 / 首次拿到数据：焦点不在列表时，列表滚到「该季第一个未看集」居中；
  // 焦点在列表里（左右键翻季）时集序号不变，行高一致下 scrollTop 仍然有效，
  // reveal 只做兜底；同时把活动季标签居中露出——标签行的滚动只挂在 chips
  // 焦点组的 scrollIntoView 上，从列表翻季不经过它，不滚会被裁掉
  const hasData = data !== null;
  useEffect(() => {
    const list = epListRef.current;
    if (!list) return;
    const { stack } = useFocusStore.getState();
    const top = stack[stack.length - 1];
    if (top?.group === 'detail-episodes' && top.index != null) {
      reveal(tabsRef.current, `[data-season-tab="${curSeasonIdx}"]`, 'x', true);
      reveal(list, `[data-ep-row="${top.index}"]`, 'y');
      return;
    }
    list.scrollTop = 0;
    reveal(list, `[data-ep-row="${entryIndex(episodes)}"]`, 'y', true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [season?.id, hasData]);

  const enterEpisodes = useCallback(() => {
    if (episodes.length === 0) return; // 空季不进入（死组）
    useFocusStore.getState().switchTo('detail-episodes', entryIndex(episodes));
  }, [episodes]);

  // ─── 操作 ─────────────────────────────────
  const playEpisode = useCallback(async (ep: Episode) => {
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
  }, [t, onChanged]);

  const setWatched = useCallback(async (ids: string[], watched: boolean) => {
    if (ids.length === 0 || !data) return;
    const before = data;
    const hit = new Set(ids);
    setData({
      ...data,
      seasons: data.seasons.map((s) => (s.episodes.some((e) => hit.has(e.id))
        ? { ...s, episodes: s.episodes.map((e) => (hit.has(e.id) ? { ...e, watched, watched_ms: 0 } : e)) }
        : s)),
    });
    try {
      await api.markEpisodesWatched(ids, watched);
      onChanged?.();
    } catch (err) {
      setData(before);
      void message(t('series.markFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  }, [data, onChanged, t]);

  const toggleFavorite = useCallback(async () => {
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
  }, [data, onChanged, t]);

  // 主按钮：电影 → 播放影片；剧集 → 下一集；全看完 → 从第一集重看
  const primary = useMemo(() => {
    if (isMovie) {
      const left = movieFile ? remainingMin(movieFile) : 0;
      return {
        target: movieFile ?? null,
        label: t('series.playMovie'),
        sub: left ? t('series.remainingMin', { n: left }) : '',
        pct: movieFile && !movieFile.watched ? watchPercent(movieFile.watched_ms, movieFile.runtime_minutes) : 0,
        rewatch: false,
      };
    }
    const { next, watched, total } = progress;
    if (next) {
      const left = remainingMin(next.ep);
      return {
        target: next.ep,
        label: watched > 0 || left ? t('series.continueWatching') : t('series.startWatching'),
        sub: seLabel(next.seasonNo, next.ep.episode_number) + (left ? ` · ${t('series.remainingMin', { n: left })}` : ''),
        pct: watchPercent(next.ep.watched_ms, next.ep.runtime_minutes),
        rewatch: false,
      };
    }
    const first = seasons.find((s) => s.episodes.length > 0);
    return {
      target: first?.episodes[0] ?? null,
      label: total > 0 ? t('series.rewatch') : t('series.play'),
      sub: first ? seLabel(first.season_number, first.episodes[0].episode_number) : '',
      pct: 0,
      rewatch: total > 0,
    };
  }, [isMovie, movieFile, progress, seasons, t]);

  // ─── 焦点组 ───────────────────────────────
  // 操作行（横向）：播放 → 收藏 → 元数据 → 删除
  useGamepadGroup('detail-actions', {
    count: 4,
    cols: 4,
    activate: (i) => {
      if (!data) return;
      if (i === 0) { if (primary.target) void playEpisode(primary.target); return; }
      if (i === 1) { void toggleFavorite(); return; }
      if (i === 2) { onAutoFetch?.(toCard(data)); return; }
      setConfirmDelete(true);
    },
    leave: (dir) => {
      if (dir !== 'down' || !data) return;
      if (chipsVisible) useFocusStore.getState().switchTo('detail-seasons', curSeasonIdx);
      else enterEpisodes();
    },
    exit: onClose,
  });

  // 季标签（横向）：移动即切季；OK/下 进集列表；长按 OK 整季操作
  useGamepadGroup('detail-seasons', {
    count: chipsVisible ? seasons.length : 0,
    cols: chipsVisible ? seasons.length : 1,
    activate: () => enterEpisodes(),
    scrollIntoView: (i) => reveal(tabsRef.current, `[data-season-tab="${i}"]`, 'x'),
    leave: (dir) => {
      if (dir === 'up') useFocusStore.getState().switchTo('detail-actions', lastActionIdx.current);
      else if (dir === 'down') enterEpisodes();
    },
    longPress: (i) => {
      const s = seasons[i];
      if (s && s.episodes.length > 0) setSeasonSheet(s);
    },
    exit: onClose,
  });

  // 集列表（纵向）：OK 播放，长按 OK 单集操作；上到头回季标签（电影回操作行）；
  // 左右不移动行，直接翻上/下一季：焦点留在列表、同集序号续走
  useGamepadGroup('detail-episodes', {
    count: episodes.length,
    cols: 1,
    activate: (i) => { const ep = episodes[i]; if (ep) void playEpisode(ep); },
    scrollIntoView: (i) => reveal(epListRef.current, `[data-ep-row="${i}"]`, 'y'),
    horizontal: (dir) => {
      if (!chipsVisible) return false; // 电影/无季：左右无意义，原地停住
      const step = dir === 'left' ? -1 : 1;
      let j = curSeasonIdx + step;
      while (j >= 0 && j < seasons.length && seasons[j].episodes.length === 0) j += step; // 空季跳过
      if (j < 0 || j >= seasons.length) return false; // 首尾季：停住
      const cur = Math.max(0, episodesFocused);
      const idx = Math.min(cur, seasons[j].episodes.length - 1); // 目标季更短：焦点收尾，避免一帧无高亮
      if (idx !== cur) useFocusStore.getState().switchTo('detail-episodes', idx);
      setActiveSeason(seasons[j].id);
      return true;
    },
    leave: (dir) => {
      if (dir !== 'up') return; // 下到底停住
      if (chipsVisible) useFocusStore.getState().switchTo('detail-seasons', curSeasonIdx);
      else useFocusStore.getState().switchTo('detail-actions', lastActionIdx.current);
    },
    longPress: (i) => { const ep = episodes[i]; if (ep) setEpSheet(ep); },
    exit: onClose,
  });

  // 打开 → 焦点落在播放键；卸载时若栈顶还是详情的组就弹掉
  useEffect(() => {
    useFocusStore.getState().push('detail-actions', 0);
    return () => {
      const s = useFocusStore.getState();
      const top = s.stack.length ? s.stack[s.stack.length - 1] : undefined;
      if ((DETAIL_GROUPS as readonly string[]).includes(top?.group ?? '')) s.back();
    };
  }, []);

  // 切季/重刮后列表变短：越界焦点收到最后一项（否则整屏无高亮）
  useEffect(() => {
    const s = useFocusStore.getState();
    const top = s.stack[s.stack.length - 1];
    if (top?.group === 'detail-episodes' && top.index != null && top.index >= episodes.length) {
      if (episodes.length > 0) s.switchTo('detail-episodes', episodes.length - 1);
      else s.switchTo(chipsVisible ? 'detail-seasons' : 'detail-actions', chipsVisible ? curSeasonIdx : 0);
    }
    if (top?.group === 'detail-seasons' && top.index != null && top.index >= seasons.length) {
      s.switchTo('detail-seasons', Math.max(0, seasons.length - 1));
    }
  }, [episodes.length, seasons.length, chipsVisible, curSeasonIdx]);

  // ─── 渲染 ─────────────────────────────────
  const info = data ?? initial;
  const version = info?.updated_at ?? '';

  // 背景图由全局共享层（StageBackdrop）承担：打开详情时它已经是 Hero 那张、已解码，
  // 原地展开即可。详情自身不再画背景、也不等背景解码，整页立即入场（更快）。
  useLayoutEffect(() => {
    onReadyChange?.(true);
  }, [onReadyChange]);

  const metaBits = info
    ? (isMovie
      ? [t('series.movie'), yearOf(info.first_air_date), info.status, info.genres, formatRuntime(movieFile?.runtime_minutes ?? 0)]
      : [yearOf(info.first_air_date), info.status, info.genres,
        (data ? seasons.length : initial?.season_count ?? 0) > 0
          ? t('series.seasonCount', { n: data ? seasons.length : initial?.season_count ?? 0 }) : '',
        (data ? progress.total : initial?.episode_count ?? 0) > 0
          ? t('series.episodeCount', { n: data ? progress.total : initial?.episode_count ?? 0 }) : '']
    ).concat(info.total_seconds > 0 ? [t('series.watchedTotal', { time: formatDuration(info.total_seconds) })] : [])
      .filter(Boolean)
    : [];

  const focusedEp = episodesFocused >= 0 ? episodes[episodesFocused] : undefined;
  // 预览（文字+剧照）即时跟随焦点，不做停稳延迟
  const previewEp = focusedEp ?? episodes[entryIndex(episodes)];
  const previewSeason = previewEp
    ? seasons.find((s) => s.id === previewEp.season_id) ?? season
    : season;
  const previewKicker = previewEp && previewSeason
    ? (focusedEp
      ? `${seasonName(previewSeason)} · ${t('common.episodeN', { n: previewEp.episode_number })}`
      : `${t('series.upNext')} · ${seLabel(previewSeason.season_number, previewEp.episode_number)}`)
    : '';

  // 预取焦点邻集剧照（w342 小图，本地协议秒回）：解码进共享缓存，连按扫列表时
  // 落点的节点多半已就绪，EpisodePreview 直接复用已解码节点，近似瞬时切换
  useEffect(() => {
    const base = episodesFocused >= 0 ? episodesFocused : entryIndex(episodes);
    for (const j of [base - 1, base + 1, base + 2]) {
      const ep = episodes[j];
      if (ep?.still_path) warmStill(coverSrc(ep.still_path, version));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodesFocused, episodes, version]);

  const overallPct = progress.total > 0 ? (progress.watched / progress.total) * 100 : 0;
  const title = info?.title ?? '';

  return (
    <>
    <div className="dt-root">
      {/* 背景由全局 StageBackdrop 提供（与主页 Hero 同一张图，已解码），这里只压暗托文字 */}
      <div className="dt-shade" />

      <div className="dt-layout">
        {/* ── 头部：标题 / 元信息 / 简介 / 操作 ── */}
        <header className="dt-head">
          <h1 className="dt-title">{title}</h1>
          {info?.aliases && info.aliases !== title && <p className="dt-aliases">{info.aliases}</p>}
          <div className="dt-meta">
            {info && info.vote_average > 0 && (
              <span className="rating-badge"><Star size={13} fill="currentColor" />{info.vote_average.toFixed(1)}</span>
            )}
            {metaBits.map((bit, i) => <span key={i} className="dt-meta-item">{bit}</span>)}
          </div>
          <p className={clsx('dt-overview', !info?.overview && 'empty')}>
            {info?.overview || t('series.noOverview')}
          </p>

          <div className="dt-actions">
            <button
              onClick={() => { if (primary.target) void playEpisode(primary.target); }}
              className={clsx('dt-btn primary', !primary.target && 'idle', actionsFocused === 0 && 'gamepad-focus')}
            >
              {primary.rewatch ? <RotateCcw size={18} /> : <Play size={18} fill="currentColor" />}
              <span className="dt-btn-label">{primary.label}</span>
              {primary.sub && <span className="dt-btn-sub tabular-nums">{primary.sub}</span>}
              {primary.pct > 0 && <span className="dt-btn-progress"><i style={{ width: `${primary.pct}%` }} /></span>}
            </button>
            <button
              onClick={() => void toggleFavorite()}
              className={clsx('dt-btn', data?.favorite && 'fav-on', actionsFocused === 1 && 'gamepad-focus')}
            >
              <Star size={17} fill={data?.favorite ? 'currentColor' : 'none'} />
              {data?.favorite ? t('series.favorited') : t('series.favorite')}
            </button>
            <button
              onClick={() => { if (data) onAutoFetch?.(toCard(data)); }}
              className={clsx('dt-btn', actionsFocused === 2 && 'gamepad-focus')}
            >
              <Sparkles size={17} />
              {t('series.fetchMeta')}
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className={clsx('dt-btn danger', actionsFocused === 3 && 'gamepad-focus')}
            >
              <Trash2 size={17} />
              {t('series.deleteSeries')}
            </button>
          </div>
        </header>

        {/* ── 下半：季标签 + 集列表 + 预览 ── */}
        <section className="dt-lower">
          <div className={clsx('dt-lower-head', !isMovie && !chipsVisible && 'bare')}>
            {chipsVisible ? (
              <div ref={tabsRef} className="dt-tabs">
                {seasons.map((s, i) => (
                  <SeasonTab
                    key={s.id}
                    season={s}
                    index={i}
                    active={s.id === season?.id && seasonsFocused < 0}
                    focused={seasonsFocused === i}
                    onPick={setActiveSeason}
                  />
                ))}
              </div>
            ) : isMovie ? (
              <h2 className="dt-lower-title">{t('series.movie')}</h2>
            ) : null}
            {!isMovie && progress.total > 0 && (
              <div className="dt-overall">
                <span className="dt-overall-bar"><i style={{ width: `${overallPct}%` }} /></span>
                <span className="tabular-nums">
                  {t('series.watchedCount', { watched: progress.watched, total: progress.total })}
                </span>
              </div>
            )}
            <span className="dt-hint">
              {t(!isMovie && seasons.length > 1 ? 'series.hintEpsKeys' : 'series.hintMovieKeys')}
            </span>
          </div>

          <div className={clsx('dt-browse', (isMovie || !previewEp) && 'solo')}>
            <div ref={epListRef} className="dt-eps">
              {!data ? (
                <div className="dt-empty">
                  <Loader2 size={22} className="animate-spin text-[#00d4ff]" />
                  {t('series.loading')}
                </div>
              ) : episodes.length === 0 ? (
                <div className="dt-empty">
                  <Film size={34} className="text-text-tertiary" />
                  {isMovie ? t('series.noEpMovie') : t('series.noEpSeason')}
                </div>
              ) : (
                episodes.map((ep, i) => (
                  <EpRow
                    key={ep.id}
                    ep={ep}
                    index={i}
                    title={episodeTitle(ep, isMovie, title)}
                    sub={isMovie
                      ? fileNameOf(ep.local_path) || t('series.epNoLocalFile')
                      : [ep.air_date ? ep.air_date.slice(0, 10) : '', ep.local_path ? '' : t('series.epNoLocalFile')]
                        .filter(Boolean).join(' · ')}
                    focused={episodesFocused === i}
                    onPlay={playEpisode}
                  />
                ))
              )}
            </div>

            {!isMovie && previewEp && previewSeason && (
              <EpisodePreview
                ep={previewEp}
                seasonNo={previewSeason.season_number}
                kicker={previewKicker}
                title={episodeTitle(previewEp, false, title)}
                version={version}
              />
            )}
          </div>
        </section>
      </div>

      {epSheet && (
        <ActionSheet
          title={t('series.epActionsTitle')}
          subtitle={`${seLabel(seasons.find((s) => s.id === epSheet.season_id)?.season_number ?? 1, epSheet.episode_number)} · ${episodeTitle(epSheet, isMovie, title)}`}
          items={episodeSheetItems(epSheet, seasons, playEpisode, setWatched)}
          onClose={() => setEpSheet(null)}
        />
      )}

      {seasonSheet && (
        <ActionSheet
          title={t('series.seasonActionsTitle')}
          subtitle={seasonName(seasonSheet)}
          items={[
            {
              icon: CheckCheck,
              label: t('series.markSeasonWatched'),
              onSelect: () => void setWatched(seasonSheet.episodes.filter((e) => !e.watched).map((e) => e.id), true),
            },
            {
              icon: RotateCcw,
              label: t('series.resetSeason'),
              onSelect: () => void setWatched(seasonSheet.episodes.filter((e) => e.watched || e.watched_ms > 0).map((e) => e.id), false),
            },
          ]}
          onClose={() => setSeasonSheet(null)}
        />
      )}

      {confirmDelete && data && (
        <ActionSheet
          title={t('series.deleteSeries')}
          subtitle={t('series.deleteConfirm', { title: data.title })}
          items={[
            { icon: X, label: t('common.cancel'), onSelect: () => {} },
            { icon: Trash2, label: t('common.delete'), danger: true, onSelect: () => onDelete?.(toCard(data)) },
          ]}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
    </>
  );
}

/** 单集操作表：播放 / 标记切换 / 标记此集及之前（本季前面还有没看的才出现） */
function episodeSheetItems(
  ep: Episode,
  seasons: SeasonWithEpisodes[],
  play: (ep: Episode) => void,
  setWatched: (ids: string[], watched: boolean) => void,
): ActionSheetItem[] {
  const items: ActionSheetItem[] = [];
  if (ep.local_path) items.push({ icon: Play, label: tr('series.play'), onSelect: () => play(ep) });
  items.push(ep.watched
    ? { icon: RotateCcw, label: tr('series.markUnwatched'), onSelect: () => setWatched([ep.id], false) }
    : { icon: Check, label: tr('series.markWatched'), onSelect: () => setWatched([ep.id], true) });
  const eps = seasons.find((s) => s.id === ep.season_id)?.episodes ?? [];
  const idx = eps.findIndex((e) => e.id === ep.id);
  const upTo = idx >= 0 ? eps.slice(0, idx + 1).filter((e) => !e.watched).map((e) => e.id) : [];
  if (upTo.some((id) => id !== ep.id)) {
    items.push({ icon: ListChecks, label: tr('series.markUpToHere'), onSelect: () => setWatched(upTo, true) });
  }
  return items;
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
