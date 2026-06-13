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
//   • a string Literal or TemplateLiteral (static markup, no injection), OR
//   • a CallExpression whose callee name matches
//     /^(sanitize|escape|purify|dompurify)/i — a sanitizer/escaper —
//     including a `.value` / `.data` / `.html`-style member read OFF such a
//     call (some sanitizers return `{ value }`), OR
//   • carries an explicit `// safe-html:` escape-hatch comment on the line
//     directly above the sink (loc adjacency, like suppression-hygiene.ts).
//
// A value is NOT auto-allowed just because the identifier is named
// `html` / `content` / `headline` / `body` — those are the sinks, not
// proof of safety. Prove safety at the source or annotate with a reason.
//
// Flagged:
//   <div dangerouslySetInnerHTML={{ __html: userInput }} />
//   <div dangerouslySetInnerHTML={{ __html: hit.headline }} />   // unless annotated
//   el.innerHTML = html;                                         // unless annotated
//   el.innerHTML = data.body;
//
// Allowed:
//   <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(x) }} />
//   <div dangerouslySetInnerHTML={{ __html: `<b>${escapeXml(n)}</b>` }} />
//   <div dangerouslySetInnerHTML={{ __html: purify(x).value }} />
//   el.innerHTML = "";
//   el.innerHTML = "&nbsp;";
//   // safe-html: server-escaped by escapeAndHighlight()
//   <div dangerouslySetInnerHTML={{ __html: hit.headline }} />

import { getCalleeName, getPropertyName, isIdentifier } from "./utils.ts";

// Callee names that prove the value was run through a sanitizer / escaper.
// Matched against the resolved dotted callee path; the leaf name must start
// with one of these stems (case-insensitive).
const SANITIZER_CALLEE_RE = /^(sanitize|escape|purify|dompurify)/i;

// Members that some sanitizers expose on their result object
// (`purify(x).value`, `sanitize(x).html`). Reading one of these OFF a
// sanitizer call is still proven-safe.
const SANITIZER_RESULT_MEMBERS = new Set(["value", "data", "html"]);

const ESCAPE_HATCH_RE = /^\s*safe-html:/u;

const isComment = (value) =>
  typeof value === "object" &&
  value !== null &&
  typeof value.value === "string" &&
  typeof value.loc === "object" &&
  value.loc !== null;

const leafCalleeName = (callee) => {
  const dotted = getCalleeName(callee);
  if (dotted === null) {
    return null;
  }
  const parts = dotted.split(".");
  return parts[parts.length - 1] ?? null;
};

const isSanitizerCall = (node) => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const leaf = leafCalleeName(node.callee);
  return leaf !== null && SANITIZER_CALLEE_RE.test(leaf);
};

// A value is proven safe by its own shape (independent of any comment):
// static string, or the result of a sanitizer call (directly, or via a
// `.value`/`.data`/`.html` accessor off the call).
const isProvenSafeValue = (node) => {
  if (!node || typeof node.type !== "string") {
    return false;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return true;
  }
  if (node.type === "TemplateLiteral") {
    return true;
  }
  if (isSanitizerCall(node)) {
    return true;
  }
  // `sanitize(x).value`, `purify(x).html` — a result accessor off a call.
  if (
    node.type === "MemberExpression" &&
    node.computed === false &&
    isProvenSafeMemberLeaf(node)
  ) {
    return true;
  }
  return false;
};

const isProvenSafeMemberLeaf = (node) => {
  const propertyName = getPropertyName(node.property);
  if (propertyName === null || !SANITIZER_RESULT_MEMBERS.has(propertyName)) {
    return false;
  }
  return isSanitizerCall(node.object);
};

export default {
  meta: { name: "no-unsafe-inner-html" },
  rules: {
    "no-unsafe-inner-html": {
      meta: {
        type: "problem",
        messages: {
          unsafeInnerHtml:
            "Raw HTML injected into the DOM must come from a provably " +
            "sanitized/escaped value: a static string, a sanitize*/escape*/" +
            "purify*/dompurify* call (or its .value/.data/.html result). " +
            "Wrap the value in a sanitizer, or add a `// safe-html: <reason " +
            "naming the sanitizer/source>` comment on the line directly above " +
            "if it is escaped at its source.",
        },
      },
      create(context) {
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

        return {
          Program(node) {
            recordEscapeHatches(node);
          },

          // Sink 1: `dangerouslySetInnerHTML={{ __html: <expr> }}`.
          Property(node) {
            if (getPropertyName(node.key) !== "__html") {
              return;
            }
            reportIfUnsafe(node.value);
          },

          // Sink 2: `<el>.innerHTML = <expr>` (non-computed member LHS).
          AssignmentExpression(node) {
            const target = node.left;
            if (
              target.type !== "MemberExpression" ||
              target.computed !== false ||
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
};
