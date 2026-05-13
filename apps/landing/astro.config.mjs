import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// Tailwind v4 is wired via PostCSS (postcss.config.mjs) rather
// than the @tailwindcss/vite plugin: that plugin's call into Vite
// 8's createIdResolver omits `tsconfigPaths` and crashes when
// Astro pipes it. PostCSS sidesteps the broken resolve pathway.
export default defineConfig({
  site: "https://stll.app",
  // `new Date()` is captured at build time, so every deploy stamps the
  // sitemap with the build timestamp — Google uses lastmod to schedule
  // recrawls.
  integrations: [sitemap({ changefreq: "weekly", lastmod: new Date() }), react()],
});
