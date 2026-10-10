import { eslintCompatPlugin, type Node } from "@oxlint/plugins";

import {
  statusWriteCalls,
  type StatusColumns,
} from "../scripts/status-write-shapes.ts";
import { filenameForContext } from "./utils.ts";

const columnsFrom = (value: unknown): StatusColumns => {
  const columns: Record<string, readonly string[]> = {};
  if (typeof value !== "object" || value === null) {
    return columns;
  }
  for (const [table, keys] of Object.entries(value)) {
    if (Array.isArray(keys) && keys.every((key) => typeof key === "string")) {
      columns[table] = keys;
    }
  }
  return columns;
};

export default eslintCompatPlugin({
  meta: { name: "no-direct-status-set" },
  rules: {
    "no-direct-status-set": {
      meta: {
        type: "problem",
        messages: {
          statusOwner:
            "Lifecycle writes belong to {{owner}}. Call transition and handle its Transitioned or Stale result; direct writes can only shrink.",
        },
        schema: [
          {
            type: "object",
            properties: {
              owner: { type: "string" },
              columns: { type: "object" },
            },
            required: ["owner", "columns"],
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        let ranges = new Set<string>();
        let owner = "";
        const report = (node: Node) => {
          if (ranges.has(`${node.range[0]}:${node.range[1]}`)) {
            context.report({ node, messageId: "statusOwner", data: { owner } });
          }
        };
        return {
          before() {
            ranges = new Set();
            const options = context.options[0];
            if (typeof options !== "object" || options === null) {
              return false;
            }
            owner = Reflect.get(options, "owner");
            return !filenameForContext(context).endsWith(owner);
          },
          Program() {
            const options = context.options[0];
            if (typeof options !== "object" || options === null) {
              return;
            }
            const matches = statusWriteCalls({
              content: context.sourceCode.text,
              file: filenameForContext(context),
              columns: columnsFrom(Reflect.get(options, "columns")),
            });
            ranges = new Set(
              matches.map((match) => `${match.getStart()}:${match.getEnd()}`),
            );
          },
          CallExpression(node) {
            report(node);
          },
          TaggedTemplateExpression(node) {
            report(node);
          },
          TemplateLiteral(node) {
            report(node);
          },
          Literal(node) {
            report(node);
          },
          BinaryExpression(node) {
            report(node);
          },
        };
      },
    },
  },
});
