export const VISUAL_RUNTIME_BUILD_OPTIONS = {
  minify: true,
  target: "browser",
  format: "iife",
} as const satisfies Pick<Bun.BuildConfig, "minify" | "target" | "format">;
