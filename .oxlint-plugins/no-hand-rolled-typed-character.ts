import { eslintCompatPlugin } from "@oxlint/plugins";
// Whether a keystroke typed a character is decided by `typedCharacter` in
// `@stll/ui/typed-character`. Code that reasons about Alt/AltGraph itself
// keeps getting the layouts wrong: macOS layouts type "@", "{" and "|" with
// Option (Chrome never reports AltGraph there) and Windows AltGr arrives as
// Ctrl+Alt, so a handler that treats any Alt as a shortcut drops real text.
//
// Heuristic, per function (nested functions are judged on their own): it
// reads `.altKey` or calls `getModifierState("AltGraph")`, and it compares a
// `.key` read with a one-character, non-whitespace string literal (`===`,
// `!==`, a switch case) or tests `.key.length === 1`. A function that requires the Mod chord,
// `metaKey || ctrlKey` negated (`if (!(e.metaKey || e.ctrlKey)) return`) or as
// an `&&` operand, is a command shortcut and stays exempt.

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const HELPER_FILE = "packages/ui/src/lib/typed-character.ts";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

const COMMAND_MODIFIERS = ["ctrlKey", "metaKey"] as const;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Space is excluded: it doubles as the activation key of buttons and cards.
const isSingleCharacterLiteral = (node: unknown): boolean => {
  if (!isStringLiteral(node) || node.value.trim() === "") {
    return false;
  }
  const first = graphemes.segment(node.value)[Symbol.iterator]().next();
  return !first.done && first.value.segment === node.value;
};

const memberName = (node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "MemberExpression" || expression.computed) {
    return null;
  }
  return getPropertyName(expression.property);
};

/** `x.metaKey`, or a destructured `metaKey` binding. */
const modifierName = (node: unknown): string | null => {
  const expression = unwrapExpression(node);
  return isIdentifier(expression) ? expression.name : memberName(expression);
};

const isKeyRead = (node: unknown): boolean => memberName(node) === "key";

const isAltGraphQuery = (node: AstNode): boolean => {
  if (node.type !== "CallExpression" || !Array.isArray(node.arguments)) {
    return false;
  }
  const [modifier] = node.arguments;
  return (
    memberName(node.callee) === "getModifierState" &&
    isStringLiteral(modifier) &&
    modifier.value === "AltGraph"
  );
};

const isKeyLengthOne = (left: unknown, right: unknown): boolean => {
  const expression = unwrapExpression(left);
  return (
    expression?.type === "MemberExpression" &&
    memberName(expression) === "length" &&
    isKeyRead(expression.object) &&
    isAstNode(right) &&
    right.type === "Literal" &&
    right.value === 1
  );
};

const comparesTypedCharacter = (node: AstNode): boolean => {
  if (node.type === "SwitchStatement") {
    return (
      isKeyRead(node.discriminant) &&
      Array.isArray(node.cases) &&
      node.cases.some(
        (switchCase) =>
          isAstNode(switchCase) && isSingleCharacterLiteral(switchCase.test),
      )
    );
  }
  if (
    node.type !== "BinaryExpression" ||
    typeof node.operator !== "string" ||
    !EQUALITY_OPERATORS.has(node.operator)
  ) {
    return false;
  }
  const { left, right } = node;
  return (
    (isKeyRead(left) && isSingleCharacterLiteral(right)) ||
    (isKeyRead(right) && isSingleCharacterLiteral(left)) ||
    isKeyLengthOne(left, right) ||
    isKeyLengthOne(right, left)
  );
};

const isOrChain = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "LogicalExpression" &&
  node.operator === "||";

const orOperands = (node: unknown): unknown[] => {
  const expression = unwrapExpression(node);
  if (expression === null || !isOrChain(expression)) {
    return [expression];
  }
  return [...orOperands(expression.left), ...orOperands(expression.right)];
};

type Parents = Map<AstNode, AstNode | null>;

const outerParent = (node: AstNode, parents: Parents): AstNode | null => {
  let parent = parents.get(node);
  while (parent?.type === "ParenthesizedExpression") {
    parent = parents.get(parent);
  }
  return parent ?? null;
};

/** A whole `metaKey || ctrlKey` chain, negated or required by `&&`. */
const requiresModChord = (node: AstNode, parents: Parents): boolean => {
  if (!isOrChain(node)) {
    return false;
  }
  const parent = outerParent(node, parents);
  if (isOrChain(parent)) {
    return false;
  }
  const names = orOperands(node).map(modifierName);
  if (
    names.length !== COMMAND_MODIFIERS.length ||
    !COMMAND_MODIFIERS.every((modifier) => names.includes(modifier))
  ) {
    return false;
  }
  return (
    (parent?.type === "UnaryExpression" && parent.operator === "!") ||
    (parent?.type === "LogicalExpression" && parent.operator === "&&")
  );
};

/** The function's own nodes with their parents, nested functions excluded. */
const ownNodes = (root: AstNode): Parents => {
  const parents: Parents = new Map();
  const pending: { node: unknown; parent: AstNode | null }[] = [
    { node: root, parent: null },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) {
      break;
    }
    const { node, parent } = entry;
    if (Array.isArray(node)) {
      for (const child of node) {
        pending.push({ node: child, parent });
      }
      continue;
    }
    if (!isAstNode(node) || parents.has(node)) {
      continue;
    }
    if (parent !== null && FUNCTION_TYPES.has(node.type)) {
      continue;
    }
    parents.set(node, parent);
    for (const [key, value] of Object.entries(node)) {
      if (key !== "parent" && typeof value === "object") {
        pending.push({ node: value, parent: node });
      }
    }
  }
  return parents;
};

const handRollsTypedCharacter = (fn: AstNode): boolean => {
  const parents = ownNodes(fn);
  const nodes = [...parents.keys()];
  const readsAlt = nodes.some(
    (node) => memberName(node) === "altKey" || isAltGraphQuery(node),
  );
  return (
    readsAlt &&
    nodes.some(comparesTypedCharacter) &&
    !nodes.some((node) => requiresModChord(node, parents))
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-hand-rolled-typed-character" },
  rules: {
    "no-hand-rolled-typed-character": {
      meta: {
        type: "problem",
        messages: {
          handRolledTypedCharacter:
            "Decide which character a keystroke typed with typedCharacter from @stll/ui/typed-character. Hand-rolled Alt/AltGraph checks drop Option-typed characters on macOS layouts and AltGr characters on Windows.",
        },
      },
      createOnce(context) {
        const check = (node: unknown) => {
          if (isAstNode(node) && handRollsTypedCharacter(node)) {
            context.report({ node, messageId: "handRolledTypedCharacter" });
          }
        };
        return {
          before() {
            return !filenameForContext(context).endsWith(HELPER_FILE);
          },
          ArrowFunctionExpression: check,
          FunctionDeclaration: check,
          FunctionExpression: check,
        };
      },
    },
  },
});
