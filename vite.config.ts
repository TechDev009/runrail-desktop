import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // The highlighting worker loads each grammar on first use, which needs module chunks.
  worker: { format: "es" as const },

  build: {
    // The app loads from disk inside the Tauri window. The largest chunks are syntax grammars
    // (C++ is ~800 kB) that load only when a code block uses that language; the entry chunk
    // stays near 560 kB with the terminal, settings, and secondary views split out.
    chunkSizeWarningLimit: 900,
    // The phone page is its own small entry, which the Mac serves to paired phones,
    // and so is quick chat's window.
    rollupOptions: { input: { main: "index.html", phone: "phone.html", quick: "quick.html" } },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
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
