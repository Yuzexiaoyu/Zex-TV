// ZEX TV 主框架：顶部导航（影视库/统计/设置）+ 内容区。
// 输入：遥控器方向键 → focus 栈移动，OK → confirm，Back → back（service.ts 注入）。
// 砍掉桌面版的：窗口控制按钮、托盘、音乐播放条、隐藏库、品牌自定义、鼠标模式检测。

import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from './store';
import * as api from './api';
import SeriesView from './views/SeriesView';
import StatsView from './views/StatsView';
import SettingsView from './views/SettingsView';
import WatchedPromptModal from './components/WatchedPromptModal';
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
  const [watchedEpisode, setWatchedEpisode] = useState<string | null>(null);

  const groupOf = (v: View) => VIEW_GROUP[v];

  // 启动：挂载遥控器键盘输入 + 校正语言
  useEffect(() => {
    startGamepad();
    void initLang();
  }, []);

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

  // 顶部导航注册为焦点组；焦点左右移动 = 切页面（焦点到哪页就是哪页，两者同步）；
  // 「下」进入当前视图内容
  useGamepadGroup('nav', {
    count: navItems.length,
    cols: navItems.length,
    activate: (i) => setActiveView(navItems[i].id),
    leave: (dir, index) => {
      if (dir !== 'down') return;
      // 不读闭包里的 activeView：用户快速「右右…下」时 setActiveView 可能还没提交，
      // 闭包是旧值 → 跳进旧视图的组；旧视图组件随后卸载、组注销 → 栈指向死组，
      // 按键全哑且无高亮。nav 索引和视图天然同步（焦点到哪页就是哪页），
      // 直接用 leave 给的 index 推导目标组，永远与焦点一致
      const view = navItems[Math.min(Math.max(index, 0), navItems.length - 1)].id;
      useFocusStore.getState().switchTo(VIEW_GROUP[view]);
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

  return (
    // 用 h-full/w-full 而不是 h-screen/w-screen：vh/vw 按物理视口算，
    // 但画布是 #root 那个固定尺寸的盒子（见 main.tsx），两者不一致会溢出/留白
    <div className="relative flex flex-col h-full w-full overflow-hidden">
      <div className="bg-ambient" />

      {/* 顶部导航 */}
      <header className="relative z-10 shrink-0 glass border-b border-border-glass">
        <div className="flex items-center h-20 px-8 gap-8">
          <div className="flex items-center gap-3 mr-2">
            <span className="text-2xl font-bold tracking-tight text-glow-accent">ZEX TV</span>
          </div>
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

      {/* 内容区 */}
      <main className="relative z-10 flex-1 min-h-0 overflow-hidden">
        <div className="h-full">
          {activeView === 'series' && <SeriesView />}
          {activeView === 'stats' && <StatsView />}
          {activeView === 'settings' && <SettingsView />}
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
