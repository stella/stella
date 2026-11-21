// A function named like a hook must call a hook.
//
// The React Compiler compiles components and hooks, and it recognises a hook
// by its `use` prefix only when the function calls a hook itself. A `use*`
// function that calls none is left as a plain function: whatever it builds is
// rebuilt on every render, and callers treat it as a hook (rules-of-hooks
// ordering, no conditional calls) for no reason. Mirrors eslint-react's
// `no-unnecessary-use-prefix`, which oxlint does not ship.
//
// Flagged:
//   function useLabel(count: number) { return `${count} items`; }
//   const useOptions = () => ({ retry: false });
//   const useHandler = () => () => useStore.getState();
//     (the hook call runs when the returned callback runs, not during render)
//
// Accepted:
//   function useLabel() { const t = useTranslations(); return t("label"); }
//   const useTheme = () => use(ThemeContext);
//   const useCount = () => React.useState(0);
//   function formatLabel(count: number) { return `${count} items`; }
//   const useStore = create(() => ({}));   (not a function literal)
import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import { isAstNode, memberPropertyName, unwrapExpression } from "./utils.ts";

const HOOK_NAME = /^use[A-Z]/u;
// Bare `use` is React 19's `use(promise | context)`, which is a hook call too.
const HOOK_CALLEE = /^use(?:[A-Z]|$)/u;

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const isHookCallee = (node: unknown): boolean => {
  const callee = unwrapExpression(node);
  if (callee?.type === "Identifier") {
    return typeof callee.name === "string" && HOOK_CALLEE.test(callee.name);
  }
  if (callee?.type === "MemberExpression") {
    return HOOK_CALLEE.test(memberPropertyName(callee) ?? "");
  }
  return false;
};

// A hook call inside a nested callback runs when the callback runs, not
// during render, so it does not make the outer function a hook.
const callsHook = (node: unknown): boolean => {
  if (Array.isArray(node)) {
    return node.some(callsHook);
  }
  if (!isAstNode(node) || FUNCTION_TYPES.has(node.type)) {
    return false;
  }
  if (node.type === "CallExpression" && isHookCallee(node.callee)) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "parent" && callsHook(value)) {
      return true;
    }
  }
  return false;
};

type HookCheckOptions = {
  name: string;
  body: unknown;
  node: ESTree.BindingIdentifier;
};

export default eslintCompatPlugin({
  meta: { name: "no-hookless-use-function" },
  rules: {
    "no-hookless-use-function": {
      meta: {
        type: "problem",
        messages: {
          hookless:
            '"{{name}}" is named like a hook but calls no hook, so the React Compiler skips it and its result is rebuilt on every render. Rename it without the `use` prefix, or call the hook it depends on inside it.',
        },
      },
      createOnce(context) {
        const check = ({ name, body, node }: HookCheckOptions) => {
          if (!HOOK_NAME.test(name) || !body || callsHook(body)) {
            return;
          }
          context.report({ node, messageId: "hookless", data: { name } });
        };
        return {
          FunctionDeclaration(node) {
            if (node.id) {
              check({ name: node.id.name, body: node.body, node: node.id });
            }
          },
          VariableDeclarator(node) {
            const init = unwrapExpression(node.init);
            if (
              node.id.type !== "Identifier" ||
              (init?.type !== "ArrowFunctionExpression" &&
                init?.type !== "FunctionExpression")
            ) {
              return;
            }
            check({ name: node.id.name, body: init.body, node: node.id });
          },
        };
      },
    },
  },
});
