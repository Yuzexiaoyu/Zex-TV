// 影视库电视版类型（裁剪自 ZEX：只留影视相关，去 Game/Track/Playlist/Disk）

export interface Series {
  id: string;
  title: string;
  aliases: string;
  overview: string;
  poster_path: string;
  bg_path: string;
  first_air_date: string;
  status: string;
  tmdb_id: number;
  tvdb_id: number;
  tags: string;
  favorite: boolean;
  vote_average: number;
  genres: string;
  sort_order?: number;
  media_type: MediaType;
  total_seconds: number;
  created_at: string;
  updated_at: string;
}

export type MediaType = 'tv' | 'movie';

export interface TmdbSearchResult {
  id: number;
  name: string;
  original_name: string;
  overview: string;
  date: string;
  poster_url: string;
  vote_average: number;
}

export interface NextEpisode {
  id: string;
  season_id: string;
  season_number: number;
  episode_number: number;
  title: string;
  still_path: string;
  local_path: string;
  runtime_minutes: number;
  watched_ms: number;
}

export interface SeriesCard extends Series {
  season_count: number;
  episode_count: number;
  watched_count: number;
  local_count: number;
  last_watched_at: string;
  next_episode: NextEpisode | null;
}

export interface SeasonWithEpisodes extends Season {
  episodes: Episode[];
}

export interface SeriesDetailData extends Series {
  seasons: SeasonWithEpisodes[];
  next_episode: NextEpisode | null;
  episode_count: number;
  watched_count: number;
}

export interface Season {
  id: string;
  series_id: string;
  season_number: number;
  name: string;
  overview: string;
  poster_path: string;
  first_air_date: string;
}

export interface Episode {
  id: string;
  series_id: string;
  season_id: string;
  episode_number: number;
  title: string;
  overview: string;
  still_path: string;
  air_date: string;
  runtime_minutes: number;
  local_path: string;
  watched_ms: number;
  last_watched_at: string;
  watched: boolean;
  vote_average: number;
}

// 统计页条目
export interface TopEntry {
  id: string;
  name: string;
  sub: string;
  cover_path: string;
  wide_path: string;
  seconds: number;
  count: number;
}

// 电视版只有影视一类媒体
export interface MediaStats {
  total_seconds: number;
  play_count: number;
  library_count: number;
  played_count: number;
  top: TopEntry[];
}

export interface Stats {
  video: MediaStats;
  total_episodes: number;
  total_watched_episodes: number;
}

// SMB 服务器（电视版 NAS 片源）
export interface SmbServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  created_at: string;
}

// SMB 共享枚举（list_shares）
export interface SmbShareInfo {
  name: string;
  comment: string;
}

// SMB 目录条目（list_directory）
export interface SmbDirEntry {
  name: string;
  size: number;
  is_directory: boolean;
  created: string;
  modified: string;
}
