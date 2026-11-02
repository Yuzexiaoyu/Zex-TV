// 已解码图片缓存：换图时直接复用「已解码」的 <img> 节点挂进 DOM，而不是新建
// <img src> 等它为新元素再解一次码——后者会让图比周围内容慢一两帧出现（闪一下/落后）。
// 两个独立缓存：背景图（少量）与单集剧照（多一些，覆盖相邻集预取）。
interface ImgEntry {
  image: HTMLImageElement;
  ready: boolean;
  promise: Promise<boolean>;
}

function makeImageCache(limit: number) {
  const images = new Map<string, ImgEntry>();

  function peek(src: string): ImgEntry | undefined {
    return images.get(src);
  }

  function warm(src: string): ImgEntry {
    const cached = images.get(src);
    if (cached) {
      // LRU：命中挪到末尾
      images.delete(src);
      images.set(src, cached);
      return cached;
    }
    const image = new Image();
    image.decoding = 'async';
    image.alt = '';
    const entry: ImgEntry = { image, ready: false, promise: Promise.resolve(false) };
    images.set(src, entry);
    image.src = src;
    entry.promise = image.decode().then(() => {
      entry.ready = true;
      return true;
    }, () => {
      if (images.get(src) === entry) images.delete(src);
      return false;
    });
    while (images.size > limit) images.delete(images.keys().next().value!);
    return entry;
  }

  return { peek, warm };
}

const backdrop = makeImageCache(4);
const still = makeImageCache(8);

export const peekBackdrop = backdrop.peek;
export const warmBackdrop = backdrop.warm;
export const peekStill = still.peek;
export const warmStill = still.warm;
