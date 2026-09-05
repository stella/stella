import { defineConfig } from "oxlint";

// Exact-boundary pass over changed files: only the two boundary rules run.
// Oxlint enables its correctness category by default, which would assert
// rules the main config deliberately turns off (`unicorn/no-useless-spread`
// among them) and fail files that pass the repository lint.
export default defineConfig({
  categories: { correctness: "off" },
  jsPlugins: [
    "./.oxlint-plugins/no-throw-outside-boundary.ts",
    "./.oxlint-plugins/no-try-catch-outside-boundary.ts",
  ],
  rules: {
    "no-throw-outside-boundary/no-throw-outside-boundary": "error",
    "no-try-catch-outside-boundary/no-try-catch-outside-boundary": "error",
  },
});
