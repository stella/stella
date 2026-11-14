// Read in-app navigation history through the router, not the browser.
//
// TanStack Router owns `window.history.state`: it keeps its own keys there
// (`__TSR_index`, `__TSR_key`), so a consumer that reads a guessed key (`idx`)
// sees nothing and silently takes its fallback, and `history.length` counts
// entries from before the app loaded and other origins. Whether there is an
// in-app entry to go back to is `router.history.canGoBack()`; going there is
// `router.history.back()`. The router setup in apps/web/src/router.tsx is the
// one module that passes the browser state through untouched.
//
// The rule proves one local property: `state` or `length` is not read off the
// global `history`, `window.history`, `globalThis.history` or `self.history`,
// by member access or destructuring. A shadowed `history` or `window` (a
// local list, a test window) is someone else's object and is allowed.
//
// Flags:
//   const state: unknown = window.history.state;
//   if (history.length > 1) history.back();
//   const { state } = globalThis.history;
//
// Allows:
//   if (router.history.canGoBack()) router.history.back();
//   const history = useUndoStack(); history.length;

import type { Context } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isFileIn,
  isUnshadowedGlobalIdentifier,
  memberPropertyName,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const HISTORY_NAME = "history";
const GLOBAL_OBJECT_NAMES = new Set(["window", "globalThis", "self"]);
const RESTRICTED_PROPERTIES = new Set(["state", "length"]);

// Shrink-only: the router setup preserves the router's state across a
// replaceState before a reload.
export const HISTORY_STATE_OWNERS = ["apps/web/src/router.tsx"];

/** Whether `value` is the browser's own history object. */
const isBrowserHistory = (context: Context, value: unknown): boolean => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  if (node.type === "Identifier") {
    return (
      getPropertyName(node) === HISTORY_NAME &&
      isUnshadowedGlobalIdentifier(context, node)
    );
  }
  if (node.type !== "MemberExpression" || !isAstNode(node.object)) {
    return false;
  }
  const base = unwrapExpression(node.object);
  return (
    memberPropertyName(node) === HISTORY_NAME &&
    base !== null &&
    GLOBAL_OBJECT_NAMES.has(getPropertyName(base) ?? "") &&
    isUnshadowedGlobalIdentifier(context, base)
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-history-state" },
  rules: {
    "no-raw-history-state": {
      meta: {
        type: "problem",
        messages: {
          rawHistoryState:
            "Do not read browser history state or length: TanStack Router owns them. Use router.history.canGoBack() and router.history.back() from useRouter().",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          MemberExpression(node) {
            if (
              isFileIn(context, HISTORY_STATE_OWNERS) ||
              !isAstNode(node) ||
              !RESTRICTED_PROPERTIES.has(memberPropertyName(node) ?? "") ||
              !isBrowserHistory(context, node.object)
            ) {
              return;
            }
            context.report({ node, messageId: "rawHistoryState" });
          },
          VariableDeclarator(node) {
            if (
              isFileIn(context, HISTORY_STATE_OWNERS) ||
              node.id.type !== "ObjectPattern" ||
              !isBrowserHistory(context, node.init)
            ) {
              return;
            }
            for (const property of node.id.properties) {
              if (!isAstNode(property) || property.type !== "Property") {
                continue;
              }
              const name = property.computed
                ? staticStringValue(property.key)
                : getPropertyName(property.key);
              if (name !== null && RESTRICTED_PROPERTIES.has(name)) {
                context.report({
                  node: property,
                  messageId: "rawHistoryState",
                });
              }
            }
          },
        };
      },
    },
  },
});
