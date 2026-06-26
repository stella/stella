import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://stll.app",
  // Default locale at root (/), others under a path prefix (/es/, /pt-br/).
  // Single source of truth lives in src/i18n/config.ts; keep this in sync.
  i18n: {
    defaultLocale: "en",
    locales: [
      "en",
      { path: "es", codes: ["es"] },
      { path: "pt-br", codes: ["pt-BR"] },
      { path: "ar", codes: ["ar"] },
    ],
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
      // Emit localized URLs + hreflang alternates in the sitemap. Keys are the
      // URL path segments (default locale at root keyed "en"); values are the
      // hreflang codes.
      i18n: {
        defaultLocale: "en",
        locales: { en: "en", es: "es", "pt-br": "pt-BR", ar: "ar" },
      },
    }),
    react(),
  ],
  vite: { plugins: [tailwindcss()] },
});
