import path from "node:path";

/** The committed Tailwind cache that every lint reads. */
export const TAILWIND_LINT_CACHE_DIR = path.join(
  import.meta.dirname,
  "..",
  ".tailwind-cache",
);

// Every lint reads the committed Tailwind cache and never compiles the design
// system; only scripts/generate-tailwind-classes.ts opts out to fill it.
// oxlint.config.ts imports this module, and the config loads before any plugin
// module, so the plugin sees these defaults.
process.env["OXLINT_TAILWINDCSS_CACHE_DIR"] ??= TAILWIND_LINT_CACHE_DIR;
process.env["OXLINT_TAILWINDCSS_CACHE_READ_ONLY"] ??= "1";
