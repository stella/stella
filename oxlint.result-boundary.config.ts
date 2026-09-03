import { defineConfig } from "oxlint";

export default defineConfig({
  jsPlugins: [
    "./.oxlint-plugins/no-throw-outside-boundary.ts",
    "./.oxlint-plugins/no-try-catch-outside-boundary.ts",
  ],
  rules: {
    "no-throw-outside-boundary/no-throw-outside-boundary": "error",
    "no-try-catch-outside-boundary/no-try-catch-outside-boundary": "error",
  },
});
