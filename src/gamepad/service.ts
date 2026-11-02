// 电视版输入源：遥控器方向键经 Android WebView 转成键盘事件。
//   ArrowUp/Down/Left/Right → move
//   Enter → confirm
//   Escape → back（MainActivity 把遥控器 Back 键改造成 KEYCODE_ESCAPE 送进来；
//   真正的 KEYCODE_BACK 不能用——Chromium 当历史后退，页面收不到 keydown）
//
// 与桌面版 service.ts 区别：无 gilrs 事件、无右摇杆滚动、无肩键切库。
// 长按连发：MainActivity 已丢弃系统连发（repeatCount>0），系统 e.repeat 一律忽略，
// 连发完全由 JS 自己的定时器掌控。只有「首页海报行（grid:series）左右」开连发
// （海报墙环形、适合长按快速划过）；其余区域（集列表/季标签/设置/导航）保持一次
// 按下只走一格，精确不过冲。连发用成熟的「打字机」参数：按住超过 REPEAT_DELAY 才
// 起连发（短按只一格、绝不多跳），之后每 REPEAT_INTERVAL 走一格。

import { useFocusStore } from './focus';
import { setInputMode } from './inputMode';
import type { Dir } from './focus';

function emitDir(dir: Dir) {
  useFocusStore.getState().move(dir);
}

const ARROW_DIR: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

// 连发参数（成熟的打字机式）：首格后等 400ms 才开始连发，之后约 8 格/秒。
// 400ms 的首延保证「短按一下」永远只走一格（keyup 早于首延，定时器被取消）。
const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 120;

let repeatTimer: number | null = null;
let repeatDir: Dir | null = null;

function clearRepeat() {
  if (repeatTimer !== null) {
    window.clearTimeout(repeatTimer);
    window.clearInterval(repeatTimer);
    repeatTimer = null;
  }
  repeatDir = null;
}

/** 当前是否该对 dir 开连发：仅首页海报行（grid:series）的左右键 */
function repeatEligible(dir: Dir): boolean {
  if (dir !== 'left' && dir !== 'right') return false;
  const stack = useFocusStore.getState().stack;
  const top = stack[stack.length - 1];
  return top?.group === 'grid:series';
}

/** 一次物理按下：先走一格，若符合连发条件则起定时器（首延后周期连发） */
function startDir(dir: Dir) {
  clearRepeat();
  emitDir(dir);
  if (!repeatEligible(dir)) return;
  repeatDir = dir;
  repeatTimer = window.setTimeout(() => {
    repeatTimer = window.setInterval(() => {
      // 每拍重判定：焦点若已离开海报行（跳组/关页）立即停，避免 keyup 丢失时连发失控
      if (repeatDir && repeatEligible(repeatDir)) emitDir(repeatDir);
      else clearRepeat();
    }, REPEAT_INTERVAL);
  }, REPEAT_DELAY);
}

/** focus.ts 的 reset/switchTo 会调用：焦点换组时停连发 */
export function stopGamepadRepeat() { clearRepeat(); }

function handleKey(e: KeyboardEvent) {
  // 电视版输入一律视为 gamepad 模式（焦点高亮常显）
  setInputMode('gamepad');
  // 输入框聚焦时方向键留给文本编辑（移动光标）——软键盘场景，方向键导航暂停。
  // Enter/Escape 仍拦截（Enter=确认跳走，Escape=软键盘收起/返回导航）
  const el = document.activeElement;
  const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  switch (e.key) {
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
      if (typing) return; // 输入框内不导航
      e.preventDefault();
      // 系统/合成连发（e.repeat）一律忽略：连发只由 JS 定时器控制（见 startDir）
      if (e.repeat) return;
      startDir(ARROW_DIR[e.key]);
      break;
    case 'Enter': case 'Escape':
      e.preventDefault();
      clearRepeat(); // 换动作，停掉方向连发
      if (typing && e.key === 'Enter') {
        // 输入框里按 OK：失焦退出输入态（提交靠焦点移到「确认」再 OK）
        (el as HTMLElement).blur();
        return;
      }
      if (typing && e.key === 'Escape') {
        // 输入框里按 Back：先收起软键盘（blur），这次不弹栈——
        // 第二次 Back 才退出当前层。否则弹栈后 input 仍持有 DOM 焦点，
        // typing guard 会吞掉后续所有方向键，焦点栈与页面都还活着，
        // 用户看到的却是「焦点丢了、按哪都没反应」
        (el as HTMLElement).blur();
        return;
      }
      // OK：按下进长按判定（有 longPress 的组抬起才确认，见 focus.ts）；
      // 系统对长按 OK 的 keydown 连发只认首按
      if (e.key === 'Enter') {
        if (!e.repeat) { useFocusStore.getState().pressStart(); }
      } else {
        useFocusStore.getState().back();
      }
      break;
    default:
      return; // 其它键不消费
  }
}

function handleKeyUp(e: KeyboardEvent) {
  // 方向键抬起：停连发（短按时首延未到，这里取消 → 只走了一格）
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    clearRepeat();
    return;
  }
  // OK 抬起：短按在此确认（长按判定见 focus.ts pressStart/pressEnd）。
  if (e.key === 'Enter') {
    useFocusStore.getState().pressEnd();
  }
}

let started = false;

/** App 启动时挂载一次：监听键盘事件（幂等） */
export function startGamepad() {
  if (started) return;
  started = true;
  window.addEventListener('keydown', handleKey, { capture: true });
  window.addEventListener('keyup', handleKeyUp, { capture: true });
  // 失焦/退后台（拉起系统播放器即 WebView onPause）时作废进行中的 OK 长按判定，
  // 否则 keyup 丢失、定时器迟到的 longPress 会在播放器底下开操作表。方向连发同样停掉。
  window.addEventListener('blur', () => { clearRepeat(); useFocusStore.getState().pressCancel(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearRepeat(); useFocusStore.getState().pressCancel(); }
  });
}

/** 兼容旧接口：电视版无开关，恒启用 */
export function setGamepadEnabled(_v: boolean) { /* no-op */ }
export function isGamepadEnabled(): boolean { return true; }
export function restartGamepad() { /* no-op */ }
export function getConnectedPads(): never[] { return []; }
export function onConnectedChange(_cb: () => void): () => void { return () => {}; }
