// ZEX TV 主框架：顶部导航（影视库/统计/设置）+ 内容区。
// 输入：遥控器方向键 → focus 栈移动，OK → confirm，Back → back（service.ts 注入）。
// 砍掉桌面版的：窗口控制按钮、托盘、音乐播放条、隐藏库、品牌自定义、鼠标模式检测。

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from './store';
import * as api from './api';
import SeriesView from './views/SeriesView';
import StatsView from './views/StatsView';
import SettingsView from './views/SettingsView';
import WatchedPromptModal from './components/WatchedPromptModal';
import StageBackdrop from './components/StageBackdrop';
import zexLogo from './assets/zex-logo.png';
import { Film, BarChart3, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import {
  startGamepad, useFocusStore, useFocusIndex, useGamepadFocus, useGamepadGroup,
} from './gamepad';
import { initLang, useT } from './i18n';

type View = 'series' | 'stats' | 'settings';

const navItems = [
  { id: 'series' as const, label: 'nav.series', icon: Film },
  { id: 'stats' as const, label: 'nav.stats', icon: BarChart3 },
  { id: 'settings' as const, label: 'nav.settings', icon: Settings },
];

// 各视图内容区的焦点组（视图切换时把焦点落进对应内容）
const VIEW_GROUP: Record<View, string> = {
  series: 'grid:series',
  stats: 'stats:col:video',
  settings: 'settings:nas',
};

// 视图在顶部导航里的序号（空库时焦点落「当前页」的导航项，不是固定第 0 项）
const VIEW_NAV_INDEX: Record<View, number> = { series: 0, stats: 1, settings: 2 };

function NavPill({ label, icon: Icon, index, active, onClick }: {
  label: string; icon: typeof Film; index: number; active: boolean; onClick: () => void;
}) {
  const focused = useGamepadFocus('nav', index);
  return (
    <button
      onClick={onClick}
      className={clsx('nav-pill', active && 'active', focused && 'gamepad-focus')}
    >
      <Icon size={22} />
      <span>{label}</span>
    </button>
  );
}

export default function App() {
  const t = useT();
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const seriesDetailOpen = useAppStore((s) => s.seriesDetailOpen);
  const hideBrand = useAppStore((s) => s.hideBrand);
  const loadHideBrand = useAppStore((s) => s.loadHideBrand);
  const [watchedEpisode, setWatchedEpisode] = useState<string | null>(null);

  const groupOf = (v: View) => VIEW_GROUP[v];

  // 启动：挂载遥控器键盘输入 + 校正语言
  useEffect(() => {
    startGamepad();
    void initLang();
    void loadHideBrand();
  }, [loadHideBrand]);

  // 启动预加载：影视库 + 统计常驻 store，切页不闪空。
  // 加载完成后若还停在初始视图且内容为空，把焦点校正到导航上当前视图那一项
  useEffect(() => {
    const store = useAppStore.getState();
    void Promise.all([store.loadSeries(), store.loadStats()]).catch(() => {}).finally(() => {
      const s = useAppStore.getState();
      if (s.activeView === 'series' && s.series.length === 0) {
        useFocusStore.getState().reset('nav', VIEW_NAV_INDEX[s.activeView]);
      }
    });
  }, []);

  // 播放回执：拉起系统播放器后 App 退到后台；用户看完回到 App（Android
  // onResume → 后端 emit app-resumed）时，查一下有没有未回执的播放会话，
  // 有才弹「看完了吗」。之前 v1 是拉起播放器的瞬间就弹——弹窗出现在
  // 播放器底下没人看见，回到 App 时弹窗已经晾在那、还可能错位到别的集
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const stop = await listen<void>('app-resumed', () => {
        // 取会话（take 语义：后端清空，不会重复弹）
        void api.takeCurrentEpisode().then((episodeId) => {
          if (!cancelled && episodeId) setWatchedEpisode(episodeId);
        }).catch(() => {});
      });
      if (cancelled) stop(); else un = stop;
    })();
    return () => { cancelled = true; un?.(); };
  }, []);

  // 肃正协议合并了对端进度 → 刷新影视库与统计（详情页自己也听这个事件就地重拉）
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const stop = await listen<number>('progress-synced', () => {
        void useAppStore.getState().loadSeries().catch(() => {});
        void useAppStore.getState().loadStats().catch(() => {});
      });
      if (cancelled) stop(); else un = stop;
    })();
    return () => { cancelled = true; un?.(); };
  }, []);

  // 顶部导航注册为焦点组；焦点左右移动 = 切页面（焦点到哪页就是哪页，两者同步）；
  // 「下」进入当前视图内容
  useGamepadGroup('nav', {
    count: navItems.length,
    cols: navItems.length,
    activate: (i) => setActiveView(navItems[i].id),
    leave: (dir, index) => {
      if (dir === 'down') {
        // 不读闭包里的 activeView：用户快速「右右…下」时 setActiveView 可能还没提交，
        // 闭包是旧值 → 跳进旧视图的组；旧视图组件随后卸载、组注销 → 栈指向死组，
        // 按键全哑且无高亮。nav 索引和视图天然同步（焦点到哪页就是哪页），
        // 直接用 leave 给的 index 推导目标组，永远与焦点一致
        const view = navItems[Math.min(Math.max(index, 0), navItems.length - 1)].id;
        useFocusStore.getState().switchTo(VIEW_GROUP[view]);
        return;
      }
      // 顶部导航横向环绕（仅 3 项）：末项按右回首项、首项按左到末项——
      // 遥控器少按几下就能在两端间切换，比停在边界无反应更跟手
      if (dir === 'right') useFocusStore.getState().switchTo('nav', 0);
      else if (dir === 'left') useFocusStore.getState().switchTo('nav', navItems.length - 1);
    },
  });

  // 焦点在导航上左右移动 → 页面跟着切换（焦点和页面同时变）
  const navFocused = useFocusIndex('nav');
  useEffect(() => {
    if (navFocused >= 0 && navFocused < navItems.length && navItems[navFocused].id !== activeView) {
      setActiveView(navItems[navFocused].id);
    }
  }, [navFocused, activeView, setActiveView]);

  // 视图切换 → 焦点落进该视图内容区。
  // 例外 1：焦点本来就在导航上（左右移动切页 / OK 激活）——焦点保持在导航，
  //   不弹进内容区（「焦点移到统计，页面也同时变」）。
  // 例外 2：本页没有可聚焦项（空库），落内容组等于按键全哑，
  //   焦点给顶部导航上「当前页」那一项（不是固定第 0 项「影视库」）。
  // 例外 3：栈顶已经在目标组里（用户先按了「下」，nav 的 leave 已 switchTo 进来）
  //   —— 此时 reset 会把 switchTo 设好的 index 打回 null（待命态），高亮消失
  //   且后续按 OK 无反应；只对「焦点还在别的组」时才 reset
  useEffect(() => {
    const stack = useFocusStore.getState().stack;
    const topGroup = stack.length ? stack[stack.length - 1].group : '';
    if (topGroup === 'nav') return;
    const target = groupOf(activeView);
    if (topGroup === target) return;
    const store = useAppStore.getState();
    const empty =
      (activeView === 'series' && store.series.length === 0) ||
      (activeView === 'stats' && store.stats !== null && store.stats.video.library_count === 0);
    if (empty) {
      useFocusStore.getState().reset('nav', VIEW_NAV_INDEX[activeView]);
      return;
    }
    useFocusStore.getState().reset(target);
  }, [activeView]);

  const visibleNav = useMemo(() => navItems, []);

  // 视图 keep-alive：常驻（切页只切可见性）。条件渲染每次切页都整页卸载重建——
  // 上百张海报重新创建+解码、入场动画重放、滚动位置丢失，弱 TV 上就是「整个
  // 页面重新加载」。visibility 隐藏保留布局与 scrollTop（display:none 会丢），
  // 切回时滚动/焦点原样。layout effect 兜底：预载还没轮到就切过去时，
  // 在本帧提交前挂载，不闪一帧空白
  const [mounted, setMounted] = useState<Record<View, boolean>>({ series: true, stats: false, settings: false });
  useLayoutEffect(() => {
    if (mounted[activeView]) return;
    setMounted((m) => ({ ...m, [activeView]: true }));
  }, [activeView, mounted]);

  // 预加载：启动后错峰后台挂载统计/设置（数据本来就在启动时预取了，这里补上
  // 视图本体），用户第一次切过去就和常驻视图零差别。错开 1.5s/2.5s 是为了
  // 避开海报墙解码高峰——预载那一帧的渲染不跟用户的第一次浏览抢 CPU
  useEffect(() => {
    const ids = [
      window.setTimeout(() => setMounted((m) => ({ ...m, stats: true })), 1500),
      window.setTimeout(() => setMounted((m) => ({ ...m, settings: true })), 2500),
    ];
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, []);

  return (
    // 用 h-full/w-full 而不是 h-screen/w-screen：vh/vw 按物理视口算，
    // 但画布是 #root 那个固定尺寸的盒子（见 main.tsx），两者不一致会溢出/留白
    <div className="relative flex flex-col h-full w-full overflow-hidden">
      <div className="bg-ambient" />
      {/* 影视库共享背景层（Hero↔详情同一张图）：仅影视视图渲染，置于导航/内容之下 */}
      {activeView === 'series' && <StageBackdrop />}

      {/* 顶部导航：实色（app-header 覆盖 glass 的半透明，不让共享背景透上来）；
          进影视详情时隐藏——详情全屏沉浸要盖住导航 */}
      <header className={clsx('app-header relative z-10 shrink-0 glass border-b border-border-glass', seriesDetailOpen && 'invisible')}>
        <div className="flex items-center h-20 px-8 gap-8">
          {/* 可在设置里隐藏 Logo 与名称：隐藏后导航自然落到最左 */}
          {!hideBrand && (
            <div className="flex items-center gap-3 mr-2">
              <img
                src={zexLogo}
                alt="ZEX"
                draggable={false}
                className="w-9 h-9 object-contain shrink-0"
                style={{ filter: 'drop-shadow(0 0 5px rgba(0,212,255,0.35))' }}
              />
              <span className="text-2xl font-bold tracking-[0.2em] text-glow-accent">ZEX</span>
            </div>
          )}
          <nav className="flex items-center gap-2">
            {visibleNav.map((item, i) => (
              <NavPill
                key={item.id}
                label={t(item.label)}
                icon={item.icon}
                index={i}
                active={activeView === item.id}
                onClick={() => setActiveView(item.id)}
              />
            ))}
          </nav>
        </div>
      </header>

      {/* 内容区：三视图堆叠在槽位里常驻，见上方 keep-alive 注释 */}
      <main className="relative z-10 flex-1 min-h-0 overflow-hidden">
        <div className="relative h-full">
          <div className={clsx('view-slot', activeView !== 'series' && 'view-hidden')}>
            <SeriesView />
          </div>
          {mounted.stats && (
            <div className={clsx('view-slot', activeView !== 'stats' && 'view-hidden')}>
              <StatsView />
            </div>
          )}
          {mounted.settings && (
            <div className={clsx('view-slot', activeView !== 'settings' && 'view-hidden')}>
              <SettingsView />
            </div>
          )}
        </div>
      </main>

      {/* 播放回执弹窗 */}
      {watchedEpisode && (
        <WatchedPromptModal
          episodeId={watchedEpisode}
          onClose={() => setWatchedEpisode(null)}
        />
      )}
    </div>
  );
}
