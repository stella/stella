import { eslintCompatPlugin } from "@oxlint/plugins";

import { BASELINE_PATHS } from "../scripts/baseline-paths.ts";
import { SLEEP_HELPERS } from "./no-hand-rolled-concurrency.ts";
import { createTestDeterminismRule } from "./test-determinism-rule.ts";
import { createTimeResolver } from "./test-time-resolver.ts";

const RULE_NAME = "no-real-timers-in-tests";
const IMPORTED_HELPERS = "importedSleepHelpers";
const IMPORTED_TIMERS = "importedNativeTimers";

const rule = createTestDeterminismRule({
  baselinePath: BASELINE_PATHS.testRealTimers,
  message:
    "Use createTestClock, deferred, waitForEvent, settledWithin, or waitFor from @stll/test-kit instead of real timers in tests.",
  createDetector(context) {
    const { callablePaths } = createTimeResolver(context, {
      additionalGlobals: SLEEP_HELPERS,
      importedPaths: ({ source, imported }) => {
        if (
          [
            "node:timers",
            "timers",
            "node:timers/promises",
            "timers/promises",
          ].includes(source) &&
          ["setTimeout", "setInterval", "*", "default"].includes(imported)
        ) {
          return [
            imported === "*" || imported === "default"
              ? IMPORTED_TIMERS
              : imported,
          ];
        }
        return source !== "@stll/test-kit" &&
          !source.startsWith("@stll/test-kit/") &&
          (SLEEP_HELPERS.has(imported) || imported === "*")
          ? [imported === "*" ? IMPORTED_HELPERS : imported]
          : [];
      },
    });
    return (node) => {
      if (node.type !== "CallExpression") {
        return false;
      }
      return callablePaths(node.callee).some(
        (path) =>
          path === "setTimeout" ||
          path === "setInterval" ||
          path === "Bun.sleep" ||
          SLEEP_HELPERS.has(path) ||
          (path.startsWith(`${IMPORTED_HELPERS}.`) &&
            SLEEP_HELPERS.has(path.slice(IMPORTED_HELPERS.length + 1))) ||
          path === `${IMPORTED_TIMERS}.setTimeout` ||
          path === `${IMPORTED_TIMERS}.setInterval`,
      );
    };
  },
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
