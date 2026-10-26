import { defineConfig, type DummyRuleMap, type OxlintConfig } from "oxlint";

import oxlintConfig from "./oxlint.config.ts";

const repository: OxlintConfig = oxlintConfig;

const tailwindRules = (rules: DummyRuleMap | undefined): DummyRuleMap =>
  Object.fromEntries(
    Object.entries(rules ?? {}).filter(([rule]) =>
      rule.startsWith("tailwindcss/"),
    ),
  );

// Tailwind cache generation for scripts/generate-tailwind-classes.ts: only the
// Tailwind rules, with the repository lint's files, options, settings and
// ignores, so they ask the design system for the same classes the repository
// lint asks for, without loading or running every other plugin. Oxlint enables
// its correctness category by default, which this pass does not need.
export default defineConfig({
  categories: { correctness: "off" },
  plugins: [],
  ignorePatterns: repository.ignorePatterns ?? [],
  jsPlugins: ["oxlint-tailwindcss"],
  settings: { tailwindcss: repository.settings?.tailwindcss },
  rules: tailwindRules(repository.rules),
  overrides: (repository.overrides ?? []).flatMap(
    ({ files, excludeFiles, rules }) => {
      const scoped = tailwindRules(rules);
      return Object.keys(scoped).length === 0
        ? []
        : [
            {
              files,
              ...(excludeFiles === undefined ? {} : { excludeFiles }),
              rules: scoped,
            },
          ];
    },
  ),
});
