import { eslintCompatPlugin } from "@oxlint/plugins";
// The find shortcut has exactly one listener in apps/web: the registry in
// `@/lib/find-owner` resolves the owning surface and calls it back. Two panes
// once matched Cmd/Ctrl+F themselves, drifted apart from the remappable
// binding, and let Folio's unscoped document listener open a second find bar
// over the one that won. A surface takes part by registering, never by
// recognising the press, so this rule bans both ways of recognising it: the
// registry's shortcut id or constant, and a hand-rolled comparison of a
// keyboard event's `key` against "f".

import {
  filenameForContext,
  getCalleeName,
  getPropertyName,
  isIdentifier,
  isMemberAccess,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const ALLOWED_FILES = [
  "apps/web/src/lib/find-owner.ts",
  "apps/web/src/lib/hotkeys.ts",
];

const FIND_KEY_LITERALS = new Set(["f", "F"]);

const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

const CASE_FOLDING_METHODS = new Set(["toLowerCase", "toUpperCase"]);

const isAllowedFile = (context) => {
  const filename = filenameForContext(context);
  return ALLOWED_FILES.some((allowedFile) => filename.endsWith(allowedFile));
};

/** `event.key`, or a case-folded read of it (`event.key.toLowerCase()`). */
const isKeyRead = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (expression.type === "MemberExpression" && expression.computed === false) {
    return isIdentifier(expression.property, "key");
  }
  if (expression.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(expression.callee);
  if (callee?.type !== "MemberExpression" || callee.computed !== false) {
    return false;
  }
  const method = getPropertyName(callee.property);
  return (
    method !== null &&
    CASE_FOLDING_METHODS.has(method) &&
    isKeyRead(callee.object)
  );
};

const isFindKeyComparison = (left: unknown, right: unknown): boolean =>
  isStringLiteral(right) &&
  FIND_KEY_LITERALS.has(right.value) &&
  isKeyRead(left);

export default eslintCompatPlugin({
  meta: { name: "no-ad-hoc-find-shortcut" },
  rules: {
    "no-ad-hoc-find-shortcut": {
      meta: {
        type: "problem",
        messages: {
          adHocFindShortcut:
            "The find shortcut is dispatched by the registry in @/lib/find-owner. Register the surface with useFindSurface({ onFind }) instead of matching the press yourself.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return !isAllowedFile(context);
          },
          CallExpression(node) {
            if (getCalleeName(node.callee) !== "useEffectiveHotkey") {
              return;
            }
            const [id] = node.arguments;
            if (isStringLiteral(id) && id.value === "find") {
              context.report({ node, messageId: "adHocFindShortcut" });
            }
          },
          MemberExpression(node) {
            if (isMemberAccess(node, "HOTKEYS", "FIND")) {
              context.report({ node, messageId: "adHocFindShortcut" });
            }
          },
          BinaryExpression(node) {
            if (!EQUALITY_OPERATORS.has(node.operator)) {
              return;
            }
            if (
              isFindKeyComparison(node.left, node.right) ||
              isFindKeyComparison(node.right, node.left)
            ) {
              context.report({ node, messageId: "adHocFindShortcut" });
            }
          },
        };
      },
    },
  },
});
