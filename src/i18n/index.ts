// 电视版 i18n（裁剪自 ZEX：去掉 music/games/disk/tray/lyrics，只留 common/series/stats/settings/tmdb）

import { useSyncExternalStore } from 'react';
import * as api from '../api';

export type Lang = 'zh' | 'en';
const LS_KEY = 'zex-tv-lang';

export const LANGUAGES: Array<{ code: Lang; label: string }> = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
];

function readInitialLang(): Lang {
  try {
    return window.localStorage.getItem(LS_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

let currentLang: Lang = readInitialLang();
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getLang(): Lang {
  return currentLang;
}

// 切语言：立即生效 + 落库落镜像（电视版数据库是权威，localStorage 供首帧同步）
export function setLang(l: Lang) {
  if (l === currentLang) return;
  currentLang = l;
  try { window.localStorage.setItem(LS_KEY, l); } catch { /* 隐私模式写不进 */ }
  void api.setSetting('language', l).catch(() => {});
  emit();
}

// 启动时按数据库校正（数据库权威；localStorage 镜像缺失/过期时纠偏）
export async function initLang() {
  const v = await api.getSetting('language').catch(() => null);
  if (v !== 'en' && v !== 'zh') return;
  if (v === currentLang) return;
  currentLang = v;
  try { window.localStorage.setItem(LS_KEY, v); } catch { /* ignore */ }
  emit();
}

// ── 词典 ──────────────────────────────────────────────────

const zh: Record<string, string> = {
  // 导航
  'nav.series': '影视库',
  'nav.stats': '统计',
  'nav.settings': '设置',

  // 通用
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.delete': '删除',
  'common.close': '关闭',
  'common.save': '保存',
  'common.saving': '保存中...',
  'common.error': '错误',
  'common.tip': '提示',
  'common.yes': '是',
  'common.no': '否',
  'common.loading': '加载中...',
  'common.retry': '重试',
  'common.on': '开',
  'common.off': '关',
  'common.all': '全部',
  'common.done': '完成',
  'common.back': '返回',
  'common.duration.seconds': '{n} 秒',
  'common.duration.minutes': '{n} 分钟',
  'common.duration.hours': '{n} 小时',
  'common.duration.hoursMinutes': '{h} 小时 {m} 分',
  'common.duration.underMinute': '不到 1 分钟',
  'common.duration.zero': '0 分钟',
  'common.episodeN': '第 {n} 集',
  'common.saveFailed': '保存失败: {msg}',

  // 影视库
  'series.unfinished': '未看完',
  'series.finished': '已看完',
  'series.favorite': '收藏',
  'series.sortCustom': '自定义',
  'series.sortRecent': '最近观看',
  'series.sortAdded': '最近添加',
  'series.sortTitle': '名称',
  'series.sortRating': '评分',
  'series.emptyTitle': '影视库还是空的',
  'series.emptyDesc': '添加一台 NAS，选个文件夹就能自动扫描并刮削',
  'series.addSeries': '添加影视',
  'series.searchPlaceholder': '搜索剧名、原名或类型',
  'series.noMatch': '没有匹配的影视',
  'series.noInfo': '未获取信息',
  'series.movie': '电影',
  'series.watched': '已看过',
  'series.seasonCount': '{n} 季',
  'series.episodeCount': '{n} 集',
  'series.watchedCount': '已看 {watched}/{total}',
  'series.watchedTotal': '已看 {time}',
  'series.seasonN': '第 {n} 季',
  'series.playMovie': '播放电影',
  'series.viewDetail': '查看详情',
  'series.continueWatching': '继续观看',
  'series.startWatching': '开始观看',
  'series.episodeDetails': '剧集详情',
  'series.playEp': '播放 {se}',
  'series.replay': '重新播放',
  'series.allWatched': '全部看完了',
  'series.favorited': '已收藏',
  'series.unfavorite': '取消收藏',
  'series.cannotPlay': '无法播放',
  'series.epNoFile': '该集还没有关联本地视频文件',
  'series.playFailed': '播放失败：{msg}',
  'series.deleteSeries': '删除影视',
  'series.deleteConfirm': '确定删除《{title}》吗？该剧的季、集与观看记录会一并删除。',
  'series.fetchMeta': '获取元数据',
  'series.fetchFailed': '获取失败：{msg}',
  'series.fetchingMeta': '正在获取《{title}》',
  'series.tmdbNotFound': 'TMDB 上没有找到「{title}」，可以改名后重试',
  'series.tmdbNotFoundTitle': '未找到',
  'series.searchFailed': '搜索失败：{msg}',
  'series.refreshLibrary': '刷新影视库',
  'series.loadFailed': '加载失败：{msg}',
  'series.loading': '加载中…',
  'series.markFailed': '标记失败：{msg}',
  'series.opFailed': '操作失败：{msg}',
  'series.favoriteFailed': '收藏失败：{msg}',
  'series.noOverview': '还没有剧情简介，可在详情页获取元数据。',
  'series.seasonDoneTitle': '整季已看完',
  'series.markSeasonWatched': '整季标记已看',
  'series.resetSeason': '整季重置',
  'series.epNoLocalFile': '未关联本地文件',
  'series.play': '播放',
  'series.epNoFileShort': '未关联视频文件',
  'series.markUnwatched': '标记为未看',
  'series.markWatched': '标记为已看',
  'series.seasonsTitle': '季',
  'series.epListTitle': '剧集',
  'series.noEpMovie': '该电影还没有关联视频文件',
  'series.noEpSeason': '该季没有剧集',
  'series.epNoFileThis': '该集还没有关联本地视频文件',
  'series.epActionsTitle': '本集操作',
  'series.seasonActionsTitle': '本季操作',
  'series.hintEpsKeys': 'OK 播放 · 长按 OK 更多',

  // 统计
  'stats.video': '影视',
  'stats.unitVideo': '部',
  'stats.watchedEpisodes': '已看 {watched}/{total} 集',
  'stats.noRecords': '还没有记录',
  'stats.loadFailed': '统计数据读取失败',
  'stats.loading': '正在统计…',
  'stats.emptyTitle': '还没有任何记录',
  'stats.emptyDesc': '看一集剧，这里就会开始记录你的时间。',
  'stats.notPlayed': '未观看',
  'stats.totalEpisodes': '共 {n} 集',
  'stats.watchedEpisodesTotal': '已看 {n} 集',

  // TMDB 消歧
  'misc.tmdbPickTitle': '选择正确的条目',
  'misc.tmdbPickDesc': '「{title}」有 {n} 个同名/相近结果，选中的那条会用于获取简介、评分和剧照',
  'misc.tmdbNoOverview': '（该条目暂无简介）',

  // 设置
  'settings.tmdb': 'TMDB 元数据',
  'settings.tmdbApiKey': 'API Key',
  'settings.tmdbApiKeyHint': '在 themoviedb.org 注册免费获取，用于影视刮削',
  'settings.tmdbApiKeyPlaceholder': '粘贴 TMDB API Key',
  'settings.proxy': '网络代理',
  'settings.proxyHint': 'TMDB 需要代理访问时填写，如 http://192.168.1.1:7890',
  'settings.proxyPlaceholder': 'http://host:port',
  'settings.nasServers': 'NAS 服务器',
  'settings.addNas': '添加 NAS',
  'settings.editNas': '编辑',
  'settings.nasName': '名称',
  'settings.nasHost': '地址（IP 或主机名）',
  'settings.nasPort': '端口',
  'settings.nasUser': '用户名',
  'settings.nasPassword': '密码',
  'settings.nasPasswordKeep': '不修改密码请留空',
  'settings.nasTestOk': '连接成功，发现 {n} 个共享',
  'settings.nasTestFail': '连接失败：{msg}',
  'settings.nasTesting': '测试中…',
  'settings.nasSaved': '已保存',
  'settings.nasNoServers': '还没有添加 NAS 服务器',
  'settings.language': '语言',
  'settings.about': '关于',
  'settings.version': '版本',
  'settings.data': '数据',
  'settings.clearAll': '清除所有影视数据',
  'settings.clearAllHint': '删除全部影视、季集与观看记录（保留 API Key、代理、NAS 配置）',
  'settings.clearAllConfirm': '确定清除全部 {n} 部影视吗？季集和观看记录会一并删除，此操作不可撤销。API Key、代理和 NAS 配置会保留。',
  'settings.clearAllEmpty': '影视库本来就是空的',
  'settings.clearAllDone': '已清除 {n} 部影视',
  'settings.clearing': '正在清除…',
  'settings.clearFailed': '清除失败：{msg}',

  // 全自动添加（M2）
  'add.title': '添加影视',
  'add.pickNas': '选择 NAS 服务器',
  'add.pickShare': '选择共享',
  'add.pickFolder': '选择影视文件夹',
  'add.pickFolderHint': '按 OK 直接添加，自动识别剧集/电影并刮削',
  'add.seriesName': '影视名称（留空用文件夹名）',
  'add.mediaType': '类型',
  'add.tv': '剧集',
  'add.movie': '电影',
  'add.scanning': '正在扫描…',
  'add.scanningFolder': '正在扫描《{title}》…',
  'add.addingFolder': '正在添加《{title}》',
  'add.fetchingFolder': '正在刮削《{title}》…',
  'add.foundN': '已发现 {n} 个视频文件',
  'add.fetching': '正在刮削…',
  'add.done': '添加完成',
  'add.doneTitle': '《{title}》已添加',
  'add.noFolders': '该共享下没有文件夹',
  'add.noServers': '请先在设置页添加 NAS',
  'add.failed': '添加失败：{msg}',
  'add.emptyFolder': '该文件夹没有发现视频文件',

  // 播放回执（M3）
  'play.watchedPrompt': '看完了吗？',
  'play.watchedYes': '看完了',
  'play.watchedNo': '没看完',
  'play.opening': '正在唤起播放器…',
};

const en: Record<string, string> = {
  'nav.series': 'Series',
  'nav.stats': 'Stats',
  'nav.settings': 'Settings',

  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.delete': 'Delete',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.saving': 'Saving...',
  'common.error': 'Error',
  'common.tip': 'Notice',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.loading': 'Loading...',
  'common.retry': 'Retry',
  'common.on': 'On',
  'common.off': 'Off',
  'common.all': 'All',
  'common.done': 'Done',
  'common.back': 'Back',
  'common.duration.seconds': '{n}s',
  'common.duration.minutes': '{n} min',
  'common.duration.hours': '{n} hr',
  'common.duration.hoursMinutes': '{h} hr {m} min',
  'common.duration.underMinute': 'Under 1 minute',
  'common.duration.zero': '0 min',
  'common.episodeN': 'Episode {n}',
  'common.saveFailed': 'Save failed: {msg}',

  'series.unfinished': 'Not finished',
  'series.finished': 'Finished',
  'series.favorite': 'Favorites',
  'series.sortCustom': 'Custom',
  'series.sortRecent': 'Recently watched',
  'series.sortAdded': 'Recently added',
  'series.sortTitle': 'Title',
  'series.sortRating': 'Rating',
  'series.emptyTitle': 'The series library is empty',
  'series.emptyDesc': 'Add a NAS, pick a folder — scanning and scraping happen automatically',
  'series.addSeries': 'Add series',
  'series.searchPlaceholder': 'Search title, original title or genre',
  'series.noMatch': 'No matching series',
  'series.noInfo': 'No info yet',
  'series.movie': 'Movie',
  'series.watched': 'Watched',
  'series.seasonCount': '{n} seasons',
  'series.episodeCount': '{n} episodes',
  'series.watchedCount': 'Watched {watched}/{total}',
  'series.watchedTotal': 'Watched {time}',
  'series.seasonN': 'Season {n}',
  'series.playMovie': 'Play movie',
  'series.viewDetail': 'View details',
  'series.continueWatching': 'Continue watching',
  'series.startWatching': 'Start watching',
  'series.episodeDetails': 'Episode details',
  'series.playEp': 'Play {se}',
  'series.replay': 'Play again',
  'series.allWatched': 'All watched',
  'series.favorited': 'Favorited',
  'series.unfavorite': 'Unfavorite',
  'series.cannotPlay': 'Cannot play',
  'series.epNoFile': 'This episode has no local video file yet',
  'series.playFailed': 'Playback failed: {msg}',
  'series.deleteSeries': 'Delete series',
  'series.deleteConfirm': 'Delete "{title}"? Its seasons, episodes and watch history will be deleted too.',
  'series.fetchMeta': 'Fetch metadata',
  'series.fetchFailed': 'Fetch failed: {msg}',
  'series.fetchingMeta': 'Fetching "{title}"',
  'series.tmdbNotFound': '"{title}" was not found on TMDB; try renaming it and retry',
  'series.tmdbNotFoundTitle': 'Not found',
  'series.searchFailed': 'Search failed: {msg}',
  'series.refreshLibrary': 'Refresh library',
  'series.loadFailed': 'Load failed: {msg}',
  'series.loading': 'Loading…',
  'series.markFailed': 'Mark failed: {msg}',
  'series.opFailed': 'Operation failed: {msg}',
  'series.favoriteFailed': 'Favorite failed: {msg}',
  'series.noOverview': 'No synopsis yet — fetch metadata on the detail page.',
  'series.seasonDoneTitle': 'Season fully watched',
  'series.markSeasonWatched': 'Mark whole season watched',
  'series.resetSeason': 'Reset season',
  'series.epNoLocalFile': 'No local file',
  'series.play': 'Play',
  'series.epNoFileShort': 'No video file',
  'series.markUnwatched': 'Mark as unwatched',
  'series.markWatched': 'Mark as watched',
  'series.seasonsTitle': 'Seasons',
  'series.epListTitle': 'Episodes',
  'series.noEpMovie': 'No video file linked to this movie yet',
  'series.noEpSeason': 'No episodes in this season',
  'series.epNoFileThis': 'This episode has no local video file yet',
  'series.epActionsTitle': 'Episode actions',
  'series.seasonActionsTitle': 'Season actions',
  'series.hintEpsKeys': 'OK to play · hold OK for more',

  'stats.video': 'Series',
  'stats.unitVideo': 'series',
  'stats.watchedEpisodes': 'Watched {watched}/{total} episodes',
  'stats.noRecords': 'No records yet',
  'stats.loadFailed': 'Failed to read stats',
  'stats.loading': 'Calculating…',
  'stats.emptyTitle': 'No records yet',
  'stats.emptyDesc': 'Watch an episode — your time will start being recorded here.',
  'stats.notPlayed': 'Not watched',
  'stats.totalEpisodes': '{n} episodes',
  'stats.watchedEpisodesTotal': 'Watched {n} episodes',

  'misc.tmdbPickTitle': 'Choose the right entry',
  'misc.tmdbPickDesc': '"{title}" has {n} same-named or similar results; the one you pick is used for the synopsis, rating and stills',
  'misc.tmdbNoOverview': '(No synopsis for this entry)',

  'settings.tmdb': 'TMDB metadata',
  'settings.tmdbApiKey': 'API Key',
  'settings.tmdbApiKeyHint': 'Get one free at themoviedb.org — used for series scraping',
  'settings.tmdbApiKeyPlaceholder': 'Paste TMDB API Key',
  'settings.proxy': 'Network proxy',
  'settings.proxyHint': 'Fill in if TMDB needs a proxy, e.g. http://192.168.1.1:7890',
  'settings.proxyPlaceholder': 'http://host:port',
  'settings.nasServers': 'NAS servers',
  'settings.addNas': 'Add NAS',
  'settings.editNas': 'Edit',
  'settings.nasName': 'Name',
  'settings.nasHost': 'Address (IP or hostname)',
  'settings.nasPort': 'Port',
  'settings.nasUser': 'Username',
  'settings.nasPassword': 'Password',
  'settings.nasPasswordKeep': 'Leave empty to keep the current password',
  'settings.nasTestOk': 'Connected — {n} shares found',
  'settings.nasTestFail': 'Connection failed: {msg}',
  'settings.nasTesting': 'Testing…',
  'settings.nasSaved': 'Saved',
  'settings.nasNoServers': 'No NAS servers added yet',
  'settings.language': 'Language',
  'settings.about': 'About',
  'settings.version': 'Version',
  'settings.data': 'Data',
  'settings.clearAll': 'Clear all media data',
  'settings.clearAllHint': 'Deletes every series, season, episode and watch record (keeps API key, proxy and NAS settings)',
  'settings.clearAllConfirm': 'Clear all {n} series? Seasons, episodes and watch history will be deleted too — this cannot be undone. Your API key, proxy and NAS settings are kept.',
  'settings.clearAllEmpty': 'The library is already empty',
  'settings.clearAllDone': 'Cleared {n} series',
  'settings.clearing': 'Clearing…',
  'settings.clearFailed': 'Clear failed: {msg}',

  'add.title': 'Add series',
  'add.pickNas': 'Choose a NAS server',
  'add.pickShare': 'Choose a share',
  'add.pickFolder': 'Choose a series folder',
  'add.pickFolderHint': 'Press OK to add — type is detected and metadata scraped automatically',
  'add.seriesName': 'Series name (leave empty to use the folder name)',
  'add.mediaType': 'Type',
  'add.tv': 'TV',
  'add.movie': 'Movie',
  'add.scanning': 'Scanning…',
  'add.scanningFolder': 'Scanning “{title}”…',
  'add.addingFolder': 'Adding “{title}”',
  'add.fetchingFolder': 'Scraping “{title}”…',
  'add.foundN': '{n} video files found',
  'add.fetching': 'Scraping…',
  'add.done': 'Added',
  'add.doneTitle': '“{title}” added',
  'add.noFolders': 'No folders in this share',
  'add.noServers': 'Add a NAS in Settings first',
  'add.failed': 'Add failed: {msg}',
  'add.emptyFolder': 'No video files found in this folder',

  'play.watchedPrompt': 'Finished watching?',
  'play.watchedYes': 'Yes, finished',
  'play.watchedNo': 'Not yet',
  'play.opening': 'Launching player…',
};

const DICTS: Record<Lang, Record<string, string>> = { zh, en };

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[currentLang][key] ?? DICTS.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

export function useT(): typeof t {
  useSyncExternalStore(subscribe, () => currentLang);
  return t;
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, () => currentLang);
}
