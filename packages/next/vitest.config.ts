import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@stratasync/next/server",
        replacement: fileURLToPath(new URL("src/server.ts", import.meta.url)),
      },
      {
        find: "@stratasync/next/client",
        replacement: fileURLToPath(new URL("src/client.ts", import.meta.url)),
      },
      {
        find: /^@stratasync\/next$/,
        replacement: fileURLToPath(new URL("src/client.ts", import.meta.url)),
      },
    ],
  },
  test: {
    clearMocks: true,
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
