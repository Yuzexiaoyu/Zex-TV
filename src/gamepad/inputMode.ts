// 电视版输入模式：恒为 'gamepad'（遥控器）。保留与 ZEX focus.ts 兼容的接口，
// 但 mouse 分支永不触发——电视无鼠标，焦点高亮始终显示。

import { create } from 'zustand';

export type InputMode = 'mouse' | 'gamepad';

interface InputModeState {
  mode: InputMode;
}

export const useInputModeStore = create<InputModeState>(() => ({ mode: 'gamepad' }));

export function setInputMode(_mode: InputMode) {
  // 电视版无鼠标，恒 gamepad，忽略切换
}

export function useInputMode(): InputMode {
  return useInputModeStore((s) => s.mode);
}
