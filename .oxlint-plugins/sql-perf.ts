// Guard reviewable SQL scan shapes. Existing unsuppressed hits are held by a
// per-file shrink-only baseline; a new hit reports every unsuppressed site in
// that file. A nearby sql-perf-allow comment must give a concrete bound.

import { eslintCompatPlugin } from "@oxlint/plugins";
import path from "node:path";

import { analyzeSqlPerf } from "../scripts/sql-perf-detector.ts";
import baselineCounts from "./sql-perf-baseline.json" with { type: "json" };
import { filenameForContext } from "./utils.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const baseline = new Map(Object.entries(baselineCounts));

const message = (shape: string) =>
  `${shape} can scan rows before output is bounded. Use // sql-perf-allow: ` +
  `small table <name>, index <name>, or bounded by <description> when safe.`;

export default eslintCompatPlugin({
  meta: { name: "sql-perf" },
  rules: {
    "sql-perf": {
      meta: {
        type: "problem",
        messages: {
          "leading-wildcard": message("Leading-wildcard LIKE"),
          "s3-key-like": message("LIKE on an S3-key column"),
          "group-by-expression": message("Corpus GROUP BY expression"),
          comment: "{{reason}}",
        },
      },
      createOnce(context) {
        return {
          Program() {
            const filename = filenameForContext(context);
            const relative = path
              .relative(ROOT, path.resolve(filename))
              .replaceAll("\\", "/");
            const { hits, commentErrors } = analyzeSqlPerf(
              context.sourceCode.text,
              relative,
            );
            for (const error of commentErrors) {
              context.report({
                loc: { line: error.line, column: 1 },
                messageId: "comment",
                data: { reason: error.message },
              });
            }
            if (hits.length <= (baseline.get(relative) ?? 0)) {
              return;
            }
            for (const hit of hits) {
              context.report({
                loc: { line: hit.line, column: hit.column },
                messageId: hit.kind,
              });
            }
          },
        };
      },
    },
  },
});
