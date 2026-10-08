import { eslintCompatPlugin } from "@oxlint/plugins";

import baseline from "../scripts/aggregate-lock-baseline.json" with { type: "json" };
import {
  aggregateLockBaseline,
  aggregateLockBaselineProblems,
  aggregateLockSites,
  aggregateLockSourceIncluded,
} from "./aggregate-lock-sites.ts";
import { repoRelativeFilename } from "./utils.ts";

const RULE_NAME = "confine-aggregate-lock";
export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          unowned:
            "{{problem}}. Acquire aggregate locks through apps/api/src/lib/db/aggregate-lock.ts; remove migrated baseline rows.",
        },
      },
      createOnce(context) {
        return {
          Program(node) {
            const file = repoRelativeFilename(context);
            if (!aggregateLockSourceIncluded(file)) {
              return;
            }
            const actual = aggregateLockBaseline(
              aggregateLockSites(file, context.sourceCode.text),
            );
            for (const problem of aggregateLockBaselineProblems({
              actual,
              baseline: baseline.filter((row) => row.file === file),
            })) {
              context.report({ node, messageId: "unowned", data: { problem } });
            }
          },
        };
      },
    },
  },
});
