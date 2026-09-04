import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// ─── 电视适配：固定设计画布 + 等比缩放铺满 ───────────────
// 电视 WebView 的 CSS 视口宽度由系统密度决定（海信 GX27 上远小于 1920），
// 所以同一份 px 排版在电视上占的屏幕比例比显示器上大得多，元素显示不全。
//
// 这里把 #root 固定成 DESIGN_W 宽的画布来排版，再整体 scale 到真实视口宽度：
// 元素占屏比例只由 DESIGN_W 决定，与设备密度、分辨率无关。高度按 scale 反算成
// 实际视口对应的画布高度，所以缩放后正好铺满，不留黑边也不裁切
//（上一版 `html{zoom:.82}` 就是缩完不重新铺满，右侧和底部各剩 18% 黑边，
//  在电视上看起来「只有左上角一大块有画面」）。
//
// 觉得整体偏大 → 把 DESIGN_W 调大；偏小 → 调小。只改这一个数字。
const DESIGN_W = 1600;

function applyCanvas() {
  const root = document.getElementById('root')!;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!vw || !vh) return;
  const scale = vw / DESIGN_W;
  const s = root.style;
  s.setProperty('--tv-w', `${DESIGN_W}px`);
  // 画布高度 = 视口高 ÷ scale，缩放后恰好等于视口高
  s.setProperty('--tv-h', `${Math.round(vh / scale)}px`);
  s.setProperty('--tv-scale', String(scale));
}

applyCanvas();
// 电视上视口尺寸会变：旋转（罕见）、系统栏显隐、分屏、WebView 首帧后拿到真实尺寸
window.addEventListener('resize', applyCanvas);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
