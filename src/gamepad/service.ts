// 电视版输入源：遥控器方向键经 Android WebView 转成键盘事件。
//   ArrowUp/Down/Left/Right → move
//   Enter → confirm
//   Escape → back（MainActivity 把遥控器 Back 键改造成 KEYCODE_ESCAPE 送进来；
//   真正的 KEYCODE_BACK 不能用——Chromium 当历史后退，页面收不到 keydown）
//
// 与桌面版 service.ts 区别：无 gilrs 事件、无右摇杆滚动、无肩键切库（肩键改用
// 遥控器无对应键，切库走顶部 nav）。长按连发保留（方向键按住持续移动）。
// 单通道：按键只经 WebView 标准转发（isTrusted keydown）进来，无原生兜底。

import { useFocusStore } from './focus';
import { setInputMode } from './inputMode';
import type { Dir } from './focus';

const REPEAT_DELAY = 250;     // 遥控器长按后快速进入连发
const REPEAT_INTERVAL = 100;  // 连发间隔

let heldDir: Dir | null = null;
let heldSince = 0;
let repeatTimer: number | null = null;

function emitDir(dir: Dir) {
  useFocusStore.getState().move(dir);
}

function startRepeat(dir: Dir) {
  stopRepeat();
  heldDir = dir;
  heldSince = performance.now();
  repeatTimer = window.setInterval(() => {
    if (heldDir && performance.now() - heldSince >= REPEAT_DELAY) {
      emitDir(heldDir);
    }
  }, REPEAT_INTERVAL);
}

function stopRepeat() {
  if (repeatTimer !== null) { window.clearInterval(repeatTimer); repeatTimer = null; }
  heldDir = null;
}

export function stopGamepadRepeat() {
  stopRepeat();
}

function handleKey(e: KeyboardEvent) {
  // 电视版输入一律视为 gamepad 模式（焦点高亮常显）
  setInputMode('gamepad');
  if (e.key === 'Enter' || e.key === 'Escape') stopRepeat();
  // 输入框聚焦时方向键留给文本编辑（移动光标）——软键盘场景，方向键导航暂停。
  // Enter/Escape 仍拦截（Enter=确认跳走，Escape=软键盘收起/返回导航）
  const el = document.activeElement;
  const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  switch (e.key) {
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
      if (typing) return; // 输入框内不导航
      e.preventDefault();
      applyKey('keydown', e.key);
      break;
    case 'Enter': case 'Escape':
      e.preventDefault();
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
        if (!e.repeat) useFocusStore.getState().pressStart();
      } else {
        useFocusStore.getState().back();
      }
      break;
    default:
      return; // 其它键不消费
  }
}

function handleKeyUp(e: KeyboardEvent) {
  // OK 抬起：短按在此确认（长按判定见 focus.ts pressStart/pressEnd）
  if (e.key === 'Enter') {
    useFocusStore.getState().pressEnd();
    return;
  }
  if (e.key.startsWith('Arrow')) {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    applyKey('keyup', e.key);
  }
}

// 统一的按键动作入口：入口只剩标准转发（WebView dispatchKeyEvent → isTrusted
// keydown），无兜底通道，不会重复触发
function applyKey(type: string, key: string) {
  if (type === 'keydown') {
    switch (key) {
      case 'ArrowUp': emitDir('up'); startRepeat('up'); break;
      case 'ArrowDown': emitDir('down'); startRepeat('down'); break;
      case 'ArrowLeft': emitDir('left'); startRepeat('left'); break;
      case 'ArrowRight': emitDir('right'); startRepeat('right'); break;
    }
  } else if (type === 'keyup') {
    if (key.startsWith('Arrow')) stopRepeat();
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
  // 否则 keyup 丢失、定时器迟到的 longPress 会在播放器底下开操作表
  window.addEventListener('blur', () => useFocusStore.getState().pressCancel());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) useFocusStore.getState().pressCancel();
  });
}

/** 兼容旧接口：电视版无开关，恒启用 */
export function setGamepadEnabled(_v: boolean) { /* no-op */ }
export function isGamepadEnabled(): boolean { return true; }
export function restartGamepad() { /* no-op */ }
export function getConnectedPads(): never[] { return []; }
export function onConnectedChange(_cb: () => void): () => void { return () => {}; }
