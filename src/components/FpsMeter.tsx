// 实时帧率 HUD（左上角）。测的是 requestAnimationFrame 每秒回调次数——
// 主线程被布局/解码阻塞时 rAF 被推迟、读数掉下去，正好照出卡顿。
// 关键：每帧只累加计数、每 ~500ms 直接改 DOM 文本，绝不 setState——
// 否则「显示帧率」本身每帧触发一次 React 重渲染，反倒拖慢它要测的东西。
import { useEffect, useRef } from 'react';

export default function FpsMeter() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();

    const tick = (now: number) => {
      frames++;
      const elapsed = now - last;
      if (elapsed >= 500) {
        const fps = Math.round((frames * 1000) / elapsed);
        const el = ref.current;
        if (el) {
          el.textContent = `${fps} FPS`;
          el.style.color = fps >= 50 ? '#4ade80' : fps >= 30 ? '#facc15' : '#f87171';
        }
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: 6,
        left: 8,
        zIndex: 9999,
        pointerEvents: 'none',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        fontWeight: 700,
        lineHeight: 1,
        padding: '4px 7px',
        borderRadius: 6,
        color: '#4ade80',
        background: 'rgba(0, 0, 0, 0.55)',
        letterSpacing: '0.02em',
      }}
    >
      -- FPS
    </div>
  );
}
