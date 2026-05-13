import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// Tailwind v4 is wired via PostCSS (postcss.config.mjs) rather
// than the @tailwindcss/vite plugin: that plugin's call into Vite
// 8's createIdResolver omits `tsconfigPaths` and crashes when
// Astro pipes it. PostCSS sidesteps the broken resolve pathway.
export default defineConfig({
  site: "https://stll.app",
  // `lastmod` is intentionally omitted: stamping every URL with the
  // build timestamp would lie about which pages actually changed and
  // train crawlers to discount the field site-wide. Add per-URL lastmod
  // via @astrojs/sitemap's serialize() once there is real content to
  // source dates from.
  integrations: [sitemap({ changefreq: "weekly" }), react()],
});
