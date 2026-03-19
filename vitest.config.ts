import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // NodeNext TS source files import with .js extensions; strip them so
      // Vite's resolver finds the actual .ts files during test runs.
      { find: /^(\.{1,2}\/.+)\.js$/, replacement: "$1" },
    ],
  },
  test: {
    environment: "node",
  },
});
