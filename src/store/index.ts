// 电视版 store（裁剪自 ZEX：影视库 + 统计 + UI 状态，去游戏/音乐/托盘/品牌/隐藏库）。

import { create } from 'zustand';
import type { Series, SeriesCard, Stats } from '../types';
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

  // ─── Actions ────────────────────────────
  loadSeries: () => Promise<void>;
  loadStats: () => Promise<void>;

  setActiveView: (view: AppState['activeView']) => void;
  setMetadataFetching: (title: string | null) => void;
  setFetchPct: (p: number) => void;
  setSelectedSeriesId: (id: string | null) => void;

  createSeries: (series: Omit<Series, 'id' | 'created_at' | 'updated_at'>) => Promise<Series>;
  updateSeries: (id: string, patch: Partial<Series>) => Promise<void>;
  toggleSeriesFavorite: (id: string) => Promise<void>;
  deleteSeries: (id: string) => Promise<void>;

  updateWatchProgress: (episodeId: string, watchedMs: number) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  // ─── Initial ──────────────────────────
  series: [],
  stats: null,
  selectedSeriesId: null,

  activeView: 'series',
  metadataFetchingTitle: null,
  fetchPct: 0,

  // ─── Actions ────────────────────────────
  loadSeries: async () => {
    const series = await api.getSeriesLibrary();
    set({ series });
  },

  loadStats: async () => {
    const stats = await api.getStats();
    set({ stats });
  },

  setActiveView: (activeView) => set({ activeView }),
  setMetadataFetching: (metadataFetchingTitle) => set({ metadataFetchingTitle }),
  setFetchPct: (fetchPct) => set({ fetchPct }),
  setSelectedSeriesId: (selectedSeriesId) => set({ selectedSeriesId }),

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
    set((s) => ({ series: s.series.filter((x) => x.id !== id), selectedSeriesId: null }));
  },

  updateWatchProgress: async (episodeId, watchedMs) => {
    await api.updateWatchProgress(episodeId, watchedMs);
  },
}));
