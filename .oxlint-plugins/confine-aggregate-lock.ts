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
            const sourceFile = repoRelativeFilename(context);
            const file =
              sourceFile ===
              ".oxlint-plugins/__fixtures__/confine-aggregate-lock.fixture.ts"
                ? "apps/api/src/handlers/planted.ts"
                : sourceFile;
            if (!aggregateLockSourceIncluded(file)) {
              return;
            }
            const sites = aggregateLockSites(file, context.sourceCode.text);
            const actual = aggregateLockBaseline(sites);
            for (const problem of aggregateLockBaselineProblems({
              actual,
              baseline: baseline.filter((row) => row.file === file),
            })) {
              const site = sites.at(0);
              context.report({
                ...(site === undefined
                  ? { node }
                  : { loc: { line: site.line, column: 1 } }),
                messageId: "unowned",
                data: { problem },
              });
            }
          },
        };
      },
    },
  },
});
