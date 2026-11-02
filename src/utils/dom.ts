// 焦点滚动辅助：遥控器焦点移动后把目标元素滚进可视区。
// 只操作指定容器自身的 scrollTop/scrollLeft，绝不碰祖先——祖先链上有
// overflow:hidden 的固定布局（如详情页），scrollIntoView 会把整页顶歪。

/** 焦点项离滚动口边缘至少留这么多，让下一项始终露出来 */
export const EDGE_PAD = 64;

/** 把容器内 selector 命中的元素滚进可视区。
 *  要求容器是命中元素的 offsetParent（容器自身 position:relative），
 *  offsetLeft/offsetTop 的参照系才是滚动口本身。
 *  center=true 时居中展示（换季/默认落点），否则贴边滚（逐格移动） */
export function reveal(box: HTMLElement | null, selector: string, axis: 'x' | 'y', center = false) {
  const el = box?.querySelector<HTMLElement>(selector);
  if (!box || !el) return;
  const y = axis === 'y';
  const start = y ? el.offsetTop : el.offsetLeft;
  const size = y ? el.offsetHeight : el.offsetWidth;
  const view = y ? box.clientHeight : box.clientWidth;
  const cur = y ? box.scrollTop : box.scrollLeft;
  let next = cur;
  if (center) next = start - (view - size) / 2;
  else if (start - EDGE_PAD < cur) next = start - EDGE_PAD;
  else if (start + size + EDGE_PAD > cur + view) next = start + size + EDGE_PAD - view;
  next = Math.max(0, next);
  if (next === cur) return;
  if (y) box.scrollTop = next; else box.scrollLeft = next;
}
