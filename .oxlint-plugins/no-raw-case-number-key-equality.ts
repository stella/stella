// A case-number key is compared only through
// `apps/api/src/lib/case-law/case-number-match-key.ts`.
//
// Keys are stored as their publisher printed them, and one case is printed
// with its year in four digits or in two ("c-679/2018", "c-679/18"). A raw
// comparison of the key columns treats the two as different cases, so a
// citation printed one way never links to the holder stored the other way.
// The owner compares match keys (`caseNumberKeysMatchSql`,
// `caseNumberKeyAmongSql`) or, where a row is compared with its own copy,
// the stored bytes (`sameStoredCaseNumberKeySql`), so every comparison says
// which identity it means.
//
// Syntax only. Reported:
// - string and template text that compares one of the key columns
//   (`citation_key`, `normalized_value`, `normalized_identifier_value`,
//   bare, qualified or quoted) by `=`, `IN (`, `= ANY (` or
//   `IS NOT DISTINCT FROM`, on either side of the operator;
// - a template expression naming a key column property (`citationKey`,
//   `normalizedValue`, `normalizedIdentifierValue`) right beside one of
//   those operators;
// - Drizzle `eq`, `ne`, `inArray` or `notInArray` called on such a property.
// Accepted: an assignment (`SET citation_key = ...`, `, normalized_value = ...`),
// which writes a key rather than comparing one; `IS DISTINCT FROM`, which
// detects a change; and comparisons built any other way. A TypeScript `===` on
// key strings is out of reach; `caseNumberKeysMatch` is its owner.

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isAstNode,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const KEY_COLUMN =
  /^(?:citation_key|normalized_value|normalized_identifier_value)$/iu;
const KEY_PROPERTIES = new Set([
  "citationKey",
  "normalizedIdentifierValue",
  "normalizedValue",
]);
const DRIZZLE_COMPARISONS = new Set(["eq", "inArray", "ne", "notInArray"]);

// `=` that is not part of `<=`, `>=`, `<>`, `!=`, `:=`, `==` or `=>`.
const EQUALITY = String.raw`(?:(?<![<>!:=])=(?![=>])|\bIN\s*\(|\bIS\s+NOT\s+DISTINCT\s+FROM\b)`;
const OPERATOR = new RegExp(EQUALITY, "giu");
const LEADING_EQUALITY = new RegExp(String.raw`^\s*${EQUALITY}`, "iu");
const TRAILING_EQUALITY = new RegExp(
  String.raw`${EQUALITY}\s*(?:ANY\s*\(\s*)?$`,
  "iu",
);
// An operand: a column, bare, qualified or quoted; the group is its name.
const RIGHT_OPERAND =
  /^\s*(?:ANY\s*\(\s*)?(?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?(?<name>[A-Za-z_][\w$]*)/iu;
const SET_KEYWORD = /\bSET\b/giu;
// A word that ends an UPDATE's assignment list or starts an expression, so a
// comma after it separates arguments or select items, not assignments.
const SET_LIST_END =
  /\b(?:WHERE|FROM|RETURNING|SELECT|ON|AND|OR|WHEN|THEN|ELSE|VALUES|USING|JOIN)\b/iu;
// What an interpolated expression reads as when its text is joined.
const EXPRESSION_PLACEHOLDER = " _ ";

/**
 * Whether `lead`, the text before an assignment's target, ends where a target
 * begins: right after `SET`, or after a comma that separates two assignments
 * of the same `SET` list (outside any parentheses, with no clause between).
 */
const isAssignmentLead = (lead: string): boolean => {
  const trimmed = lead.trimEnd();
  const sets = [...trimmed.matchAll(SET_KEYWORD)];
  const last = sets.at(-1);
  if (last === undefined) {
    return false;
  }
  const listStart = last.index + last[0].length;
  if (listStart === trimmed.length) {
    return true;
  }
  if (!trimmed.endsWith(",")) {
    return false;
  }
  let depth = 0;
  let topLevel = "";
  for (const char of trimmed.slice(listStart, -1)) {
    if (char === "(" || char === ")") {
      depth += char === "(" ? 1 : -1;
      if (depth < 0) {
        return false;
      }
      topLevel += " ";
    } else if (depth === 0) {
      topLevel += char;
    }
  }
  return depth === 0 && !SET_LIST_END.test(topLevel);
};

const quasiTexts = (template: AstNode): string[] =>
  Array.isArray(template.quasis)
    ? template.quasis.map((quasi) => {
        const value = isAstNode(quasi) ? quasi.value : null;
        if (typeof value !== "object" || value === null) {
          return "";
        }
        const cooked: unknown = Reflect.get(value, "cooked");
        const raw: unknown = Reflect.get(value, "raw");
        return typeof cooked === "string"
          ? cooked
          : typeof raw === "string"
            ? raw
            : "";
      })
    : [];

type Operand = { index: number; name: string };

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[\w$]/u.test(char);
const isNameStart = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z_]/u.test(char);
const isSpace = (char: string | undefined): boolean =>
  char !== undefined && /\s/u.test(char);

/**
 * The identifier ending at `end`, optionally quoted (`"name"`), and where it
 * starts. Its start is the earliest name start in the run of word characters
 * before `end`.
 */
const identifierEndingAt = (
  text: string,
  end: number,
): { start: number; name: string } | null => {
  let cursor = end;
  if (text[cursor - 1] === '"') {
    cursor -= 1;
  }
  const runEnd = cursor;
  while (isWordChar(text[cursor - 1])) {
    cursor -= 1;
  }
  let nameStart = cursor;
  while (nameStart < runEnd && !isNameStart(text[nameStart])) {
    nameStart += 1;
  }
  if (nameStart === runEnd) {
    return null;
  }
  const start =
    nameStart === cursor && text[nameStart - 1] === '"'
      ? nameStart - 1
      : nameStart;
  return { start, name: text.slice(nameStart, runEnd) };
};

/**
 * The operand a text ends with: a column, bare, qualified (`t.name`) or
 * quoted, before any trailing whitespace. Scanned from the end, so each
 * character is read once whatever the text holds.
 */
const leftOperandOf = (text: string): Operand | null => {
  let end = text.length;
  while (isSpace(text[end - 1])) {
    end -= 1;
  }
  const column = identifierEndingAt(text, end);
  if (column === null) {
    return null;
  }
  let cursor = column.start;
  while (isSpace(text[cursor - 1])) {
    cursor -= 1;
  }
  if (text[cursor - 1] !== ".") {
    return { index: column.start, name: column.name };
  }
  cursor -= 1;
  while (isSpace(text[cursor - 1])) {
    cursor -= 1;
  }
  const qualifier = identifierEndingAt(text, cursor);
  return {
    index: qualifier?.start ?? column.start,
    name: column.name,
  };
};

/**
 * The template's text before quasi `count`, each interpolated expression read
 * as a placeholder operand, ending where quasi `count` begins.
 */
const textsBefore = (texts: readonly string[], count: number): string =>
  count <= 0
    ? ""
    : `${texts.slice(0, count).join(EXPRESSION_PLACEHOLDER)}${EXPRESSION_PLACEHOLDER}`;

const isKeyColumn = (name: string | undefined): boolean =>
  KEY_COLUMN.test(name ?? "");

/**
 * Whether `text` compares a key column, an assignment aside. `context` is the
 * statement text before it, which says whether a comma leads an assignment.
 */
const textComparesKey = (text: string, context = ""): boolean => {
  for (const operator of text.matchAll(OPERATOR)) {
    const before = text.slice(0, operator.index);
    const after = text.slice(operator.index + operator[0].length);
    const left = leftOperandOf(before);
    if (
      !isKeyColumn(left?.name) &&
      !isKeyColumn(RIGHT_OPERAND.exec(after)?.groups?.name)
    ) {
      continue;
    }
    const isAssignment =
      operator[0] === "=" &&
      left !== null &&
      isAssignmentLead(context + before.slice(0, left.index));
    if (!isAssignment) {
      return true;
    }
  }
  return false;
};

const namesKeyProperty = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "MemberExpression" &&
    KEY_PROPERTIES.has(memberPropertyName(expression) ?? "")
  );
};

/**
 * A template expression naming a key column beside an equality operator,
 * unless it is the target or the value of an assignment.
 */
const templateComparesKeyProperty = (template: AstNode): boolean => {
  const texts = quasiTexts(template);
  // The text before expression `index`: every quasi up to its own.
  const contextOf = (index: number): string =>
    index < 0 ? "" : texts.slice(0, index + 1).join(EXPRESSION_PLACEHOLDER);
  const expressions = Array.isArray(template.expressions)
    ? template.expressions
    : [];
  return expressions.some((expression, index) => {
    if (!namesKeyProperty(expression)) {
      return false;
    }
    const before = texts[index] ?? "";
    const after = texts[index + 1] ?? "";
    const trailing = TRAILING_EQUALITY.exec(before);
    if (trailing !== null) {
      if (trailing[0].trim() !== "=") {
        return true;
      }
      // The value of `=`: an assignment when its target follows `SET` or a
      // comma, in this text or, for an interpolated target, the text before.
      const target = before.slice(0, trailing.index);
      const lead =
        target.trim().length === 0
          ? contextOf(index - 1)
          : textsBefore(texts, index) +
            target.slice(0, leftOperandOf(target)?.index ?? 0);
      return !isAssignmentLead(lead);
    }
    const leading = LEADING_EQUALITY.exec(after);
    return (
      leading !== null &&
      (leading[0].trim() !== "=" || !isAssignmentLead(contextOf(index)))
    );
  });
};

const MESSAGE =
  "Compare case-number keys through apps/api/src/lib/case-law/case-number-match-key.ts: caseNumberKeysMatchSql or caseNumberKeyAmongSql for two printings of a case (a year in four digits or two), sameStoredCaseNumberKeySql for a row against its own copy. A raw comparison misses 'c-679/18' for 'c-679/2018'.";

export default eslintCompatPlugin({
  meta: { name: "no-raw-case-number-key-equality" },
  rules: {
    "no-raw-case-number-key-equality": {
      meta: {
        type: "problem",
        messages: { raw: MESSAGE },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (typeof node.value === "string" && textComparesKey(node.value)) {
              context.report({ node, messageId: "raw" });
            }
          },
          TemplateLiteral(node: ESTree.TemplateLiteral) {
            const template = unwrapExpression(node);
            if (template === null) {
              return;
            }
            if (
              quasiTexts(template).some((text, index, texts) =>
                textComparesKey(text, textsBefore(texts, index)),
              ) ||
              templateComparesKeyProperty(template)
            ) {
              context.report({ node, messageId: "raw" });
            }
          },
          CallExpression(node: ESTree.CallExpression) {
            const call = unwrapExpression(node);
            const callee = unwrapExpression(call?.callee);
            if (
              call === null ||
              callee?.type !== "Identifier" ||
              !DRIZZLE_COMPARISONS.has(getPropertyName(callee) ?? "")
            ) {
              return;
            }
            const args = Array.isArray(call.arguments) ? call.arguments : [];
            if (args.slice(0, 2).some(namesKeyProperty)) {
              context.report({ node, messageId: "raw" });
            }
          },
        };
      },
    },
  },
});
