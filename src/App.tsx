// M0 冒烟页：验证遥控器方向键/OK 能到达 WebView、Back 事件、屏幕信息。
// 之后 M1 换成真正的影视库界面。
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export default function App() {
  const [keys, setKeys] = useState<string[]>([]);
  const [backEvents, setBackEvents] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      setKeys((k) => [e.key, ...k].slice(0, 6));
      if (e.key === "Escape") setBackEvents((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    const unlisten = listen<string>("back-key", () => setBackEvents((n) => n + 1));
    return () => {
      window.removeEventListener("keydown", onKey);
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <div style={{ background: "#080810", color: "#fff", minHeight: "100vh", padding: 48, fontSize: 28 }}>
      <h1>ZEX TV - M0 冒烟页</h1>
      <p>UA: {navigator.userAgent}</p>
      <p>屏幕: {window.screen.width}×{window.screen.height} CSS: {window.innerWidth}×{window.innerHeight}</p>
      <p>最近按键: {keys.join(" | ") || "（按遥控器方向键/OK）"}</p>
      <p>Back 事件: {backEvents} 次</p>
    </div>
  );
}
