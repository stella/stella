import { eslintCompatPlugin } from "@oxlint/plugins";
// One loading indicator: `Loader` / `LoaderState` from `@stll/ui/loader`
// (the Stella mark breathing), or a `Skeleton` where the content's shape is
// known. Everything else — a lucide spinner, a `animate-spin`/`animate-pulse`
// utility on an arbitrary element, a hand-rolled `role="progressbar"` — is a
// second loading vocabulary the product does not have.
//
// Flags:
//   <LoaderIcon className="animate-spin" />
//   <Loader2Icon />
//   <div className="size-4 animate-spin" />
//   <div className="bg-muted h-4 animate-pulse" />
//   <div role="progressbar" />
//
// Allows:
//   <Loader label={t("common.loading")} />
//   <Skeleton className="h-4 w-1/3" />
//
// `allowedFiles` is a ratchet over the sites that predate the rule: it can
// only shrink, and a new file cannot add itself.

import { filenameForContext, isAstNode, isStringLiteral } from "./utils.ts";

const LOADER_ICON_NAMES = new Set([
  "LoaderIcon",
  "Loader2Icon",
  "LoaderCircleIcon",
  "LoaderPinwheelIcon",
]);

const BANNED_UTILITY = /(?:^|\s)animate-(?:spin|pulse)(?:\s|$)/u;

const isAllowedFile = (
  context: { filename?: unknown; getFilename?: () => string },
  allowedFiles: unknown[],
): boolean => {
  const filename = filenameForContext(context);
  return allowedFiles.some((allowedFile) => {
    if (typeof allowedFile === "string") {
      return filename.endsWith(allowedFile);
    }
    return (
      typeof allowedFile === "object" &&
      allowedFile !== null &&
      "path" in allowedFile &&
      typeof allowedFile.path === "string" &&
      filename.endsWith(allowedFile.path)
    );
  });
};

const jsxElementName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxElementName(node.property);
  }
  return null;
};

const jsxAttributeName = (node: unknown): string | null =>
  isAstNode(node) &&
  isAstNode(node.name) &&
  node.name.type === "JSXIdentifier" &&
  typeof node.name.name === "string"
    ? node.name.name
    : null;

// A className that is a plain string, or a template/expression whose static
// string parts are inspectable: `cn("a animate-spin", x)` is caught through
// its literal arguments, `className={spin}` is not (it cannot be proven).
const staticStrings = (node: unknown, out: string[]): void => {
  if (!isAstNode(node)) {
    return;
  }
  if (isStringLiteral(node)) {
    out.push(node.value);
    return;
  }
  if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
    for (const quasi of node.quasis) {
      // A quasi's `value` is a plain `{ raw, cooked }` record, not an AST
      // node, so it is narrowed by shape rather than by `type`.
      const value: unknown = isAstNode(quasi) ? quasi.value : undefined;
      const cooked =
        typeof value === "object" && value !== null && "cooked" in value
          ? value.cooked
          : undefined;
      if (typeof cooked === "string") {
        out.push(cooked);
      }
    }
    return;
  }
  if (node.type === "JSXExpressionContainer") {
    staticStrings(node.expression, out);
    return;
  }
  if (node.type === "CallExpression" && Array.isArray(node.arguments)) {
    for (const argument of node.arguments) {
      staticStrings(argument, out);
    }
    return;
  }
  if (
    node.type === "LogicalExpression" ||
    node.type === "ConditionalExpression"
  ) {
    staticStrings(node.consequent ?? node.left, out);
    staticStrings(node.alternate ?? node.right, out);
  }
};

export default eslintCompatPlugin({
  meta: { name: "no-adhoc-loader" },
  rules: {
    "no-adhoc-loader": {
      meta: {
        type: "problem",
        messages: {
          loaderIcon:
            "Do not render '{{name}}' as a loading indicator. Use `Loader` from '@stll/ui/loader'.",
          animateUtility:
            "Do not build a loading indicator from 'animate-{{utility}}'. Use `Loader` from '@stll/ui/loader', or `Skeleton` when the content's shape is known.",
          progressbar:
            "Do not hand-roll a progress bar. State progress in `LoaderState`'s detail text, or use `Skeleton` for content with a known shape.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: {
                type: "array",
                items: {
                  anyOf: [
                    { type: "string" },
                    {
                      type: "object",
                      properties: {
                        path: { type: "string" },
                        reason: { type: "string" },
                      },
                      required: ["path", "reason"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        return {
          before() {
            const options = context.options.at(0);
            const allowedFiles =
              typeof options === "object" &&
              options !== null &&
              !Array.isArray(options) &&
              Array.isArray(options.allowedFiles)
                ? options.allowedFiles
                : [];
            return !isAllowedFile(context, allowedFiles);
          },
          JSXOpeningElement(node) {
            const name = jsxElementName(node.name);
            if (name !== null && LOADER_ICON_NAMES.has(name)) {
              context.report({ node, messageId: "loaderIcon", data: { name } });
            }
          },
          JSXAttribute(node) {
            const name = jsxAttributeName(node);
            if (name === "role" && isStringLiteral(node.value)) {
              if (node.value.value === "progressbar") {
                context.report({ node, messageId: "progressbar" });
              }
              return;
            }
            if (name !== "className") {
              return;
            }
            const parts: string[] = [];
            staticStrings(node.value, parts);
            for (const part of parts) {
              const match = BANNED_UTILITY.exec(part);
              if (match !== null) {
                const utility = match[0].trim().slice("animate-".length);
                context.report({
                  node,
                  messageId: "animateUtility",
                  data: { utility },
                });
                return;
              }
            }
          },
        };
      },
    },
  },
});
