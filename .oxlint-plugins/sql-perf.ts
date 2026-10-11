// Guard reviewable SQL scan shapes. Existing unsuppressed hits are held by a
// per-file shrink-only baseline; a new hit reports every unsuppressed site in
// that file. A nearby sql-perf-allow comment must give a concrete bound.
// Per-source counts require single-source equality; grouped source facets are not covered.

import { eslintCompatPlugin } from "@oxlint/plugins";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import {
  analyzeSqlPerf,
  isBaselinedSqlPerfKind,
} from "../scripts/sql-perf-detector.ts";
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
          "or-subquery": message("OR with a subquery operand"),
          "optional-keyset": message(
            "An optional keyset bound (<param> IS NULL OR <column> > <param>)",
          ),
          "per-source-full-count": message(
            "Per-source full COUNT or SUM(1) aggregation over a corpus table",
          ),
          comment: "{{reason}}",
        },
      },
      createOnce(context) {
        return {
          Program() {
            const filename = filenameForContext(context);
            const relative = repoRelativePath(ROOT, path.resolve(filename));
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
            const legacyHits = hits.filter((hit) =>
              isBaselinedSqlPerfKind(hit.kind),
            );
            const legacyOverBaseline =
              legacyHits.length > (baseline.get(relative) ?? 0);
            for (const hit of hits) {
              if (isBaselinedSqlPerfKind(hit.kind) && !legacyOverBaseline) {
                continue;
              }
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
