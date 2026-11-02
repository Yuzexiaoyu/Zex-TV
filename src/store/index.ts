// 电视版 store（裁剪自 ZEX：影视库 + 统计 + UI 状态，去游戏/音乐/托盘/品牌/隐藏库）。

import { create } from 'zustand';
import type { Series, SeriesCard, SeriesDetailData, Stats } from '../types';
import * as api from '../api';

interface AppState {
  // ─── Data ───────────────────────────────
  series: SeriesCard[];
  stats: Stats | null;
  selectedSeriesId: string | null;

  // ─── UI State ───────────────────────────
  activeView: 'series' | 'stats' | 'settings';
  // 元数据抓取进度（全局，跨视图保留）：切视图再回来面板不丢、防二次触发
  metadataFetchingTitle: string | null;
  fetchPct: number;
  /** 观看/元数据在视图之外被改动（回执弹窗标记、刮削完成）时自增；
   *  开着的详情页据此就地重拉（它自己的 app-resumed 刷新早于回执标记） */
  dataVersion: number;
  /** 详情预取缓存：焦点停在海报上时后台拉好季/集，打开详情即时出（stale-while-revalidate） */
  detailCache: Record<string, SeriesDetailData>;
  /** 影视库 Hero 与详情页共用的背景图：焦点海报/打开的剧集驱动。进详情时同一张
   *  图原地露出整幅（主页只在 Hero 条带露出），不重新加载、不切换、不跳位 */
  stageBackdrop: { src: string; poster: boolean };
  /** 影视详情页是否打开：打开时顶部导航要隐藏（详情全屏沉浸、盖住导航） */
  seriesDetailOpen: boolean;
  /** 隐藏左上角 Logo 与「ZEX」名称（设置开关，持久化到 hide_brand）：开了导航移到最左 */
  hideBrand: boolean;

  // ─── Actions ────────────────────────────
  loadSeries: () => Promise<void>;
  loadStats: () => Promise<void>;
  bumpData: () => void;
  prefetchDetail: (id: string) => Promise<void>;
  fetchDetail: (id: string, fresh?: boolean) => Promise<SeriesDetailData>;
  cacheDetail: (id: string, detail: SeriesDetailData) => void;

  setActiveView: (view: AppState['activeView']) => void;
  setMetadataFetching: (title: string | null) => void;
  setFetchPct: (p: number) => void;
  setSelectedSeriesId: (id: string | null) => void;
  setStageBackdrop: (b: { src: string; poster: boolean }) => void;
  setSeriesDetailOpen: (v: boolean) => void;
  setHideBrand: (v: boolean) => void;
  loadHideBrand: () => Promise<void>;

  createSeries: (series: Omit<Series, 'id' | 'created_at' | 'updated_at'>) => Promise<Series>;
  updateSeries: (id: string, patch: Partial<Series>) => Promise<void>;
  toggleSeriesFavorite: (id: string) => Promise<void>;
  deleteSeries: (id: string) => Promise<void>;

  updateWatchProgress: (episodeId: string, watchedMs: number) => Promise<void>;
}

const detailInFlight = new Map<string, Promise<SeriesDetailData>>();

export const useAppStore = create<AppState>((set, get) => ({
  // ─── Initial ──────────────────────────
  series: [],
  stats: null,
  selectedSeriesId: null,

  activeView: 'series',
  metadataFetchingTitle: null,
  fetchPct: 0,
  dataVersion: 0,
  detailCache: {},
  stageBackdrop: { src: '', poster: false },
  seriesDetailOpen: false,
  hideBrand: false,

  // ─── Actions ────────────────────────────
  loadSeries: async () => {
    const series = await api.getSeriesLibrary();
    set({ series });
  },

  loadStats: async () => {
    const stats = await api.getStats();
    set({ stats });
  },

  bumpData: () => {
    detailInFlight.clear();
    set((s) => ({ dataVersion: s.dataVersion + 1, detailCache: {} }));
  },

  cacheDetail: (id, detail) => set((s) => ({ detailCache: { ...s.detailCache, [id]: detail } })),
  fetchDetail: (id, fresh = false) => {
    if (!fresh) {
      const cached = get().detailCache[id];
      if (cached) return Promise.resolve(cached);
      const pending = detailInFlight.get(id);
      if (pending) return pending;
    }
    const version = get().dataVersion;
    const task = api.getSeriesDetail(id).then((detail) => {
      if (version !== get().dataVersion || detailInFlight.get(id) !== task) {
        throw new Error('Detail request superseded');
      }
      set((s) => ({ detailCache: { ...s.detailCache, [id]: detail } }));
      return detail;
    }).finally(() => {
      if (detailInFlight.get(id) === task) detailInFlight.delete(id);
    });
    detailInFlight.set(id, task);
    return task;
  },
  prefetchDetail: async (id) => {
    if (!id) return;
    try { await get().fetchDetail(id); }
    catch { /* 预取失败静默，点击后可重试 */ }
  },

  setActiveView: (activeView) => set({ activeView }),
  setMetadataFetching: (metadataFetchingTitle) => set({ metadataFetchingTitle }),
  setFetchPct: (fetchPct) => set({ fetchPct }),
  setSelectedSeriesId: (selectedSeriesId) => set({ selectedSeriesId }),
  // 相同值不触发订阅者重渲染（焦点在同一张海报上反复 set 时）
  setStageBackdrop: (b) =>
    set((s) => (s.stageBackdrop.src === b.src && s.stageBackdrop.poster === b.poster ? s : { stageBackdrop: b })),
  setSeriesDetailOpen: (v) => set((s) => (s.seriesDetailOpen === v ? s : { seriesDetailOpen: v })),
  setHideBrand: (v) => {
    set({ hideBrand: v });
    void api.setSetting('hide_brand', v ? '1' : '0').catch(() => {});
  },
  loadHideBrand: async () => {
    try { const v = await api.getSetting('hide_brand'); set({ hideBrand: v === '1' }); } catch { /* 读失败保持默认 false */ }
  },

  createSeries: async (series) => {
    const created = await api.createSeries(series);
    set((s) => ({
      series: [
        ...s.series,
        { ...created, season_count: 0, episode_count: 0, watched_count: 0, local_count: 0, last_watched_at: '', next_episode: null },
      ],
    }));
    return created;
  },

  updateSeries: async (id, patch) => {
    const current = get().series.find((s) => s.id === id);
    if (!current) return;
    await api.updateSeries({ ...current, ...patch });
    set((s) => ({
      series: s.series.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));
  },

  toggleSeriesFavorite: async (id) => {
    const current = get().series.find((s) => s.id === id);
    if (!current) return;
    const next = !current.favorite;
    set((s) => ({ series: s.series.map((x) => (x.id === id ? { ...x, favorite: next } : x)) }));
    try {
      await api.setSeriesFavorite(id, next);
    } catch (err) {
      set((s) => ({ series: s.series.map((x) => (x.id === id ? { ...x, favorite: !next } : x)) }));
      throw err;
    }
  },

  deleteSeries: async (id) => {
    await api.deleteSeries(id);
    detailInFlight.delete(id);
    set((s) => { const detailCache = { ...s.detailCache }; delete detailCache[id]; return { series: s.series.filter((x) => x.id !== id), selectedSeriesId: null, detailCache }; });
  },

  updateWatchProgress: async (episodeId, watchedMs) => {
    await api.updateWatchProgress(episodeId, watchedMs);
  },
}));
