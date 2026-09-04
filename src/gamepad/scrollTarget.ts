// 右摇杆滚动电视版用不到（无摇杆），但 useModalGamepad/scrollTarget 接口被各组件引用，
// 保留空实现以免改动调用方。电视版滚动靠 scrollIntoView 回调（焦点移动时主动滚）。

export function getScrollTarget(): HTMLElement | null {
  return null;
}

export function useRightStickScroll(_id: string): void { /* no-op */ }
export function useRightStickScrollIf(_id: string, _cond: boolean): void { /* no-op */ }
