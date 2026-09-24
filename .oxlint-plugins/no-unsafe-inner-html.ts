// Forbid injecting un-proven HTML into the DOM.
//
// Raw HTML may only reach the DOM from a value that is provably
// sanitized / escaped. Stella renders server-highlighted legal content
// via `dangerouslySetInnerHTML` (search headlines escaped + <mark>-wrapped
// server-side by `escapeAndHighlight`). `react/no-danger` is OFF in
// oxlint.config.ts, so without this rule a future engineer could pipe an
// un-escaped DB / AI / user string into `__html` or `el.innerHTML` and turn
// stored data into stored XSS inside a privileged workspace.
//
// Sinks, all sharing one allowlist:
//   • `__html` of a `dangerouslySetInnerHTML` object, whether the object is a
//     JSX attribute value or a property of any object literal (props passed
//     to `createElement` / `jsx()`, or spread into JSX).
//   • assignment to `innerHTML`, `outerHTML` or `srcdoc`, dot or static
//     bracket notation, and the same keys in an `Object.assign` source.
//   • the JSX `srcDoc` attribute.
//   • `insertAdjacentHTML`, `setHTMLUnsafe`, `createContextualFragment`,
//     `setAttribute("srcdoc", …)`, and `write` / `writeln` on a document.
//
// A value is allowed when it is:
//   • a static string Literal or TemplateLiteral whose interpolations are all
//     independently static, OR
//   • annotated by a `// safe-html: <provenance>` comment with non-empty text
//     on the line directly above the sink. One comment covers one sink: a
//     second sink starting on the same line needs its own annotation.
//
// Function names are not proof: a local identity function can be named
// `sanitizeHtml`. Dynamic values therefore require explicit provenance at the
// sink until the codebase has a branded SafeHtml boundary.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  getPropertyName,
  invokedCallee,
  isAstNode,
  isIdentifier,
  isMemberAccess,
  isStringLiteral,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

// The provenance text after the marker must be non-empty.
const WAIVER_RE = /^\s*safe-html:\s*\S/u;

const DANGEROUS_PROP = "dangerouslySetInnerHTML";
const HTML_KEY = "__html";
const HTML_PROPERTIES: ReadonlySet<string> = new Set([
  "innerHTML",
  "outerHTML",
  "srcdoc",
]);
const DANGEROUS_PROP_ATTRIBUTES: ReadonlySet<string> = new Set([
  DANGEROUS_PROP,
]);
const SRCDOC_ATTRIBUTES: ReadonlySet<string> = new Set(["srcDoc", "srcdoc"]);
// Methods whose first argument is parsed as HTML.
const HTML_FIRST_ARGUMENT_METHODS: ReadonlySet<string> = new Set([
  "createContextualFragment",
  "setHTMLUnsafe",
]);
const DOCUMENT_WRITE_METHODS: ReadonlySet<string> = new Set([
  "write",
  "writeln",
]);
const DOCUMENT_MEMBERS: ReadonlySet<string> = new Set([
  "contentDocument",
  "document",
  "ownerDocument",
]);

type Located = { loc: { start: { line: number } } };

const hasLocation = (node: unknown): node is Located =>
  typeof node === "object" &&
  node !== null &&
  "loc" in node &&
  typeof node.loc === "object" &&
  node.loc !== null &&
  "start" in node.loc &&
  typeof node.loc.start === "object" &&
  node.loc.start !== null &&
  "line" in node.loc.start &&
  typeof node.loc.start.line === "number";

// A node without location data never matches a waiver line.
const startLine = (node: unknown): number =>
  hasLocation(node) ? node.loc.start.line : Number.NaN;

type WaiverComment = {
  value: string;
  loc: { end: { line: number } };
};

const isWaiverComment = (value: unknown): value is WaiverComment =>
  typeof value === "object" &&
  value !== null &&
  "value" in value &&
  typeof value.value === "string" &&
  WAIVER_RE.test(value.value) &&
  "loc" in value &&
  typeof value.loc === "object" &&
  value.loc !== null;

const isJsxIdentifierIn = (
  node: unknown,
  names: ReadonlySet<string>,
): boolean =>
  isAstNode(node) &&
  node.type === "JSXIdentifier" &&
  typeof node.name === "string" &&
  names.has(node.name);

// A value is proven safe by its own static shape, independent of comments.
const isProvenSafeValue = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (isStringLiteral(expression)) {
    return true;
  }
  return (
    expression.type === "TemplateLiteral" &&
    Array.isArray(expression.expressions) &&
    expression.expressions.every(isProvenSafeValue)
  );
};

// The static key of an object-literal Property: `a`, `"a"`, `["a"]`.
const objectPropertyKey = (property: unknown): string | null => {
  if (!isAstNode(property)) {
    return null;
  }
  if (property.computed === true && !isStringLiteral(property.key)) {
    return null;
  }
  return getPropertyName(property.key);
};

const objectProperties = (node: unknown): AstNode[] => {
  const expression = unwrapExpression(node);
  if (
    expression?.type !== "ObjectExpression" ||
    !Array.isArray(expression.properties)
  ) {
    return [];
  }
  return expression.properties.filter(isAstNode);
};

// The arguments the invoked function receives: `f.call(thisArg, ...args)`
// shifts them by one; `f.apply(thisArg, args)` passes an array this rule does
// not read, so it yields none.
const invokedArguments = (call: unknown): unknown[] => {
  if (!isAstNode(call)) {
    return [];
  }
  const args = Array.isArray(call.arguments) ? call.arguments : [];
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return args;
  }
  const method = memberPropertyName(callee);
  if (method === "call") {
    return args.slice(1);
  }
  return method === "apply" ? [] : args;
};

// `document.write`, `window.document.write`, `frame.contentDocument.write`,
// `node.ownerDocument.write`.
const isDocumentReceiver = (node: unknown): boolean => {
  const receiver = unwrapExpression(node);
  if (isIdentifier(receiver, "document")) {
    return true;
  }
  if (receiver?.type !== "MemberExpression") {
    return false;
  }
  const name = memberPropertyName(receiver);
  return name !== null && DOCUMENT_MEMBERS.has(name);
};

export default eslintCompatPlugin({
  meta: { name: "no-unsafe-inner-html" },
  rules: {
    "no-unsafe-inner-html": {
      meta: {
        type: "problem",
        messages: {
          unsafeInnerHtml:
            "Dynamic HTML injected into the DOM needs an adjacent " +
            "`// safe-html: <provenance>` comment naming the exact sanitizer " +
            "or trusted source. Function names alone are not proof because a " +
            "local identity function can shadow them.",
          unsafeInnerHtmlSpread:
            "Do not spread an object into dangerouslySetInnerHTML. Keep " +
            "`__html` inline so this rule can prove the HTML value is " +
            "sanitized or escaped.",
        },
      },
      createOnce(context) {
        // Line of each waiver comment's end; a sink starting on the next line
        // consumes it, so one comment covers exactly one sink.
        const waiverLines = new Set<number>();

        const consumeWaiver = (node: unknown): boolean => {
          const line = startLine(node) - 1;
          if (!waiverLines.has(line)) {
            return false;
          }
          waiverLines.delete(line);
          return true;
        };

        const reportIfUnsafe = (node: unknown): void => {
          if (!isAstNode(node) || isProvenSafeValue(node)) {
            return;
          }
          if (consumeWaiver(node)) {
            return;
          }
          context.report({ node, messageId: "unsafeInnerHtml" });
        };

        // The value of a `dangerouslySetInnerHTML` prop: an inline object has
        // its `__html` checked and its spreads rejected; anything else is a
        // hoisted payload whose HTML this rule cannot see.
        const checkDangerousPayload = (value: unknown): void => {
          const expression = unwrapExpression(value);
          if (expression?.type !== "ObjectExpression") {
            reportIfUnsafe(value);
            return;
          }
          for (const property of objectProperties(expression)) {
            if (property.type === "SpreadElement") {
              context.report({
                node: property,
                messageId: "unsafeInnerHtmlSpread",
              });
              continue;
            }
            if (
              property.type === "Property" &&
              objectPropertyKey(property) === HTML_KEY
            ) {
              reportIfUnsafe(property.value);
            }
          }
        };

        const checkHtmlPropertySources = (sources: unknown[]): void => {
          for (const source of sources) {
            for (const property of objectProperties(source)) {
              const key =
                property.type === "Property"
                  ? objectPropertyKey(property)
                  : null;
              if (key !== null && HTML_PROPERTIES.has(key)) {
                reportIfUnsafe(property.value);
              }
            }
          }
        };

        return {
          before() {
            waiverLines.clear();
          },
          Program(node) {
            const comments: unknown[] = Array.isArray(node.comments)
              ? node.comments
              : [];
            for (const comment of comments) {
              if (isWaiverComment(comment)) {
                waiverLines.add(comment.loc.end.line);
              }
            }
          },

          JSXAttribute(node) {
            const value = node.value;
            if (!isAstNode(value) || value.type !== "JSXExpressionContainer") {
              return;
            }
            if (isJsxIdentifierIn(node.name, DANGEROUS_PROP_ATTRIBUTES)) {
              checkDangerousPayload(value.expression);
              return;
            }
            if (isJsxIdentifierIn(node.name, SRCDOC_ATTRIBUTES)) {
              reportIfUnsafe(value.expression);
            }
          },

          // `{ dangerouslySetInnerHTML: … }` outside a JSX attribute: props
          // for `createElement` / `jsx()`, or an object spread into JSX.
          Property(node) {
            if (objectPropertyKey(node) !== DANGEROUS_PROP) {
              return;
            }
            const container = node.parent;
            if (
              !isAstNode(container) ||
              container.type !== "ObjectExpression"
            ) {
              return;
            }
            checkDangerousPayload(node.value);
          },

          AssignmentExpression(node) {
            const target = unwrapExpression(node.left);
            if (target?.type !== "MemberExpression") {
              return;
            }
            const name = memberPropertyName(target);
            if (name !== null && HTML_PROPERTIES.has(name)) {
              reportIfUnsafe(node.right);
            }
          },

          CallExpression(node) {
            const call: unknown = node;
            const callee = isAstNode(call) ? invokedCallee(call) : null;
            if (callee?.type !== "MemberExpression") {
              return;
            }
            const args = invokedArguments(node);
            const method = memberPropertyName(callee);
            if (method === null) {
              return;
            }
            if (HTML_FIRST_ARGUMENT_METHODS.has(method)) {
              reportIfUnsafe(args.at(0));
              return;
            }
            if (method === "insertAdjacentHTML") {
              reportIfUnsafe(args.at(1));
              return;
            }
            if (method === "setAttribute") {
              const attribute = unwrapExpression(args.at(0));
              if (
                isStringLiteral(attribute) &&
                attribute.value.toLowerCase() === "srcdoc"
              ) {
                reportIfUnsafe(args.at(1));
              }
              return;
            }
            if (
              DOCUMENT_WRITE_METHODS.has(method) &&
              isDocumentReceiver(callee.object)
            ) {
              if (!args.every(isProvenSafeValue) && !consumeWaiver(node)) {
                context.report({ node, messageId: "unsafeInnerHtml" });
              }
              return;
            }
            if (isMemberAccess(callee, "Object", "assign")) {
              checkHtmlPropertySources(args.slice(1));
            }
          },
        };
      },
    },
  },
});
