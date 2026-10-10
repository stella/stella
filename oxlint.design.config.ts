import { panic } from "better-result";
import { defineConfig } from "oxlint";

import repository from "./oxlint.config.ts";
import {
  BUILTIN_LINT_BACKLOG_RULES,
  DESIGN_LINT_MEASURED_RULES,
  SHADCN_LINT_JS_PLUGINS,
  SHADCN_LINT_POLICY_OVERRIDES,
  SHADCN_LINT_SETTINGS,
  SIZE_LINT_UNMEASURED,
  isDesignLintLocalPlugin,
  isDesignLintLocalRuleScope,
  sizeLintPolicyOverrides,
} from "./scripts/design-lint-policy.ts";
import { flattenLayers } from "./scripts/oxlint-effective-config.ts";
import shadcn from "./scripts/oxlint-presets/shadcn.mjs";

// The built-in backlog rules carry the value the repository lint resolves:
// its own entry, else the last preset that names the rule. Both spellings of
// an ESLint core rule count.
const repositoryRuleLayers = flattenLayers(repository, "oxlint.config.ts").map(
  ({ rules }) => rules,
);
const repositoryRule = (rule: string) => {
  const spellings = [rule, rule.replace(/^eslint\//u, "")];
  const values = repositoryRuleLayers.flatMap((layer) =>
    spellings.flatMap((spelling) =>
      layer[spelling] === undefined ? [] : [layer[spelling]],
    ),
  );
  return (
    values.at(-1) ??
    panic(`oxlint.config.ts and its presets do not configure ${rule}`)
  );
};
const builtinBacklogRules = Object.fromEntries(
  BUILTIN_LINT_BACKLOG_RULES.map((rule) => [rule, repositoryRule(rule)]),
);

// Design-system pass for scripts/design-lint-baseline.ts: the tracked rules
// under the repository policy, without the backlog overrides, so the guard can
// measure what each listed file still carries. The local plugins and the file
// scopes that enable them are selected out of the repository config, so the
// two passes cannot enable a rule over different files; the size limits share
// their scopes with the repository lint the same way, minus the ceilings the
// repository lint keeps on exempt files. Oxlint enables its
// correctness category by default, which would assert rules the main config
// turns off.
export default defineConfig({
  extends: [shadcn],
  categories: { correctness: "off" },
  plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "promise"],
  ignorePatterns: repository.ignorePatterns,
  jsPlugins: [
    ...SHADCN_LINT_JS_PLUGINS,
    ...repository.jsPlugins.filter(isDesignLintLocalPlugin),
  ],
  settings: { shadcn: SHADCN_LINT_SETTINGS },
  rules: { ...DESIGN_LINT_MEASURED_RULES, ...builtinBacklogRules },
  overrides: [
    ...SHADCN_LINT_POLICY_OVERRIDES,
    ...sizeLintPolicyOverrides(SIZE_LINT_UNMEASURED),
    ...repository.overrides.filter(isDesignLintLocalRuleScope),
  ],
});
