import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server. API calls to /api are proxied to the Express server
// (which does the heavy log parsing and local-repo file reads off the browser thread).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
