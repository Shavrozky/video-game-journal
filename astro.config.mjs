// @ts-check
import { defineConfig } from "astro/config";

import tailwindcss from "@tailwindcss/vite";

import node from "@astrojs/node";

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],

    ssr: {
      // better-sqlite3 ships a native .node binding; bundling it breaks the
      // build. Keeping it external means Node resolves it at runtime from
      // node_modules (already a production dependency).
      external: ["better-sqlite3"],
    },
  },

  adapter: node({
    mode: "standalone",
  }),
});
