import { resolve } from "node:path";

import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    react({
      tsDecorators: true,
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    port: 3002,
  },
});
