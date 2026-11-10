import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "web/index.html"),
        admin: resolve(import.meta.dirname, "web/admin/index.html"),
      },
    },
  },
  test: { root: ".", include: ["test/**/*.test.ts"] },
});
