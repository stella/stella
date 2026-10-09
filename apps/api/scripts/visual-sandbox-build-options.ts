export const VISUAL_RUNTIME_BUILD_OPTIONS = {
  minify: true,
  target: "browser",
  format: "iife",
} as const satisfies Pick<Bun.BuildConfig, "minify" | "target" | "format">;

// The guest runtime inlines every used font face (~850 KB with DM Sans upright
// and italic plus Noto Sans Arabic); a new face or dependency must justify its
// bytes here.
export const VISUAL_RUNTIME_BYTE_BUDGET = 900_000;
