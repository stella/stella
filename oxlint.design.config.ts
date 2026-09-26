import { defineConfig } from "oxlint";
import shadcn from "ultracite/oxlint/shadcn";

import repository from "./oxlint.config.ts";
import {
  DESIGN_LINT_MEASURED_RULES,
  SHADCN_LINT_JS_PLUGINS,
  SHADCN_LINT_POLICY_OVERRIDES,
  SHADCN_LINT_SETTINGS,
  SIZE_LINT_UNMEASURED,
  isDesignLintLocalPlugin,
  isDesignLintLocalRuleScope,
  sizeLintPolicyOverrides,
} from "./scripts/design-lint-policy.ts";

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
  ignorePatterns: repository.ignorePatterns,
  jsPlugins: [
    ...SHADCN_LINT_JS_PLUGINS,
    ...repository.jsPlugins.filter(isDesignLintLocalPlugin),
  ],
  settings: { shadcn: SHADCN_LINT_SETTINGS },
  rules: DESIGN_LINT_MEASURED_RULES,
  overrides: [
    ...SHADCN_LINT_POLICY_OVERRIDES,
    ...sizeLintPolicyOverrides(SIZE_LINT_UNMEASURED),
    ...repository.overrides.filter(isDesignLintLocalRuleScope),
  ],
});
