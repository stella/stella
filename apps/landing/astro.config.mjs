import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

import stllAnonymizeWasm from "@stll/anonymize-wasm/vite";
import { UI_LOCALES } from "@stll/locales";

import { ogCards } from "./src/integrations/og-cards";
import { sitemapLastmod } from "./src/integrations/sitemap-lastmod";

// Keep this aligned with the production CDN response-headers policy.
// `wasm-unsafe-eval` permits WebAssembly compilation without enabling
// JavaScript eval; COOP/COEP expose SharedArrayBuffer to the threaded runtime.
const LANDING_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https://github.com https://*.githubusercontent.com https://objects.githubusercontent.com https://*.s3.amazonaws.com; connect-src 'self' https://api.github.com; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

// Derived from @stll/locales so routing + sitemap locales equal the app's UI
// locales (mirrors src/i18n/config.ts). Default locale (en) sits at root; the
// rest under a lowercased path prefix (/es/, /pt-br/, /ar/, /de/, ...).
const astroLocales = UI_LOCALES.map((tag) =>
  tag === "en" ? "en" : { path: tag.toLowerCase(), codes: [tag] },
);
const sitemapLocales = Object.fromEntries(
  UI_LOCALES.map((tag) => [tag === "en" ? "en" : tag.toLowerCase(), tag]),
);
const lastmod = sitemapLastmod({
  localeTagByPath: new Map(
    UI_LOCALES.filter((tag) => tag !== "en").map((tag) => [
      tag.toLowerCase(),
      tag,
    ]),
  ),
});

export default defineConfig({
  site: "https://stll.app",
  // The live anonymization demo's wasm runtime is thread-capable
  // (napi-rs/emnapi WASI threads) and needs `SharedArrayBuffer`, which
  // browsers only expose to a cross-origin-isolated page. These headers
  // (mirroring apps/web/vite.config.ts's dev server) cover local `astro
  // dev`/`astro preview`; this is a static build (`output: "static"`), so
  // the deployed site's actual host/CDN must send the same pair in
  // production or the demo will fail there even though it works locally.
  server: {
    headers: LANDING_SECURITY_HEADERS,
  },
  i18n: {
    defaultLocale: "en",
    locales: astroLocales,
    routing: { prefixDefaultLocale: false },
  },
  // Astro 7 changed the default to 'jsx', which strips whitespace between
  // adjacent inline elements (footer "·" separators, inline link runs).
  // Keep the v6 behavior so existing spacing renders unchanged.
  compressHTML: true,
  integrations: [
    lastmod.integration,
    // Docs live under /docs (every entry sits in src/content/docs/docs/),
    // English-only, structured by Diátaxis (get started / how-to /
    // reference / explanation). The landing keeps its own 404 page.
    starlight({
      title: "stella docs",
      disable404Route: true,
      components: {
        Head: "./src/components/docs-head.astro",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/stella/stella",
        },
      ],
      sidebar: [
        {
          label: "Get started",
          items: [{ autogenerate: { directory: "docs/get-started" } }],
        },
        {
          label: "How-to guides",
          items: [{ autogenerate: { directory: "docs/how-to" } }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "docs/reference" } }],
        },
        {
          label: "Explanation",
          items: [{ autogenerate: { directory: "docs/explanation" } }],
        },
      ],
    }),
    sitemap({
      // The /changelog/<release> stubs are noindex link-preview redirect pages;
      // Starlight also emits fallback copies of the English-only docs under
      // every configured locale. Keep both classes of noindex page out of the
      // sitemap rather than advertising untranslated fallback URLs.
      filter: (page) => {
        const pathname = new URL(page).pathname;
        return (
          !/\/changelog\/.+/u.test(pathname) &&
          !UI_LOCALES.some(
            (tag) =>
              tag !== "en" &&
              pathname.startsWith(`/${tag.toLowerCase()}/docs/`),
          )
        );
      },
      // Emit localized URLs + hreflang alternates in the sitemap. Keys are the
      // URL path segments (default locale at root keyed "en"); values are the
      // hreflang codes.
      i18n: {
        defaultLocale: "en",
        locales: sitemapLocales,
      },
      // <lastmod> from the newest commit touching each page's sources; a
      // shallow checkout emits none rather than a fabricated date.
      serialize: (item) => {
        const date = lastmod.lastmodFor(item.url);
        return date === undefined ? item : { ...item, lastmod: date };
      },
    }),
    react(),
    // Draws each page's social card from the title it just rendered; must run
    // after the pages exist, which `astro:build:done` guarantees.
    ogCards(),
  ],
  vite: {
    // Cross-origin isolation for the live anonymization demo's wasm (needs
    // SharedArrayBuffer). Set on Vite's dev server too — `astro dev` serves
    // through Vite's middleware, and Astro's top-level `server.headers` does
    // not reliably reach every dev response. `astro preview` and production
    // still rely on the top-level/host headers documented above.
    server: {
      headers: LANDING_SECURITY_HEADERS,
    },
    // Emits @stll/anonymize-wasm's binding + glue as build assets and
    // rewrites its runtime asset URLs so `astro build` (Vite/Rollup) can
    // resolve them (the package computes them at runtime, which Rollup
    // can't follow statically). The live anonymization demo only builds
    // pipelines in-browser from a PipelineConfig via
    // createNativePipelineFromConfig, never loadPipeline()/
    // loadDefaultPipeline(), so no bundled prepared package is needed —
    // "none" skips emitting the ~20MB+ default/per-language .stlanonpkg
    // assets that the plugin's default ("all") would otherwise bundle.
    plugins: [stllAnonymizeWasm({ packages: "none" }), tailwindcss()],
    worker: {
      // Vite bundles Worker entries (AnonymizeLiveDemo's
      // anonymize-demo-worker.ts) through a separate nested build that does
      // NOT inherit the top-level `plugins` array — only `worker.plugins`
      // reaches it (see Vite's worker-options docs). Without this, the
      // wasm plugin above never runs inside the worker bundle and Vite's
      // own "can't statically resolve this import.meta.url" fallback
      // includes every file in anonymize-wasm's native/ directory,
      // shipping ~35MB of unused prepared dictionaries.
      plugins: () => [stllAnonymizeWasm({ packages: "none" })],
      // Default worker output is "iife", which forbids top-level await;
      // the wasm loader's glue uses it. ES module workers support it and
      // match the modern browser target the rest of the build assumes.
      format: "es",
    },
  },
});
