// gamepad 模块统一出口
export * from './focus';
export * from './inputMode';
export { startGamepad, stopGamepadRepeat, setGamepadEnabled, isGamepadEnabled, restartGamepad, getConnectedPads, onConnectedChange } from './service';
export { useModalGamepad } from './useModalGamepad';
