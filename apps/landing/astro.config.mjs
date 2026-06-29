import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://stll.app",
  // `lastmod` is intentionally omitted: stamping every URL with the
  // build timestamp would lie about which pages actually changed and
  // train crawlers to discount the field site-wide. Add per-URL lastmod
  // via @astrojs/sitemap's serialize() once there is real content to
  // source dates from.
  integrations: [sitemap({ changefreq: "weekly" }), react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
