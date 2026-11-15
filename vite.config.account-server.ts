/**
 * Bundles the Wizardry account server (`src/account/server/main.ts`) into one
 * file, `server/account-server.mjs`, that plain Node runs with nothing
 * installed beside it. Its own config for the same reason the Electron bundles
 * have theirs: one entry, one predictable filename. `node:*` stays external.
 */
import path from "node:path";

import { defineConfig } from "vite";

import { buildConfigPlugin } from "./src/build/buildConfig";

export default defineConfig({
  plugins: [buildConfigPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    target: "node22",
    outDir: "server",
    emptyOutDir: false,
    copyPublicDir: false,
    // Readable on purpose: this is the code that holds the account table.
    minify: false,
    lib: {
      entry: path.resolve(import.meta.dirname, "src/account/server/main.ts"),
      formats: ["es"],
      fileName: () => "account-server.mjs",
    },
    rollupOptions: {
      external: [/^node:/],
    },
  },
});
