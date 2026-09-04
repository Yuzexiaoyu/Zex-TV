// 焦点系统：栈式焦点组。完整移植自 ZEX focus.ts（电视版仅改输入源）。
// 遥控器方向键 → move，OK → confirm，Back → back（见 service.ts 键盘事件注入）。

import { create } from 'zustand';
import { useEffect, useRef } from 'react';
import { useInputMode } from './inputMode';
import { stopGamepadRepeat } from './service';

export type Dir = 'up' | 'down' | 'left' | 'right';

/** 一个可导航焦点组：规则网格（cols>1）或列表/横向（cols=1） */
export interface GroupOpts {
  /** 可聚焦项数量 */
  count: number;
  /** 规则网格列数；省略时按单行（cols=count）处理 */
  cols?: number;
  /** OK 键按下时激活第 index 项 */
  activate: (index: number) => void;
  /** 焦点移到 index 时保证其可见（如滚动容器 scrollToIndex） */
  scrollIntoView?: (index: number) => void;
  /** 焦点在边界且继续朝 dir 移动时跳转（跨区域）；不定义则停在边界 */
  leave?: (dir: Dir, index: number) => void;
  /** 该组被 Back 弹栈时调用（关闭弹层/详情） */
  exit?: () => void;
  /** 左/右键在行内切换时优先调用（如设置页的 chips 开/关）；返回 true 表示已消费、不移动行 */
  horizontal?: (dir: 'left' | 'right', index: number) => boolean;
}

interface FocusItem {
  group: string;
  /** index 为 null = 未聚焦待命态（reset 后还没按过方向键） */
  index: number | null;
}

interface FocusStore {
  /** 焦点层级栈，栈顶为当前焦点；modal/detail 打开时压栈、Back 弹栈 */
  stack: FocusItem[];
  register: (id: string, ref: { current: GroupOpts }) => void;
  unregister: (id: string) => void;
  /** 清栈到单层并聚焦（视图切换用）。不传 index 时进入「未聚焦」待命态：
   *  启动 / 切换视图不自动选中第一项（避免影视库首个被默认选中而弹出悬停封面），
   *  首次按方向键才落到第 0 项 */
  reset: (group: string, index?: number | null) => void;
  /** 压栈（打开 modal/detail） */
  push: (group: string, index?: number) => void;
  /** 替换栈顶（同视图内区域切换，如网格 ↔ nav） */
  switchTo: (group: string, index?: number) => void;
  move: (dir: Dir) => void;
  confirm: () => void;
  /** 弹栈；返回 true = 发生了弹栈 */
  back: () => boolean;
}

// 区域注册表放模块级 Map：zustand state 只存可序列化状态，函数不进 store。
// 存的是组件的 opts ref 而非某一帧的快照——注册只在挂载时发生一次，若把当次
// 渲染的对象存进来，count 与所有回调就永远冻在首帧：详情页首帧 data 还没到，
// seasons/episodes 都是空数组 → 右键进不了季/集；设置页语言项闭包里的 lang
// 永远是初始值 → 只能切一次
const registry = new Map<string, { current: GroupOpts }>();

/** 取某组当前的 opts（每次都从 ref 读最新，不缓存） */
function optsOf(id: string): GroupOpts | undefined {
  return registry.get(id)?.current;
}

/** 焦点栈换组时同步清理 DOM 焦点：input/textarea 若仍持有焦点，service.ts
 *  的 typing guard 会吞掉后续所有方向键（焦点栈活着、页面高亮也在，但按键
 *  全哑——看起来就是「焦点丢了」）。设置页的输入框（TMDB key / 代理 / NAS
 *  编辑弹窗）都踩过这条路。组件用原生 .focus() 聚焦输入框，没有对应的
 *  失焦约定，只能在栈切组时兜底 blur */
function blurIfTyping() {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.blur();
  }
}

function topItem(stack: FocusItem[]): FocusItem | undefined {
  return stack.length ? stack[stack.length - 1] : undefined;
}

export const useFocusStore = create<FocusStore>((set, get) => ({
  stack: [],

  register: (id, ref) => { registry.set(id, ref); },
  unregister: (id) => { registry.delete(id); },

  reset: (group, index = null) => {
    stopGamepadRepeat();
    blurIfTyping();
    set({ stack: [{ group, index }] });
    if (index != null) optsOf(group)?.scrollIntoView?.(index);
  },

  push: (group, index = 0) => {
    const top = topItem(get().stack);
    if (top?.group === group && top.index === index) return;
    blurIfTyping();
    set((s) => ({ stack: [...s.stack, { group, index }] }));
    optsOf(group)?.scrollIntoView?.(index);
  },

  switchTo: (group, index = 0) => {
    stopGamepadRepeat();
    blurIfTyping();
    // 目标组不存在（视图组件挂载的注册 effect 还没跑——按键快过渲染提交）时，
    // 不能把栈切到死组：之后所有按键 registry.get 都拿不到，焦点全哑且无高亮。
    // 退回 nav（恒注册），视图切换 effect 在组件挂载后会把焦点送回内容区
    const target = registry.has(group) ? group : 'nav';
    const stack = get().stack;
    const next = stack.length ? [...stack.slice(0, -1), { group: target, index }] : [{ group: target, index }];
    set({ stack: next });
    optsOf(target)?.scrollIntoView?.(index);
  },

  move: (dir) => {
    const top = topItem(get().stack);
    if (!top) {
      console.warn('[focus] move: 空栈，按键丢弃', dir);
      return;
    }
    const opts = optsOf(top.group);
    if (!opts) {
      console.warn('[focus] move: 栈顶组未注册，按键丢弃', top.group, dir);
      return;
    }
    // 组内没有可聚焦项（空态页）：方向键只走跨组跳转（如空统计页「上」回导航）。
    // 之前直接 return，空页按键全部无声无息，遥控器像死机
    if (opts.count <= 0) {
      opts.leave?.(dir, -1);
      return;
    }
    // 未聚焦待命态：任何方向都落到第 0 项，避免启动/切视图就自动选中第一项
    if (top.index == null) {
      set((s) => {
        const stack = s.stack.slice();
        stack[stack.length - 1] = { ...stack[stack.length - 1], index: 0 };
        return { stack };
      });
      opts.scrollIntoView?.(0);
      return;
    }
    const { count, cols = count } = opts;
    const index = top.index;
    let next = index;
    let crossed = false;
    if (dir === 'left' || dir === 'right') {
      if (opts.horizontal?.(dir, index)) return;
    }
    // 只有设置页和详情页的垂直区域将左右定义为跨区域切换；
    // 顶部 nav 仍是横向列表，左右必须由通用网格逻辑处理。
    const verticalArea = top.group === 'settings:nas' || top.group === 'settings:right'
      || top.group === 'detail-hero' || top.group === 'detail-seasons' || top.group === 'detail-episodes';
    if (verticalArea && (dir === 'left' || dir === 'right')) {
      opts.leave?.(dir, index);
      return;
    }
    if (cols > 1) {
      const row = Math.floor(index / cols);
      const lastIdx = count - 1;
      const lastRow = Math.floor(lastIdx / cols);
      switch (dir) {
        case 'up':
          if (row > 0) next = index - cols; else crossed = true;
          break;
        case 'down':
          if (row < lastRow) next = Math.min(count - 1, index + cols); else crossed = true;
          break;
        // 左右在行内移动：行首按左 / 行尾按右 = 越界走 leave（跨组跳转或原地停留）。
        // 之前只有 up/down 两个 case——nav（横向单行）、海报墙、hero 按钮组、
        // 工具栏 chips 的左右键全部无声无息，电视上横向导航整个是死的
        case 'left':
          if (index % cols > 0) next = index - 1; else crossed = true;
          break;
        case 'right':
          if (index % cols < cols - 1 && index < count - 1) next = index + 1; else crossed = true;
          break;
      }
    } else {
      switch (dir) {
        case 'up':
          if (index > 0) next = index - 1; else crossed = true;
          break;
        case 'down':
          if (index < count - 1) next = index + 1; else crossed = true;
          break;
      }
    }
    if (crossed) { opts.leave?.(dir, index); return; }
    if (next !== index) {
      set((s) => {
        const stack = s.stack.slice();
        stack[stack.length - 1] = { ...stack[stack.length - 1], index: next };
        return { stack };
      });
      opts.scrollIntoView?.(next);
    }
  },

  confirm: () => {
    const top = topItem(get().stack);
    if (!top || top.index == null) {
      console.warn('[focus] confirm: 空栈或待命态，OK 丢弃', JSON.stringify(top));
      return;
    }
    optsOf(top.group)?.activate?.(top.index);
  },

  back: () => {
    const stack = get().stack;
    if (stack.length <= 1) return false;
    const popped = stack[stack.length - 1];
    const rest = stack.slice(0, -1);
    set({ stack: rest });
    optsOf(popped.group)?.exit?.();
    const top = rest[rest.length - 1];
    if (top.index != null) optsOf(top.group)?.scrollIntoView?.(top.index);
    return true;
  },
}));

/** 组件读自己是否「当前焦点」 */
export function useGamepadFocus(group: string, index: number): boolean {
  const mode = useInputMode();
  return useFocusStore((s) => {
    const top = topItem(s.stack);
    return mode === 'gamepad' && top?.group === group && top.index === index;
  });
}

/** 当前组的焦点索引；无焦点时返回 -1 */
export function useFocusIndex(group: string): number {
  const mode = useInputMode();
  return useFocusStore((s) => {
    if (mode !== 'gamepad') return -1;
    const top = topItem(s.stack);
    return top?.group === group ? (top.index ?? -1) : -1;
  });
}

/** 容器注册焦点组；注册表持有 optsRef 本身，所以 count 与回调始终是最新一帧的值 */
export function useGamepadGroup(id: string, opts: GroupOpts) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    useFocusStore.getState().register(id, optsRef);
    return () => useFocusStore.getState().unregister(id);
  }, [id]);
}
