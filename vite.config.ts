import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// 构建时间戳：注入到前端，设置页标题行显示（每次打包必变，真机确认装的是新包）。
// 必须用打包机本地时间——toISOString() 是 UTC，中国时区看到的戳会早 8 小时，
// 跟「刚打的包是几点」对不上，就没法拿它确认装没装对。
const pad = (n: number) => String(n).padStart(2, "0");
const now = new Date();
const BUILD_STAMP =
  `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ` +
  `${pad(now.getHours())}:${pad(now.getMinutes())}`;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 5173,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
