import { defineConfig } from "oxlint";
import shadcn from "ultracite/oxlint/shadcn";

import repository from "./oxlint.config.ts";
import {
  SHADCN_LINT_JS_PLUGINS,
  SHADCN_LINT_POLICY_OVERRIDES,
  SHADCN_LINT_RULES,
  SHADCN_LINT_SETTINGS,
} from "./scripts/shadcn-lint-policy.ts";

// Design-system pass for scripts/shadcn-lint-baseline.ts: the shadcn rules
// under the repository policy, without the backlog overrides, so the guard can
// measure what each listed file still carries. Oxlint enables its correctness
// category by default, which would assert rules the main config turns off.
export default defineConfig({
  extends: [shadcn],
  categories: { correctness: "off" },
  ignorePatterns: repository.ignorePatterns,
  jsPlugins: SHADCN_LINT_JS_PLUGINS,
  settings: { shadcn: SHADCN_LINT_SETTINGS },
  rules: SHADCN_LINT_RULES,
  overrides: [...SHADCN_LINT_POLICY_OVERRIDES],
});
