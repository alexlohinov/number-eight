import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const devHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  optimizeDeps: {
    include: ["@base-ui/react/button", "@base-ui/react/menu"],
  },
  server: {
    host: devHost || false,
    port: 1420,
    strictPort: true,
    hmr: devHost
      ? {
          protocol: "ws",
          host: devHost,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
