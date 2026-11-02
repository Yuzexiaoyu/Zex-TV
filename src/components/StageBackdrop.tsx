// 全局共享背景层：影视库 Hero 与详情页共用同一张背景图。
// 挂在 App 根（顶部导航/内容区之下、装饰 bg-ambient 之上），fixed 铺满整画布。
// 主页只有 Hero 条带透明露出它、下方工具栏/海报行实色挡住其余；详情页整屏露出它。
// 同一个 DOM 元素、同一张已解码的图：进详情不重新加载、不位移。
//
// 关键：换剧时直接把 warmBackdrop 里「已解码」的那张 <img> 节点挂进来（而不是新建
// <img src> 等它为本元素重新解码）——解码完成前保留旧节点，就绪瞬间原子替换，
// 中途永不出现空帧（否则会透出底部 fallback 闪一下黑）。竖版海报同理：画到 32×18
// 小画布放大 ≈ 重模糊，画好再原子替换。
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { warmBackdrop } from '../utils/backdrop';

const AW = 32;
const AH = 18;

export default function StageBackdrop() {
  const { src, poster } = useAppStore((s) => s.stageBackdrop);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!src) { host.replaceChildren(); return; }
    let cancelled = false;

    if (poster) {
      // 竖版海报 → 环境底图：解码后画到小画布，就绪才替换（旧帧保留，不闪黑）
      let img: HTMLImageElement | null = new Image();
      img.decoding = 'async';
      img.onload = () => {
        const iw = img?.naturalWidth ?? 0;
        const ih = img?.naturalHeight ?? 0;
        if (cancelled || !img || !iw || !ih) return;
        const cv = document.createElement('canvas');
        cv.width = AW; cv.height = AH;
        cv.className = 'stage-bg-amb';
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        const target = AW / AH; // object-fit: cover 的裁剪数学
        let sx = 0, sy = 0, sw = iw, sh = ih;
        if (iw / ih > target) { sw = ih * target; sx = (iw - sw) / 2; }
        else { sh = iw / target; sy = (ih - sh) / 2; }
        ctx.filter = 'saturate(1.2) blur(1px)';
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, AW, AH);
        host.replaceChildren(cv);
      };
      img.src = src;
      return () => { cancelled = true; if (img) img.onload = null; img = null; };
    }

    // bg_path 实图：复用已解码节点，就绪才挂入
    const entry = warmBackdrop(src);
    const put = (ok: boolean) => {
      if (cancelled || !ok) return;
      entry.image.className = 'stage-bg-img';
      host.replaceChildren(entry.image);
    };
    if (entry.ready) put(true);
    else void entry.promise.then(put);
    return () => { cancelled = true; };
  }, [src, poster]);

  return (
    <div className="stage-bg" aria-hidden>
      <div className="stage-bg-fallback" />
      <div ref={hostRef} className="stage-bg-host" />
    </div>
  );
}
