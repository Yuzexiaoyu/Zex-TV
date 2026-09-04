// 弹窗焦点接入（移植自 ZEX useModalGamepad，去掉 Esc 拦截计数）。
// 弹窗打开时压栈注册本组，方向键/OK 被本组消费；Back（exit → onClose）关闭弹窗；
// Esc 兜底，只在自身是栈顶弹层时响应（嵌套弹窗逐层关闭）。
//
// - 不传 count = 屏蔽模式：方向/OK 无操作，仅 Back/Esc 关闭
// - 传 count/activate/… = 完整操作（确认弹窗、菜单：方向选 + OK 确认 + Back 关闭）

import { useEffect, useRef } from 'react';
import { useFocusStore, useGamepadGroup, type GroupOpts } from './focus';

interface ModalOpts {
  onClose: () => void;
  enabled?: boolean;
  count?: number;
  cols?: number;
  activate?: (i: number) => void;
  horizontal?: (dir: 'left' | 'right', index: number) => boolean;
  scrollIntoView?: (i: number) => void;
  initialIndex?: number;
  /** 组内越界方向键回调（吸收或跳转；不传则按键全哑） */
  leave?: (dir: 'up' | 'down' | 'left' | 'right', index: number) => void;
}

export function useModalGamepad(id: string, opts: ModalOpts) {
  const { onClose, enabled = true, initialIndex = 0 } = opts;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const groupOpts: GroupOpts = {
    count: enabled ? (opts.count ?? 0) : 0,
    cols: opts.cols ?? 1,
    activate: opts.activate ?? (() => {}),
    horizontal: opts.horizontal,
    scrollIntoView: opts.scrollIntoView,
    leave: opts.leave,
    exit: () => onCloseRef.current(),
  };
  useGamepadGroup(id, groupOpts);

  // Esc 兜底：只在自身是栈顶弹层时响应（嵌套逐层关闭）。
  // 正常路径是 Back 键 → service.ts back() → exit → onClose；Esc 是 WebView 兜底
  useEffect(() => {
    if (!enabled) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useFocusStore.getState();
      if (s.stack[s.stack.length - 1]?.group !== id) return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [enabled, id]);

  // 压栈聚焦；卸载时若栈顶仍是本组则静默弹掉（不触发 exit —— 卸载由 onClose 引发，
  // 回调已执行过，再调一次会重复关闭）
  useEffect(() => {
    if (!enabled) return;
    useFocusStore.getState().push(id, initialIndex);
    return () => {
      useFocusStore.setState((s) => {
        if (s.stack[s.stack.length - 1]?.group !== id) return s;
        return { stack: s.stack.slice(0, -1) };
      });
    };
  }, [id, enabled, initialIndex]);
}
