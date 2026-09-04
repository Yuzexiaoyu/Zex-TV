// Esc 拦截计数：桌面版用于让位全局「Esc=收托盘」。电视版无收托盘行为，
// 但 useModalGamepad 仍调用此接口——保留空实现，避免改动调用方。
// 电视版 Esc/Back 的弹窗关闭由 useModalGamepad 内部的栈顶判断直接处理。

export function useEscIntercept(_enabled: boolean = true): void { /* no-op */ }
