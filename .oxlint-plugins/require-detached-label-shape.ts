// Require the `detached(promise, context)` label to be a dotted
// `feature.action` string literal.
//
// `no-detached-void` routes every fire-and-forget promise through
// `detached(promise, context)`, and the label is the only thing that
// identifies the call site once a rejection reaches the error-capture
// channel. Both helpers (`@/lib/detached` on the web, `@/api/lib/detached`
// on the API) document a short, stable dotted tag ("chat-thread.prefetch"),
// but nothing enforced it, so most call sites drifted to the enclosing
// component or handler name ("RouteComponent", "onSuccess", "FileTabPanel").
// Those names are neither stable (a rename silently re-tags the telemetry)
// nor distinguishing: 52 unrelated call sites shared the label "onSuccess",
// which makes the tag useless for correlating a spike to a code path.
//
// The required shape is exactly two lowercase kebab segments:
//
//   feature.action     e.g. "template-list.invalidate-templates"
//
// `feature` names the module or route slice the call lives in, `action`
// names the work being detached. Two segments keep the tag groupable in
// telemetry; a third segment reintroduces per-call-site nesting nobody
// queries by.
//
// Flags:
//   detached(save(), "RouteComponent")     // enclosing name, not an action
//   detached(save(), "chat.save.retry")    // three segments
//   detached(save(), "chatThread.save")    // camelCase segment
//   detached(save(), label)                // non-literal
//   detached(save(), `${feature}.save`)    // non-literal
//   detached(save())                       // no label at all
//
// The label must be a plain string literal. No call site in the repo builds
// one dynamically, and an interpolated identifier would put a user or record
// id into a correlation tag, which is exactly what both helper doc comments
// forbid. A helper that needs to detach on behalf of several call sites
// should take the promise and let each site pass its own literal, rather
// than forwarding a label parameter.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isStringLiteral } from "./utils.ts";

// `feature.action`, each side kebab-case: alphanumeric words joined by single
// hyphens. Spelling the word structure out rather than accepting `[a-z0-9-]+`
// keeps degenerate labels (`-.--`, `chat-.save-`) from satisfying a shape
// whose whole purpose is to make a captured rejection attributable.
const KEBAB_WORD = String.raw`[a-z0-9]+(?:-[a-z0-9]+)*`;
const LABEL_SHAPE = new RegExp(`^${KEBAB_WORD}\\.${KEBAB_WORD}$`, "u");

export default eslintCompatPlugin({
  meta: { name: "require-detached-label-shape" },
  rules: {
    "require-detached-label-shape": {
      meta: {
        type: "problem",
        messages: {
          missingLabel:
            '`detached(promise, context)` needs a context label. Pass a `"feature.action"` string literal naming the module and the work being detached.',
          nonLiteralLabel:
            'The `detached` context label must be a plain `"feature.action"` string literal, so the telemetry tag stays stable and cannot carry an interpolated identifier. If a helper detaches for several call sites, return the promise and let each site pass its own literal.',
          badLabelShape:
            'The `detached` context label must be two lowercase kebab-case segments, `"feature.action"` (for example `"template-list.invalidate-templates"`). Name the module or route slice, then the work being detached; an enclosing component or handler name is neither stable nor distinguishing.',
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (node.callee.type !== "Identifier") {
              return;
            }
            if (node.callee.name !== "detached") {
              return;
            }

            const label = node.arguments.at(1);
            if (label === undefined) {
              context.report({ node, messageId: "missingLabel" });
              return;
            }
            if (!isStringLiteral(label)) {
              context.report({ node: label, messageId: "nonLiteralLabel" });
              return;
            }
            if (LABEL_SHAPE.test(label.value)) {
              return;
            }
            context.report({ node: label, messageId: "badLabelShape" });
          },
        };
      },
    },
  },
});
