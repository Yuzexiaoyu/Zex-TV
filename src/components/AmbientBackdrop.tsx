// 环境底图：海报画到 32×18 小画布，再由 CSS 拉伸铺满。
// 双线性放大本身就是重度模糊，视觉等效于原来的 filter: blur(26~34px)，
// 但 GPU 只需采样一张小纹理——弱 TV 上 CSS blur 的全屏滤镜层会在页面
// 任何位置损伤时整层重新光栅化（实测单帧可达 100ms），是详情页掉帧主因。
import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';

const W = 32;
const H = 18;

export default function AmbientBackdrop({ src, className }: { src: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    let img: HTMLImageElement | null = new Image();
    img.onload = () => {
      const cv = canvasRef.current;
      const iw = img?.naturalWidth ?? 0;
      const ih = img?.naturalHeight ?? 0;
      if (!cv || !img || !iw || !ih) return;
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      // object-fit: cover 的裁剪数学，避免竖版海报被横向压扁
      const target = W / H;
      let sx = 0, sy = 0, sw = iw, sh = ih;
      if (iw / ih > target) { sw = ih * target; sx = (iw - sw) / 2; }
      else { sh = iw / target; sy = (ih - sh) / 2; }
      ctx.filter = 'saturate(1.2) blur(1px)'; // 小画布上跑滤镜，代价可忽略
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
      setLoaded(true);
    };
    img.src = src;
    return () => { if (img) img.onload = null; img = null; };
  }, [src]);

  return <canvas ref={canvasRef} className={clsx('ambient-canvas', className, loaded && 'loaded')} />;
}
