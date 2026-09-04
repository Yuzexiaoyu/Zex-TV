// 电视版 API（裁剪自 ZEX：影视 CRUD/进度/统计/设置 + SMB 服务器管理）。
// 参数名按 Tauri 约定自动转 camelCase（tauri::command 反序列化时 snake→camel）。

import { invoke } from '@tauri-apps/api/core';
import type {
  Series, Season, Episode, Stats, SeriesCard, SeriesDetailData,
  MediaType, TmdbSearchResult, SmbServer, SmbShareInfo, SmbDirEntry,
} from '../types';

// ─── Series ────────────────────────────────

export async function getSeriesLibrary(): Promise<SeriesCard[]> {
  return invoke('get_series_library');
}

export async function getSeriesDetail(seriesId: string): Promise<SeriesDetailData> {
  return invoke('get_series_detail', { seriesId });
}

export async function createSeries(series: Omit<Series, 'id' | 'created_at' | 'updated_at'>): Promise<Series> {
  return invoke('create_series', { series });
}

export async function updateSeries(series: Series): Promise<Series> {
  return invoke('update_series', { series });
}

export async function setSeriesFavorite(seriesId: string, favorite: boolean): Promise<void> {
  return invoke('set_series_favorite', { seriesId, favorite });
}

export async function reorderSeries(orderedIds: string[]): Promise<void> {
  return invoke('reorder_series', { orderedIds });
}

export async function deleteSeries(id: string): Promise<void> {
  return invoke('delete_series', { id });
}

// 清除所有影视数据（series/seasons/episodes + 封面图），保留 TMDB Key/代理/语言/NAS 配置。
// 返回删掉的剧数
export async function clearAllMedia(): Promise<number> {
  return invoke('clear_all_media');
}

// tmdbId：用户在候选里选定的条目（同名作品消歧）；M2 启用
export async function autoFetchSeriesMetadata(seriesId: string, tmdbId?: number): Promise<string> {
  return invoke('auto_fetch_series_metadata', { seriesId, tmdbId: tmdbId ?? null });
}

export async function searchTmdb(query: string, mediaType: MediaType): Promise<TmdbSearchResult[]> {
  return invoke('search_tmdb', { query, mediaType });
}

// ─── Seasons / Episodes ────────────────────

export async function getSeasons(seriesId: string): Promise<Season[]> {
  return invoke('get_seasons', { seriesId });
}

export async function createSeason(season: Omit<Season, 'id'>): Promise<Season> {
  return invoke('create_season', { season });
}

export async function deleteSeason(id: string): Promise<void> {
  return invoke('delete_season', { id });
}

export async function getEpisodes(seasonId: string): Promise<Episode[]> {
  return invoke('get_episodes', { seasonId });
}

export async function createEpisode(episode: Omit<Episode, 'id'>): Promise<Episode> {
  return invoke('create_episode', { episode });
}

export async function updateEpisode(episode: Episode): Promise<Episode> {
  return invoke('update_episode', { episode });
}

export async function deleteEpisode(id: string): Promise<void> {
  return invoke('delete_episode', { id });
}

export async function updateWatchProgress(episodeId: string, watchedMs: number): Promise<void> {
  return invoke('update_watch_progress', { episodeId, watchedMs });
}

export async function markEpisodeWatched(episodeId: string, watched: boolean): Promise<void> {
  return invoke('mark_episode_watched', { episodeId, watched });
}

export async function markSeasonWatched(seasonId: string, watched: boolean): Promise<void> {
  return invoke('mark_season_watched', { seasonId, watched });
}

export async function touchEpisodePlayed(episodeId: string): Promise<void> {
  return invoke('touch_episode_played', { episodeId });
}

// ─── Stats ────────────────────────────────

export async function getStats(): Promise<Stats> {
  return invoke('get_stats');
}

// ─── Settings ─────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  return invoke('get_setting', { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke('set_setting', { key, value });
}

// ─── SMB Servers ───────────────────────────

export async function getSmbServers(): Promise<SmbServer[]> {
  return invoke('get_smb_servers');
}

export async function saveSmbServer(server: SmbServer): Promise<SmbServer> {
  return invoke('save_smb_server', { server });
}

export async function deleteSmbServer(id: string): Promise<void> {
  return invoke('delete_smb_server', { id });
}

// ─── SMB 浏览（M2 启用） ────────────────────

// 列出某服务器的共享（list_shares）
export async function listSmbShares(serverId: string): Promise<SmbShareInfo[]> {
  return invoke('list_smb_shares', { serverId });
}

// 列出某共享下某路径的目录条目（list_directory）。path 为空 = 共享根
export async function listSmbDir(serverId: string, share: string, path: string): Promise<SmbDirEntry[]> {
  return invoke('list_smb_dir', { serverId, share, path });
}

// 全自动添加：扫描 SMB 文件夹 → 解析季集 → 建剧/季/集 → TMDB 刮削（M2 启用）
export interface AddSeriesBySmbArgs {
  serverId: string;
  share: string;
  path: string;       // 剧根目录相对路径
  title: string;      // 剧名（空 = 用文件夹名，后端清洗年份/分辨率等噪声）
  // 'auto' = 后端按扫到的视频文件数判定（1 个 = 电影，多个 = 剧集）
  mediaType: MediaType | 'auto';
}
export async function addSeriesBySmb(args: AddSeriesBySmbArgs): Promise<Series> {
  return invoke('add_series_by_smb', { args });
}

// ─── App ───────────────────────────────────

export async function getVersion(): Promise<string> {
  return invoke('get_version');
}

// M3 启用：用 opener 拉起系统播放器播本地 HTTP 流
export async function playEpisode(episodeId: string): Promise<void> {
  return invoke('play_episode', { episodeId });
}

// App 回前台时查询：有没有待回执的播放会话（看完了吗弹窗）。
// 有 → 返回 episode id 并清空（一次回执）；无 → null
export async function takeCurrentEpisode(): Promise<string | null> {
  return invoke('take_current_episode');
}
