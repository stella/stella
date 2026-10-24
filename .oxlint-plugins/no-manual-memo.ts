// Manual memoization in files the React Compiler compiles.
//
// The compiler caches values and callbacks itself, so `useMemo` and
// `useCallback` in a compiled function are dead weight, and a memo directive
// either forces a cache scope the compiler withheld or skips the function.
// The rule is enabled only for files with no compiler bailout: a function the
// compiler skips keeps its manual memoization, and `scripts/rc-bailouts.ts`
// guards those (its baseline lists them and the config exempts their files).
//
// Flagged:
//   useMemo(() => rows.filter(isOpen), [rows])        named import from react
//   memoize(() => build(), [])                        aliased import
//   React.useCallback(() => save(id), [id])           namespace or default import
//   "use memo";  "use no memo";  "use no forget";     function or module directive
//
// Accepted:
//   const open = rows.filter(isOpen);                 the compiler caches it
//   const save = useLatestCallback(() => persist());  one identity across renders
//   useMemo(...) where `useMemo` is a local function, not React's
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isImportedFrom,
  memberPropertyName,
  NAMESPACE_IMPORT,
  resolveImport,
  unwrapExpression,
} from "./utils.ts";

const MEMO_HOOKS: ReadonlySet<string> = new Set(["useCallback", "useMemo"]);
// "use no memo" and "use no forget" skip a function the compiler would bail
// on, which hides the bailout from the coverage guard as much as "use memo".
const MEMO_DIRECTIVES: ReadonlySet<string> = new Set([
  "use memo",
  "use no memo",
  "use no forget",
]);
const REACT_MODULES = ["react"];

export default eslintCompatPlugin({
  meta: { name: "no-manual-memo" },
  rules: {
    "no-manual-memo": {
      meta: {
        type: "suggestion",
        messages: {
          memoHook:
            "Drop {{name}}: the React Compiler memoizes this file. Write the plain value or function; use useLatestCallback only where a handler must keep one identity across renders.",
          memoDirective:
            'Drop "use memo": restructure so the compiler caches this on its own, for example move plain uses of a value before the hook call that splits its scope, or inline the helper.',
          optOutDirective:
            'Drop "{{directive}}": fix the code the compiler cannot prove safe instead of skipping it.',
        },
      },
      createOnce(context) {
        const memoHookName = (callee: unknown): string | null => {
          const expression = unwrapExpression(callee);
          if (expression?.type === "MemberExpression") {
            const name = memberPropertyName(expression);
            const base = resolveImport(context, expression.object);
            return name !== null &&
              MEMO_HOOKS.has(name) &&
              base?.moduleId === "react" &&
              (base.imported === NAMESPACE_IMPORT ||
                base.imported === "default")
              ? name
              : null;
          }
          const resolved = resolveImport(context, expression);
          return resolved !== null &&
            isImportedFrom({
              context,
              node: expression,
              modules: REACT_MODULES,
              names: MEMO_HOOKS,
            })
            ? resolved.imported
            : null;
        };
        return {
          ExpressionStatement(node) {
            const { directive } = node;
            if (
              typeof directive !== "string" ||
              !MEMO_DIRECTIVES.has(directive)
            ) {
              return;
            }
            if (directive === "use memo") {
              context.report({ node, messageId: "memoDirective" });
              return;
            }
            context.report({
              node,
              messageId: "optOutDirective",
              data: { directive },
            });
          },
          CallExpression(node) {
            const name = memoHookName(node.callee);
            if (name !== null) {
              context.report({
                node: node.callee,
                messageId: "memoHook",
                data: { name },
              });
            }
          },
        };
      },
    },
  },
});
