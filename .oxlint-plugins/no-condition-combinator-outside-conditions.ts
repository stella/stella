// Condition-tree nodes (`combinator`, `negated`) are an implementation
// detail of `@stll/conditions`. Reading those fields directly, anywhere but
// the condition builder itself, re-implements tree semantics (AND/OR
// grouping, negation) at the call site instead of going through the
// package's fold/walk/evaluate helpers — the same drift risk as reading a
// Drizzle table's derived columns by hand instead of through its owner.
//
// The sanctioned way to give a group meaning is the package's own fold:
// `foldCondition`/`foldConditions` own which nodes survive, and hand the
// surviving children to a `group` callback that may read `combinator` and
// `negated` to combine them. A module that imports the fold from
// `@stll/conditions` is therefore exempt: it is consuming the tree through
// its owner, not walking it by hand.
//
// The ban is a plain, non-computed property-access check on `.combinator`
// and `.negated`: an object-literal key (`{ combinator: "and" }`, building a
// new node) is a `Property`, not a `MemberExpression`, so it is unaffected —
// only *reading* an existing node's combinator/negated is in scope.
//
// Exempt (the condition builder legitimately reads and writes these
// fields):
//   - packages/conditions/src/** (the tree's own fold/walk/evaluate)
//   - packages/workspace-ui/src/** (the interactive condition builder)
//   - any module importing `foldCondition` or `foldConditions` from
//     `@stll/conditions`
//
// Enabled only for apps/web/src/** and apps/api/src/**; the exemption paths
// are checked here too so the rule stays correct on its own even if a future
// config change broadens the enabling scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getPropertyName,
  isStringLiteral,
} from "./utils.ts";

const TARGET_PROPERTY_NAMES = new Set(["combinator", "negated"]);

const CONDITIONS_PACKAGE = "@stll/conditions";
const FOLD_EXPORT_NAMES = new Set(["foldCondition", "foldConditions"]);

const SCOPE_PREFIXES = ["apps/web/src/", "apps/api/src/"];

const EXEMPT_PREFIXES = [
  "packages/conditions/src/",
  "packages/workspace-ui/src/",
];

const FIXTURE_FILE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-condition-combinator-outside-conditions.fixture.ts";

export default eslintCompatPlugin({
  meta: { name: "no-condition-combinator-outside-conditions" },
  rules: {
    "no-condition-combinator-outside-conditions": {
      meta: {
        type: "problem",
        messages: {
          combinatorRead:
            "Condition-tree semantics live in @stll/conditions: combine " +
            "nodes inside a foldCondition/foldConditions group callback " +
            "instead of reading combinator or negated here.",
        },
      },
      createOnce(context) {
        // Imports precede every member read in source order, so the flag is
        // settled before the first `MemberExpression` of the file is visited.
        let consumesFold = false;
        return {
          before() {
            consumesFold = false;
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE_FILE_SUFFIX)) {
              return true;
            }
            return (
              SCOPE_PREFIXES.some((prefix) => filename.includes(prefix)) &&
              !EXEMPT_PREFIXES.some((prefix) => filename.includes(prefix))
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              node.source.value !== CONDITIONS_PACKAGE
            ) {
              return;
            }
            if (
              node.specifiers.some((specifier) => {
                const imported = getImportedName(specifier);
                return imported !== null && FOLD_EXPORT_NAMES.has(imported);
              })
            ) {
              consumesFold = true;
            }
          },
          MemberExpression(node) {
            if (consumesFold || node.computed) {
              return;
            }
            const propertyName = getPropertyName(node.property);
            if (
              propertyName === null ||
              !TARGET_PROPERTY_NAMES.has(propertyName)
            ) {
              return;
            }
            context.report({ node, messageId: "combinatorRead" });
          },
        };
      },
    },
  },
});
