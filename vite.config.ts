import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "client"),
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared/src")
    }
  },
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname)]
    },
    proxy: {
      "/api": "http://localhost:4100",
      "/ws": {
        target: "ws://localhost:4100",
        ws: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, "dist/client"),
    emptyOutDir: true
  }
});
