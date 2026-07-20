import { UI_LOCALES } from "@stll/locales";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Derived from @stll/locales so routing + sitemap locales equal the app's UI
// locales (mirrors src/i18n/config.ts). Default locale (en) sits at root; the
// rest under a lowercased path prefix (/es/, /pt-br/, /ar/, /de/, ...).
const astroLocales = UI_LOCALES.map((tag) =>
  tag === "en" ? "en" : { path: tag.toLowerCase(), codes: [tag] },
);
const sitemapLocales = Object.fromEntries(
  UI_LOCALES.map((tag) => [tag === "en" ? "en" : tag.toLowerCase(), tag]),
);

export default defineConfig({
  site: "https://stll.app",
  i18n: {
    defaultLocale: "en",
    locales: astroLocales,
    routing: { prefixDefaultLocale: false },
  },
  // Astro 7 changed the default to 'jsx', which strips whitespace between
  // adjacent inline elements (footer "·" separators, inline link runs).
  // Keep the v6 behavior so existing spacing renders unchanged.
  compressHTML: true,
  // `lastmod` is intentionally omitted: stamping every URL with the
  // build timestamp would lie about which pages actually changed and
  // train crawlers to discount the field site-wide. Add per-URL lastmod
  // via @astrojs/sitemap's serialize() once there is real content to
  // source dates from.
  integrations: [
    sitemap({
      changefreq: "weekly",
      // The /changelog/<release> stubs are noindex link-preview redirect pages;
      // keep them (and nothing else under /changelog/…) out of the sitemap.
      filter: (page) => !/\/changelog\/.+/u.test(new URL(page).pathname),
      // Emit localized URLs + hreflang alternates in the sitemap. Keys are the
      // URL path segments (default locale at root keyed "en"); values are the
      // hreflang codes.
      i18n: {
        defaultLocale: "en",
        locales: sitemapLocales,
      },
    }),
    react(),
  ],
  vite: { plugins: [tailwindcss()] },
});
