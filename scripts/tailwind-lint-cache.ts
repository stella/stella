import path from "node:path";

/** The ignored, generated Tailwind cache that every lint reads. */
export const TAILWIND_LINT_CACHE_DIR = path.join(
  import.meta.dirname,
  "..",
  ".tailwind-cache",
);

// Every lint reads the generated Tailwind cache and never compiles the design
// system; the cache generation task opts out to fill it before lint starts.
// oxlint.config.ts imports this module, and the config loads before any plugin
// module, so the plugin sees these defaults.
process.env["OXLINT_TAILWINDCSS_CACHE_DIR"] ??= TAILWIND_LINT_CACHE_DIR;
process.env["OXLINT_TAILWINDCSS_CACHE_READ_ONLY"] ??= "1";
