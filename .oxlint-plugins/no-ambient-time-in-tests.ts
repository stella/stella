import { eslintCompatPlugin } from "@oxlint/plugins";

import { BASELINE_PATHS } from "../scripts/baseline-paths.ts";
import { createTestDeterminismRule } from "./test-determinism-rule.ts";
import { createTimeResolver } from "./test-time-resolver.ts";

const RULE_NAME = "no-ambient-time-in-tests";
const rule = createTestDeterminismRule({
  baselinePath: BASELINE_PATHS.testAmbientTime,
  message:
    "Use createTestClock from @stll/test-kit instead of the ambient clock.",
  createDetector: (context) => createTimeResolver(context).isAmbientRead,
});

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: rule.meta,
      createOnce(context) {
        return rule.createOnce(context);
      },
    },
  },
});
