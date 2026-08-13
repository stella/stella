import { eslintCompatPlugin } from "@oxlint/plugins";
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
// Two sinks share one allowlist:
//   • JSX `__html` property of a `dangerouslySetInnerHTML` object literal
//     (report on the value expression).
//   • `AssignmentExpression` whose LHS is a non-computed `.innerHTML`
//     MemberExpression (report on the RHS).
//
// A value is allowed when it is:
//   • a static string Literal or TemplateLiteral whose interpolations are all
//     independently static, OR
//   • carries an explicit `// safe-html:` provenance comment on the line
//     directly above the sink (loc adjacency, like suppression-hygiene.ts).
//
// Function names are not proof: a local identity function can be named
// `sanitizeHtml`. Dynamic values therefore require explicit provenance at the
// sink until the codebase has a branded SafeHtml boundary.
//
// Flagged:
//   <div dangerouslySetInnerHTML={{ __html: userInput }} />
//   <div dangerouslySetInnerHTML={{ __html: hit.headline }} />   // unless annotated
//   el.innerHTML = html;                                         // unless annotated
//   el.innerHTML = data.body;
//
// Allowed:
//   el.innerHTML = "";
//   el.innerHTML = "&nbsp;";
//   // safe-html: server-escaped by escapeAndHighlight()
//   <div dangerouslySetInnerHTML={{ __html: hit.headline }} />

import { getPropertyName, isIdentifier, unwrapExpression } from "./utils.ts";

const ESCAPE_HATCH_RE = /^\s*safe-html:/u;

const isComment = (value) =>
  typeof value === "object" &&
  value !== null &&
  typeof value.value === "string" &&
  typeof value.loc === "object" &&
  value.loc !== null;

const isJsxIdentifier = (node, name) =>
  typeof node === "object" &&
  node !== null &&
  node.type === "JSXIdentifier" &&
  node.name === name;

// A value is proven safe by its own static shape, independent of comments.
const isProvenSafeValue = (node) => {
  if (!node || typeof node.type !== "string") {
    return false;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return true;
  }
  if (node.type === "TemplateLiteral") {
    return (
      Array.isArray(node.expressions) &&
      node.expressions.every(isProvenSafeValue)
    );
  }
  return false;
};

const isDangerouslySetInnerHtmlValue = (property) => {
  if (getPropertyName(property.key) !== "__html") {
    return false;
  }
  const objectExpression = property.parent;
  if (objectExpression?.type !== "ObjectExpression") {
    return false;
  }

  let current = objectExpression.parent;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression"
  ) {
    current = current.parent;
  }

  if (current?.type !== "JSXExpressionContainer") {
    return false;
  }
  const attribute = current.parent;
  return (
    attribute?.type === "JSXAttribute" &&
    isJsxIdentifier(attribute.name, "dangerouslySetInnerHTML")
  );
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
        const escapeHatchLines = new Set();

        const recordEscapeHatches = (node) => {
          const comments =
            node && Array.isArray(node.comments)
              ? node.comments.filter(isComment)
              : [];
          for (const comment of comments) {
            if (ESCAPE_HATCH_RE.test(comment.value)) {
              escapeHatchLines.add(comment.loc.end.line);
            }
          }
        };

        // The escape-hatch comment sits on the line directly above the
        // reported node's first line. Sink expressions inside JSX object
        // literals span multiple lines, so anchor on the node's start line.
        const hasEscapeHatchAbove = (node) =>
          escapeHatchLines.has(node.loc.start.line - 1);

        const reportIfUnsafe = (node) => {
          if (isProvenSafeValue(node)) {
            return;
          }
          if (hasEscapeHatchAbove(node)) {
            return;
          }
          context.report({ node, messageId: "unsafeInnerHtml" });
        };

        const reportPayloadSpreads = (objectNode) => {
          for (const property of objectNode.properties) {
            if (property?.type !== "SpreadElement") {
              continue;
            }
            context.report({
              node: property,
              messageId: "unsafeInnerHtmlSpread",
            });
          }
        };

        return {
          before() {
            escapeHatchLines.clear();
          },
          Program(node) {
            recordEscapeHatches(node);
          },

          // Reject hoisted payloads such as
          // `dangerouslySetInnerHTML={payload}`. Keeping the `__html` object
          // inline lets this rule inspect the actual HTML expression.
          JSXAttribute(node) {
            if (!isJsxIdentifier(node.name, "dangerouslySetInnerHTML")) {
              return;
            }
            const value = node.value;
            if (value?.type !== "JSXExpressionContainer") {
              return;
            }
            const expression = unwrapExpression(value.expression);
            if (expression?.type === "ObjectExpression") {
              reportPayloadSpreads(expression);
              return;
            }
            reportIfUnsafe(value.expression);
          },

          // Sink 1: `dangerouslySetInnerHTML={{ __html: <expr> }}`.
          Property(node) {
            if (!isDangerouslySetInnerHtmlValue(node)) {
              return;
            }
            reportIfUnsafe(node.value);
          },

          // Sink 2: `<el>.innerHTML = <expr>` (non-computed member LHS).
          AssignmentExpression(node) {
            const target = node.left;
            if (
              target.type !== "MemberExpression" ||
              target.computed ||
              !isIdentifier(target.property, "innerHTML")
            ) {
              return;
            }
            reportIfUnsafe(node.right);
          },
        };
      },
    },
  },
});
