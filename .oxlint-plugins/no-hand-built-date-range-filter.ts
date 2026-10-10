import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

// These dates describe a record's validity, not a query over records.
const FORM_OWNERS = [
  "routes/_protected.workspaces/$workspaceId/-components/billing/rate-management-dialog.tsx",
  "routes/_protected.settings/-components/organization/vat-rate-form.tsx",
];
const FROM_LABEL =
  /(?:[."'](?:dateFrom|from|auditLogsFrom)["']|>\s*(?:From|Od)(?:\s+date)?\s*<|["']From date["'])/u;
const TO_LABEL =
  /(?:[."'](?:dateTo|to|auditLogsTo)["']|>\s*(?:To|Do)(?:\s+date)?\s*<|["']To date["'])/u;

export default eslintCompatPlugin({
  meta: { name: "no-hand-built-date-range-filter" },
  rules: {
    "no-hand-built-date-range-filter": {
      meta: {
        type: "problem",
        messages: {
          sharedRange:
            "Use the shared DateRangeFilter for paired From/To date filters; it owns bounds, labels, and range selection.",
        },
      },
      createOnce(context) {
        const aliases = new Set<string>();
        const controls = new Map<object, number>();
        return {
          Program() {
            aliases.clear();
            controls.clear();
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !/\/(?:date-picker-popover|task-metadata)$/u.test(
                node.source.value,
              )
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                isIdentifier(specifier.imported, "DatePickerPopover")
              ) {
                aliases.add(specifier.local.name);
              }
            }
          },
          JSXOpeningElement(node) {
            const filename = filenameForContext(context);
            if (
              !(
                filename.includes("apps/web/src/") ||
                filename.includes("apps/api/src/mcp/apps/") ||
                filename.endsWith(
                  "/.oxlint-plugins/__fixtures__/no-hand-built-date-range-filter.fixture.tsx",
                )
              ) ||
              filename.endsWith("/components/date-range-filter.tsx") ||
              FORM_OWNERS.some((owner) => filename.endsWith(owner))
            ) {
              return;
            }
            const nativeDate = node.attributes.some(
              (attribute) =>
                attribute.type === "JSXAttribute" &&
                attribute.name.type === "JSXIdentifier" &&
                attribute.name.name === "type" &&
                isStringLiteral(attribute.value) &&
                attribute.value.value === "date",
            );
            if (
              node.name.type !== "JSXIdentifier" ||
              (!aliases.has(node.name.name) && !nativeDate)
            ) {
              return;
            }
            let ancestor: unknown = node.parent;
            while (isAstNode(ancestor)) {
              if (
                ancestor.type.endsWith("FunctionExpression") ||
                ancestor.type === "FunctionDeclaration"
              ) {
                break;
              }
              if (
                ancestor.type === "JSXElement" ||
                ancestor.type === "JSXFragment"
              ) {
                const source = context.sourceCode.getText(ancestor);
                if (FROM_LABEL.test(source) && TO_LABEL.test(source)) {
                  const count = (controls.get(ancestor) ?? 0) + 1;
                  controls.set(ancestor, count);
                  if (count === 2) {
                    context.report({ node, messageId: "sharedRange" });
                  }
                  break;
                }
              }
              ancestor = ancestor.parent;
            }
          },
        };
      },
    },
  },
});
