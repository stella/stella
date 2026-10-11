import ts from "typescript";

type Token = { depth: number } & (
  | { kind: "interpolation"; text: "?"; expression: ts.Expression }
  | { kind: "word" | "open" | "close" | "symbol"; text: string }
);

const CLAUSE_END = new Set([
  "EXCEPT",
  "FETCH",
  "FOR",
  "GROUP",
  "HAVING",
  "INTERSECT",
  "LIMIT",
  "OFFSET",
  "ORDER",
  "RETURNING",
  "UNION",
  "WINDOW",
]);
const JOIN_END = new Set([
  ...CLAUSE_END,
  "CROSS",
  "FULL",
  "INNER",
  "JOIN",
  "LEFT",
  "RIGHT",
  "WHERE",
]);

type QuotedCharacterOptions = { char: string; next: string; quote: string };
const quotedCharacter = ({ char, next, quote }: QuotedCharacterOptions) => {
  if (char === "\\") {
    return { advance: 2, closed: false, unsupported: true };
  }
  if (char === quote && next === quote) {
    return { advance: 2, closed: false, unsupported: false };
  }
  return { advance: 1, closed: char === quote, unsupported: false };
};

const caseDepthBefore = (tokens: readonly Token[], depth: number): number => {
  let count = 0;
  for (const token of tokens) {
    if (token.depth !== depth || token.kind !== "word") {
      continue;
    }
    if (token.text === "CASE") {
      count += 1;
    }
    if (token.text === "END") {
      count = Math.max(0, count - 1);
    }
  }
  return count;
};

const tokenize = (template: ts.TemplateLiteral): Token[] => {
  const tokens: Token[] = [];
  let depth = 0;
  let blockDepth = 0;
  let unsupported = false;
  let mode: "sql" | "single" | "double" | "line-comment" | "block-comment" =
    "sql";
  const scan = (text: string): void => {
    for (let i = 0; i < text.length;) {
      const char = text.charAt(i);
      const next = text.charAt(i + 1);
      if (mode === "line-comment") {
        if (char === "\n") {
          mode = "sql";
        }
        i += 1;
        continue;
      }
      if (mode === "block-comment") {
        if (char === "/" && next === "*") {
          blockDepth += 1;
          i += 2;
        } else if (char === "*" && next === "/") {
          blockDepth -= 1;
          if (blockDepth === 0) {
            mode = "sql";
          }
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (mode === "single" || mode === "double") {
        const step = quotedCharacter({
          char,
          next,
          quote: mode === "single" ? "'" : '"',
        });
        unsupported ||= step.unsupported;
        if (step.closed) {
          mode = "sql";
        }
        i += step.advance;
        continue;
      }
      if (char === "-" && next === "-") {
        mode = "line-comment";
        i += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = "block-comment";
        blockDepth = 1;
        i += 2;
        continue;
      }
      if (char === "$" && /^\$(?:[A-Za-z_][\w]*)?\$/u.test(text.slice(i))) {
        unsupported = true;
      }
      if (char === "'") {
        mode = "single";
        i += 1;
        continue;
      }
      if (char === '"') {
        mode = "double";
        i += 1;
        continue;
      }
      if (/\s/u.test(char)) {
        i += 1;
        continue;
      }
      const word = /^[A-Za-z_][\w$]*/u.exec(text.slice(i))?.[0];
      if (word !== undefined) {
        tokens.push({ kind: "word", text: word.toUpperCase(), depth });
        i += word.length;
        continue;
      }
      if (char === "(") {
        tokens.push({ kind: "open", text: char, depth });
        depth += 1;
      } else if (char === ")") {
        depth = Math.max(0, depth - 1);
        tokens.push({ kind: "close", text: char, depth });
      } else {
        tokens.push({ kind: "symbol", text: char, depth });
      }
      i += 1;
    }
  };

  scan(ts.isTemplateExpression(template) ? template.head.text : template.text);
  const spans = ts.isTemplateExpression(template) ? template.templateSpans : [];
  for (const span of spans) {
    if (mode === "sql") {
      tokens.push({
        kind: "interpolation",
        text: "?",
        depth,
        expression: span.expression,
      });
    }
    scan(span.literal.text);
  }
  return unsupported || mode !== "sql" || depth !== 0 ? [] : tokens;
};

export const hasPreservingSqlJoin = (template: ts.TemplateLiteral): boolean => {
  const tokens = tokenize(template);
  return tokens.some((token, index) => {
    if (
      token.kind !== "word" ||
      (token.text !== "RIGHT" && token.text !== "FULL")
    ) {
      return false;
    }
    const next = tokens[index + 1];
    const join = next?.text === "OUTER" ? tokens[index + 2] : next;
    return join?.kind === "word" && join.text === "JOIN";
  });
};

const isClauseEnd = (token: Token | undefined, kind: "WHERE" | "ON") =>
  (token?.kind === "symbol" && token.text === ";") ||
  (token?.kind === "word" &&
    (kind === "ON" ? JOIN_END : CLAUSE_END).has(token.text));

const introducedDecisionAlias = (
  tokens: readonly Token[],
  clauseStart: number,
): string | undefined => {
  const depth = tokens[clauseStart]?.depth;
  const preceding = tokens.slice(0, clauseStart);
  const joinIndex = preceding.findLastIndex(
    (token) =>
      token.depth === depth && token.kind === "word" && token.text === "JOIN",
  );
  const relation = tokens[joinIndex + 1];
  if (
    joinIndex === -1 ||
    relation?.kind !== "word" ||
    relation.text !== "CASE_LAW_DECISIONS"
  ) {
    return undefined;
  }
  const afterRelation = tokens[joinIndex + 2];
  const alias =
    afterRelation?.text === "AS" ? tokens[joinIndex + 3] : afterRelation;
  if (alias?.kind !== "word") {
    return undefined;
  }
  return alias.text === "ON" ? "case_law_decisions" : alias.text.toLowerCase();
};

export type PositiveSqlConjunct = {
  expression: ts.Expression;
  targetAlias: string | undefined;
};

/** ON operands belong only to the relation introduced by their own JOIN. */
export const positiveSqlConjunctInterpolations = (
  template: ts.TemplateExpression,
): PositiveSqlConjunct[] => {
  const tokens = tokenize(template);
  const accepted: PositiveSqlConjunct[] = [];
  for (let clauseStart = 0; clauseStart < tokens.length; clauseStart += 1) {
    const start = tokens[clauseStart];
    if (
      start?.kind !== "word" ||
      (start.text !== "WHERE" && start.text !== "ON")
    ) {
      continue;
    }
    const clauseKind = start.text;
    let targetAlias: string | undefined;
    if (clauseKind === "ON") {
      targetAlias = introducedDecisionAlias(tokens, clauseStart);
      if (targetAlias === undefined) {
        continue;
      }
    }
    let end = clauseStart + 1;
    while (end < tokens.length) {
      const token = tokens[end];
      if (
        token &&
        (token.depth < start.depth ||
          (token.depth === start.depth && isClauseEnd(token, clauseKind)))
      ) {
        break;
      }
      end += 1;
    }
    const clause = tokens.slice(clauseStart + 1, end);
    if (
      clause.some(
        (token) =>
          token.depth === start.depth &&
          token.kind === "word" &&
          token.text === "OR",
      )
    ) {
      continue;
    }
    for (let offset = 0; offset < clause.length; offset += 1) {
      const token = clause[offset];
      if (token?.kind !== "interpolation" || token.depth !== start.depth) {
        continue;
      }
      const previous = clause[offset - 1];
      const next = clause[offset + 1];
      const leftBoundary =
        previous === undefined ||
        (previous.kind === "word" &&
          previous.text === "AND" &&
          previous.depth === start.depth);
      const rightBoundary =
        next === undefined ||
        isClauseEnd(next, clauseKind) ||
        (next.kind === "word" &&
          next.text === "AND" &&
          next.depth === start.depth);
      const insideCase =
        caseDepthBefore(clause.slice(0, offset), start.depth) > 0;
      if (leftBoundary && rightBoundary && !insideCase && token.expression) {
        accepted.push({ expression: token.expression, targetAlias });
      }
    }
  }
  return accepted;
};
