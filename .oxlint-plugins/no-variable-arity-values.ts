import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
// A SQL statement whose text changes with its data leaves a prepared plan on
// its connection for every length it ever sees: Bun keeps each prepared
// statement until the connection retires. `VALUES ${rows}` is that statement,
// and a page of a few hundred rows held 169 MiB on one connection against
// 1.5 MiB for the same rows as one jsonb parameter.
//
// New statements take one parameter instead:
//   jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS row(id uuid, ...)
// or `= ANY(${ids}::uuid[])` for a single column. A list whose length is a fixed
// constant is not this defect; say so in a disable comment naming the constant.
//
// The baseline holds the sites that predate the rule, as a count per file. A
// count may only fall: a new site fails, and a fixed one must shrink its entry.

import baseline from "./no-variable-arity-values-baseline.json" with { type: "json" };
import { isAstNode, repoRelativeFilename } from "./utils.ts";

const ENDS_IN_VALUES = /\bVALUES\s*$/iu;

const knownSites: Record<string, number> = baseline;

const quasiText = (quasi: unknown): string => {
  if (!isAstNode(quasi)) {
    return "";
  }
  const value: unknown = quasi.value;
  if (typeof value !== "object" || value === null) {
    return "";
  }
  if ("cooked" in value && typeof value.cooked === "string") {
    return value.cooked;
  }
  return "raw" in value && typeof value.raw === "string" ? value.raw : "";
};

export default eslintCompatPlugin({
  meta: { name: "no-variable-arity-values" },
  rules: {
    "no-variable-arity-values": {
      meta: {
        type: "problem",
        messages: {
          variableArity:
            "This VALUES list makes the statement's text vary with its data, so each length stays prepared on the connection. Pass one parameter: jsonb_to_recordset on a JSON string cast with ::text::jsonb, or = ANY on a typed array.",
          staleBaseline:
            "no-variable-arity-values-baseline.json allows {{allowed}} here, but this file has {{actual}}. Lower its entry, or remove it at zero.",
        },
      },
      createOnce(context) {
        const sites: ESTree.TemplateLiteral[] = [];
        return {
          before() {
            sites.length = 0;
          },
          TemplateLiteral(node) {
            const quasis: unknown = node.quasis;
            const expressions: unknown = node.expressions;
            if (!Array.isArray(quasis) || !Array.isArray(expressions)) {
              return;
            }
            for (let index = 0; index < expressions.length; index++) {
              if (ENDS_IN_VALUES.test(quasiText(quasis[index]))) {
                sites.push(node);
              }
            }
          },
          "Program:exit"(program) {
            const file = repoRelativeFilename(context);
            // One-off scripts and tests hold no long-lived pooled connection.
            if (/(?:^|\/)(?:scripts|tests|evals)\/|\.test\.tsx?$/u.test(file)) {
              return;
            }
            const allowed = knownSites[file] ?? 0;
            if (allowed === 0) {
              for (const node of sites) {
                context.report({ node, messageId: "variableArity" });
              }
              return;
            }
            if (sites.length > allowed) {
              for (const node of sites.slice(allowed)) {
                context.report({ node, messageId: "variableArity" });
              }
            } else if (sites.length < allowed) {
              context.report({
                node: program,
                messageId: "staleBaseline",
                data: {
                  allowed: String(allowed),
                  actual: String(sites.length),
                },
              });
            }
          },
        };
      },
    },
  },
});
