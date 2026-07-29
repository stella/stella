// Require an explicit authorization-scope fragment on raw SQL reads from
// private search projections. Global search uses the RLS-bypassing root
// connection, so a newly added source branch without one of these fragments
// could leak result titles, snippets, counts, or facets across workspaces.
//
// This rule is intentionally syntactic. It proves that a query composes one
// of the small approved, import-verified scope builders; compiled-SQL and
// adversarial integration tests prove the predicates those builders emit.

import {
  getImportedName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

type ScopeDefinition = {
  node: unknown;
  parent?: unknown;
  type: string;
};

type ScopeVariable = {
  defs: ScopeDefinition[];
};

type Scope = {
  set: Map<string, ScopeVariable>;
  upper: Scope | null;
};

type RuleContext = {
  report: (descriptor: {
    data: { table: string };
    messageId: "missingScope";
    node: unknown;
  }) => void;
  sourceCode: {
    getScope: (node: unknown) => Scope;
  };
};

type ApprovedImport = {
  importedName: string;
  module: string;
};

const DRIZZLE_SQL_IMPORTS = [
  { importedName: "sql", module: "drizzle-orm" },
] as const satisfies readonly ApprovedImport[];

const PRIVATE_SEARCH_PROJECTIONS = {
  search_documents: {
    expectedAlias: "sd",
    scopeImports: [
      {
        importedName: "searchDocumentsAccessSql",
        module: "@/api/lib/search/contact-workspace-access-sql",
      },
    ],
    tableImports: [
      { importedName: "searchDocuments", module: "@/api/db/schema" },
      {
        importedName: "searchDocuments",
        module: "@/api/db/schema/templates",
      },
    ],
  },
  workspace_search_documents: {
    expectedAlias: "wsd",
    scopeImports: [
      {
        importedName: "workspaceSearchDocumentsAccessSql",
        module: "@/api/lib/search/contact-workspace-access-sql",
      },
    ],
    tableImports: [
      { importedName: "workspaceSearchDocuments", module: "@/api/db/schema" },
      {
        importedName: "workspaceSearchDocuments",
        module: "@/api/db/schema/templates",
      },
    ],
  },
  contact_search_documents: {
    expectedAlias: "csd",
    scopeImports: [
      {
        importedName: "contactWorkspaceAccessSql",
        module: "@/api/lib/search/contact-workspace-access-sql",
      },
    ],
    tableImports: [
      { importedName: "contactSearchDocuments", module: "@/api/db/schema" },
      {
        importedName: "contactSearchDocuments",
        module: "@/api/db/schema/templates",
      },
    ],
  },
  chat_thread_search_documents: {
    expectedAlias: "cst",
    scopeImports: [
      {
        importedName: "chatThreadScopeSql",
        module: "@/api/lib/search/chat-thread-scope-sql",
      },
    ],
    tableImports: [
      { importedName: "chatThreadSearchDocuments", module: "@/api/db/schema" },
      {
        importedName: "chatThreadSearchDocuments",
        module: "@/api/db/schema/chat",
      },
    ],
  },
} as const satisfies Record<
  string,
  {
    expectedAlias: string;
    scopeImports: readonly ApprovedImport[];
    tableImports: readonly ApprovedImport[];
  }
>;

const templateQuasiTexts = (node: Record<string, unknown>): string[] => {
  const quasi = node.quasi;
  if (!isAstNode(quasi) || !Array.isArray(quasi.quasis)) {
    return [];
  }

  return quasi.quasis.map((element) => {
    if (!isAstNode(element)) {
      return "";
    }
    const value = element.value;
    if (typeof value !== "object" || value === null || !("raw" in value)) {
      return "";
    }
    const raw = value.raw;
    return typeof raw === "string" ? raw : "";
  });
};

const templateExpressions = (node: Record<string, unknown>): unknown[] => {
  const quasi = node.quasi;
  if (isAstNode(quasi) && Array.isArray(quasi.expressions)) {
    return quasi.expressions;
  }
  return [];
};

const staticTemplateLiteralText = (node: unknown): string | null => {
  if (
    !isAstNode(node) ||
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.expressions) ||
    node.expressions.length > 0 ||
    !Array.isArray(node.quasis)
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const element of node.quasis) {
    if (!isAstNode(element)) {
      return null;
    }
    const value = element.value;
    if (typeof value !== "object" || value === null || !("raw" in value)) {
      return null;
    }
    const raw = value.raw;
    if (typeof raw !== "string") {
      return null;
    }
    parts.push(raw);
  }
  return parts.join("");
};

type SqlTemplateToken =
  | { type: "expression"; value: unknown }
  | { type: "text"; value: string };

const mergeAdjacentSqlTextTokens = (
  tokens: readonly SqlTemplateToken[],
): SqlTemplateToken[] => {
  const merged: SqlTemplateToken[] = [];
  for (const token of tokens) {
    const previous = merged.at(-1);
    if (token.type === "text" && previous?.type === "text") {
      previous.value += ` ${token.value}`;
      continue;
    }
    if (token.type === "text") {
      merged.push({ type: "text", value: token.value });
    } else {
      merged.push({ type: "expression", value: token.value });
    }
  }
  return merged;
};

const concatenateSqlTokenPaths = (
  left: readonly SqlTemplateToken[],
  right: readonly SqlTemplateToken[],
): SqlTemplateToken[] => {
  const leftTail = left.at(-1);
  const rightHead = right.at(0);
  if (leftTail?.type !== "text" || rightHead?.type !== "text") {
    return left.concat(right);
  }
  return [
    ...left.slice(0, -1),
    { type: "text", value: leftTail.value + rightHead.value },
    ...right.slice(1),
  ];
};

const SQL_ALIAS_STOP_WORDS = new Set([
  "cross",
  "except",
  "full",
  "group",
  "inner",
  "intersect",
  "join",
  "left",
  "limit",
  "offset",
  "on",
  "order",
  "outer",
  "returning",
  "right",
  "set",
  "union",
  "values",
  "where",
  "window",
]);

const normalizeProjectionAlias = (alias: string | undefined): string | null => {
  if (!alias) {
    return null;
  }
  if (alias.startsWith('"') && alias.endsWith('"')) {
    return alias.slice(1, -1).replaceAll('""', '"');
  }
  const normalized = alias.toLowerCase();
  return SQL_ALIAS_STOP_WORDS.has(normalized) ? null : normalized;
};

const SQL_IDENTIFIER_PATTERN = `(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)`;
const SQL_RELATION_PATH_PATTERN =
  `${SQL_IDENTIFIER_PATTERN}` + `(?:\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN})*`;
const SQL_RELATION_REFERENCE = new RegExp(
  `(?:\\b(?:from|join|table)\\s+|,\\s*)` +
    `(?:only\\s+)?(?:\\(\\s*)*(?:only\\s+)?` +
    `(${SQL_RELATION_PATH_PATTERN})` +
    `(?:\\s+(?:as\\s+)?(${SQL_IDENTIFIER_PATTERN}))?`,
  "giu",
);
const SQL_FROM_CLAUSE_BOUNDARY =
  /\b(?:except|from|group|having|intersect|limit|offset|order|returning|union|where|window)\b/giu;

const normalizeSqlIdentifier = (identifier: string): string => {
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replaceAll('""', '"');
  }
  return identifier.toLowerCase();
};

const finalRelationIdentifier = (path: string): string | null => {
  const identifiers = path.match(new RegExp(SQL_IDENTIFIER_PATTERN, "gu"));
  const finalIdentifier = identifiers?.at(-1);
  return finalIdentifier === undefined
    ? null
    : normalizeSqlIdentifier(finalIdentifier);
};

const commaIntroducesFromRelation = (
  text: string,
  commaIndex: number,
): boolean => {
  const precedingText = text
    .slice(0, commaIndex)
    .replaceAll(/"(?:[^"]|"")*"/gu, (identifier) =>
      " ".repeat(identifier.length),
    );
  const boundaries = [...precedingText.matchAll(SQL_FROM_CLAUSE_BOUNDARY)];
  const latestBoundary = boundaries.at(-1);
  if (latestBoundary?.at(0)?.toLowerCase() !== "from") {
    return false;
  }
  const fromIndex = latestBoundary.index;
  if (fromIndex === undefined) {
    return false;
  }
  let parenthesisDepth = 0;
  for (const character of precedingText.slice(fromIndex)) {
    if (character === "(") {
      parenthesisDepth += 1;
    } else if (character === ")") {
      parenthesisDepth -= 1;
    }
  }
  return parenthesisDepth === 0;
};

const projectionReadAliases = (
  text: string,
  table: string,
  initialLexState: SqlLexState,
): (string | null)[] => {
  const structuralText = sqlStructuralText(text, initialLexState);
  const aliases: (string | null)[] = [];
  for (const match of structuralText.matchAll(SQL_RELATION_REFERENCE)) {
    const relationPath = match.at(1);
    const fullMatch = match.at(0);
    if (
      relationPath === undefined ||
      fullMatch === undefined ||
      finalRelationIdentifier(relationPath) !== table
    ) {
      continue;
    }
    if (
      fullMatch.trimStart().startsWith(",") &&
      (match.index === undefined ||
        !commaIntroducesFromRelation(structuralText, match.index))
    ) {
      continue;
    }
    aliases.push(normalizeProjectionAlias(match.at(2)));
  }
  return aliases;
};

const leadingProjectionAlias = (text: string): string | null => {
  const match = text.match(
    new RegExp(
      `^\\s+(?:as\\s+)?(${SQL_IDENTIFIER_PATTERN})(?=\\s|$|[,;)])`,
      "iu",
    ),
  );
  return normalizeProjectionAlias(match?.at(1));
};

const hasProjectionReadIntroducer = (
  tokens: readonly SqlTemplateToken[],
  expressionIndex: number,
): boolean => {
  let precedingText = "";
  for (let index = expressionIndex - 1; index >= 0; index -= 1) {
    const token = tokens.at(index);
    if (token?.type !== "text") {
      break;
    }
    precedingText = token.value + precedingText;
  }
  if (
    /\b(?:from|join|table)\s+(?:only\s+)?(?:\(\s*)*(?:only\s+)?$/iu.test(
      precedingText,
    )
  ) {
    return true;
  }
  const commaIndex = precedingText.search(
    /,\s*(?:only\s+)?(?:\(\s*)*(?:only\s+)?$/iu,
  );
  return (
    commaIndex >= 0 && commaIntroducesFromRelation(precedingText, commaIndex)
  );
};

type SqlLexState =
  | { type: "block-comment"; depth: number }
  | { type: "dollar-quote"; delimiter: string }
  | { type: "double-quote" }
  | { type: "line-comment" }
  | { type: "normal" }
  | { type: "single-quote" };

const DOLLAR_QUOTE_START = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;

const sqlLexStateAfter = (
  text: string,
  initialState: SqlLexState,
): SqlLexState => {
  let state = initialState;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    switch (state.type) {
      case "normal":
        if (char === "-" && next === "-") {
          state = { type: "line-comment" };
          index += 1;
        } else if (char === "/" && next === "*") {
          state = { type: "block-comment", depth: 1 };
          index += 1;
        } else if (char === "'") {
          state = { type: "single-quote" };
        } else if (char === '"') {
          state = { type: "double-quote" };
        } else if (char === "$") {
          const delimiter = text.slice(index).match(DOLLAR_QUOTE_START)?.at(0);
          if (delimiter) {
            state = { type: "dollar-quote", delimiter };
            index += delimiter.length - 1;
          }
        }
        break;
      case "line-comment":
        if (char === "\n" || char === "\r") {
          state = { type: "normal" };
        }
        break;
      case "block-comment":
        if (char === "/" && next === "*") {
          state = { type: "block-comment", depth: state.depth + 1 };
          index += 1;
        } else if (char === "*" && next === "/") {
          state =
            state.depth === 1
              ? { type: "normal" }
              : { type: "block-comment", depth: state.depth - 1 };
          index += 1;
        }
        break;
      case "single-quote":
        if (char === "\\" && next !== undefined) {
          index += 1;
        } else if (char === "'" && next === "'") {
          index += 1;
        } else if (char === "'") {
          state = { type: "normal" };
        }
        break;
      case "double-quote":
        if (char === "\\" && next !== undefined) {
          index += 1;
        } else if (char === '"' && next === '"') {
          index += 1;
        } else if (char === '"') {
          state = { type: "normal" };
        }
        break;
      case "dollar-quote":
        if (text.startsWith(state.delimiter, index)) {
          index += state.delimiter.length - 1;
          state = { type: "normal" };
        }
        break;
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  }
  return state;
};

const sqlStructuralText = (text: string, initialState: SqlLexState): string => {
  let state = initialState;
  let structuralText = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    switch (state.type) {
      case "normal":
        if (char === "-" && next === "-") {
          structuralText += "  ";
          state = { type: "line-comment" };
          index += 1;
        } else if (char === "/" && next === "*") {
          structuralText += "  ";
          state = { type: "block-comment", depth: 1 };
          index += 1;
        } else if (char === "'") {
          structuralText += " ";
          state = { type: "single-quote" };
        } else if (char === '"') {
          structuralText += char;
          state = { type: "double-quote" };
        } else if (char === "$") {
          const delimiter = text.slice(index).match(DOLLAR_QUOTE_START)?.at(0);
          if (delimiter) {
            structuralText += " ".repeat(delimiter.length);
            state = { type: "dollar-quote", delimiter };
            index += delimiter.length - 1;
          } else {
            structuralText += char;
          }
        } else {
          structuralText += char;
        }
        break;
      case "line-comment":
        structuralText += char === "\n" || char === "\r" ? char : " ";
        if (char === "\n" || char === "\r") {
          state = { type: "normal" };
        }
        break;
      case "block-comment":
        structuralText += " ";
        if (char === "/" && next === "*") {
          structuralText += " ";
          state = { type: "block-comment", depth: state.depth + 1 };
          index += 1;
        } else if (char === "*" && next === "/") {
          structuralText += " ";
          state =
            state.depth === 1
              ? { type: "normal" }
              : { type: "block-comment", depth: state.depth - 1 };
          index += 1;
        }
        break;
      case "single-quote":
        structuralText += " ";
        if (char === "\\" && next !== undefined) {
          structuralText += " ";
          index += 1;
        } else if (char === "'" && next === "'") {
          structuralText += " ";
          index += 1;
        } else if (char === "'") {
          state = { type: "normal" };
        }
        break;
      case "double-quote":
        structuralText += char;
        if (char === "\\" && next !== undefined) {
          structuralText += next;
          index += 1;
        } else if (char === '"' && next === '"') {
          structuralText += next;
          index += 1;
        } else if (char === '"') {
          state = { type: "normal" };
        }
        break;
      case "dollar-quote":
        if (text.startsWith(state.delimiter, index)) {
          structuralText += " ".repeat(state.delimiter.length);
          index += state.delimiter.length - 1;
          state = { type: "normal" };
        } else {
          structuralText += char === "\n" || char === "\r" ? char : " ";
        }
        break;
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  }
  return structuralText;
};

type SqlBranchTextPart = {
  endsBranch: boolean;
  text: string;
};

type SqlQueryNestingState = {
  currentQueryId: number;
  lexState: SqlLexState;
  nextQueryId: number;
  parentheses: {
    parentQueryId: number;
    queryId: number | null;
  }[];
};

type SqlQueryNestingEvent =
  | { queryId: number; text: string; type: "text" }
  | { queryId: number; type: "end-query" };

const SQL_QUERY_NESTING_TOKEN = /[()]|\b(?:select|table|values|with)\b/giu;

const sqlQueryNestingEvents = (
  text: string,
  state: SqlQueryNestingState,
): SqlQueryNestingEvent[] => {
  const events: SqlQueryNestingEvent[] = [];
  let partStart = 0;
  let scanCursor = 0;
  for (const match of text.matchAll(SQL_QUERY_NESTING_TOKEN)) {
    const matchIndex = match.index;
    const matchText = match.at(0);
    if (matchIndex === undefined || matchText === undefined) {
      continue;
    }
    state.lexState = sqlLexStateAfter(
      text.slice(scanCursor, matchIndex),
      state.lexState,
    );
    const isStructuralToken = state.lexState.type === "normal";
    state.lexState = sqlLexStateAfter(matchText, state.lexState);
    scanCursor = matchIndex + matchText.length;
    if (!isStructuralToken) {
      continue;
    }

    if (matchText === "(") {
      state.parentheses.push({
        parentQueryId: state.currentQueryId,
        queryId: null,
      });
      continue;
    }

    if (matchText === ")") {
      const frame = state.parentheses.pop();
      if (frame?.queryId === null || frame === undefined) {
        continue;
      }
      if (partStart < matchIndex) {
        events.push({
          type: "text",
          queryId: state.currentQueryId,
          text: text.slice(partStart, matchIndex),
        });
      }
      events.push({ type: "end-query", queryId: frame.queryId });
      state.currentQueryId = frame.parentQueryId;
      events.push({
        type: "text",
        queryId: state.currentQueryId,
        text: matchText,
      });
      partStart = scanCursor;
      continue;
    }

    const frame = state.parentheses.at(-1);
    if (!frame || frame.queryId !== null) {
      continue;
    }
    if (partStart < matchIndex) {
      events.push({
        type: "text",
        queryId: state.currentQueryId,
        text: text.slice(partStart, matchIndex),
      });
    }
    frame.queryId = state.nextQueryId;
    state.currentQueryId = state.nextQueryId;
    state.nextQueryId += 1;
    partStart = matchIndex;
  }

  state.lexState = sqlLexStateAfter(text.slice(scanCursor), state.lexState);
  if (partStart < text.length) {
    events.push({
      type: "text",
      queryId: state.currentQueryId,
      text: text.slice(partStart),
    });
  }
  return events;
};

const SQL_QUERY_BOUNDARY = /;|\b(?:except|intersect|union(?:\s+all)?)\b/giu;

const splitAtSqlQueryBoundaries = (
  text: string,
  initialState: SqlLexState,
): SqlBranchTextPart[] => {
  const parts: SqlBranchTextPart[] = [];
  let scanCursor = 0;
  let partStart = 0;
  let scanState = initialState;
  for (const match of text.matchAll(SQL_QUERY_BOUNDARY)) {
    const matchIndex = match.index;
    const matchText = match.at(0);
    if (matchIndex === undefined || matchText === undefined) {
      continue;
    }
    scanState = sqlLexStateAfter(text.slice(scanCursor, matchIndex), scanState);
    const isBoundary = scanState.type === "normal";
    scanState = sqlLexStateAfter(matchText, scanState);
    scanCursor = matchIndex + matchText.length;
    if (!isBoundary) {
      continue;
    }
    parts.push({ endsBranch: true, text: text.slice(partStart, matchIndex) });
    partStart = scanCursor;
  }
  parts.push({ endsBranch: false, text: text.slice(partStart) });
  return parts;
};

type SqlScopeClause = "inner-join-on" | "non-filtering" | "query-filter";

type SqlScopeContext = {
  aggregateFilterDepth: number;
  aggregateFilterOuterClause: SqlScopeClause | null;
  caseDepth: number;
  caseOuterClause: SqlScopeClause | null;
  clause: SqlScopeClause;
  currentJoinIsOuter: boolean;
  functionArgumentDepth: number;
  functionArgumentOuterClause: SqlScopeClause | null;
  hasNonConjunctiveFilter: boolean;
  pendingJoinIsOuter: boolean;
  pendingAggregateFilter: boolean;
};

const INITIAL_SQL_SCOPE_CONTEXT: SqlScopeContext = {
  aggregateFilterDepth: 0,
  aggregateFilterOuterClause: null,
  caseDepth: 0,
  caseOuterClause: null,
  clause: "non-filtering",
  currentJoinIsOuter: false,
  functionArgumentDepth: 0,
  functionArgumentOuterClause: null,
  hasNonConjunctiveFilter: false,
  pendingJoinIsOuter: false,
  pendingAggregateFilter: false,
};

type ProjectionQueryState = {
  protectedReadCount: number;
  scopeContext: SqlScopeContext;
  scopeEligibleReadCount: number;
  sqlLexState: SqlLexState;
  unscopedReadCount: number;
};

const createProjectionQueryState = (): ProjectionQueryState => ({
  protectedReadCount: 0,
  scopeContext: INITIAL_SQL_SCOPE_CONTEXT,
  scopeEligibleReadCount: 0,
  sqlLexState: { type: "normal" },
  unscopedReadCount: 0,
});

const resetProjectionQueryBranch = (state: ProjectionQueryState): void => {
  state.protectedReadCount = 0;
  state.scopeContext = INITIAL_SQL_SCOPE_CONTEXT;
  state.scopeEligibleReadCount = 0;
  state.unscopedReadCount = 0;
};

const projectionQueryBranchIsUnscoped = (
  state: ProjectionQueryState,
): boolean =>
  state.unscopedReadCount > 0 ||
  (state.protectedReadCount > 0 && state.scopeContext.hasNonConjunctiveFilter);

const finishProjectionQuery = (
  queryStates: Map<number, ProjectionQueryState>,
  queryId: number,
): boolean => {
  const queryState = queryStates.get(queryId);
  if (!queryState) {
    return false;
  }
  queryStates.delete(queryId);
  return projectionQueryBranchIsUnscoped(queryState);
};

const SQL_CLAUSE_KEYWORDS = [
  "cross",
  "from",
  "full",
  "group",
  "having",
  "inner",
  "join",
  "left",
  "limit",
  "offset",
  "on",
  "or",
  "order",
  "returning",
  "right",
  "select",
  "set",
  "not",
  "values",
  "where",
  "window",
] as const;

type SqlClauseKeyword = (typeof SQL_CLAUSE_KEYWORDS)[number];

const isSqlClauseKeyword = (value: string): value is SqlClauseKeyword =>
  SQL_CLAUSE_KEYWORDS.some((keyword) => keyword === value);

const SQL_SCOPE_CONTEXT_TOKEN =
  /[()]|\b(?:not\s+)?in\s*\(\s*(?:false|true)\s*\)|\bis\s+(?:false|unknown|null|not\s+(?:true|unknown|null)|distinct\s+from\s+true|not\s+distinct\s+from\s+false)\b|=\s*\bfalse\b|(?:!=|<>)\s*\btrue\b|\bfalse\b\s*(?:=|is\s+not\s+distinct\s+from)|\btrue\b\s*(?:!=|<>|is\s+distinct\s+from)|\b(?:case|cross|end|filter|from|full|group|having|inner|join|left|limit|not|offset|on|or|order|returning|right|select|set|values|where|window)\b/giu;

const INVERSE_BOOLEAN_MEMBERSHIP_TESTS = new Set(["in(false)", "notin(true)"]);

const isInverseBooleanMembershipTest = (value: string): boolean =>
  INVERSE_BOOLEAN_MEMBERSHIP_TESTS.has(value.replaceAll(/\s/gu, ""));

const SQL_BOOLEAN_GROUPING_PREFIXES = new Set([
  "and",
  "else",
  "having",
  "not",
  "on",
  "or",
  "then",
  "when",
  "where",
]);

const isFunctionArgumentOpening = (
  text: string,
  index: number,
  initialLexState: SqlLexState,
): boolean => {
  const prefix = sqlStructuralText(text.slice(0, index), initialLexState);
  const identifier = prefix
    .match(
      new RegExp(
        `(${SQL_IDENTIFIER_PATTERN})(?:\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN})*\\s*$`,
        "u",
      ),
    )
    ?.at(1);
  if (identifier === undefined) {
    return false;
  }
  return !SQL_BOOLEAN_GROUPING_PREFIXES.has(
    normalizeSqlIdentifier(identifier).toLowerCase(),
  );
};

const sqlScopeContextAfter = (
  text: string,
  initialLexState: SqlLexState,
  initialContext: SqlScopeContext,
): SqlScopeContext => {
  const context = { ...initialContext };
  let scanCursor = 0;
  let scanState = initialLexState;
  for (const match of text.matchAll(SQL_SCOPE_CONTEXT_TOKEN)) {
    const matchIndex = match.index;
    const matchText = match.at(0)?.toLowerCase();
    if (matchIndex === undefined || matchText === undefined) {
      continue;
    }
    scanState = sqlLexStateAfter(text.slice(scanCursor, matchIndex), scanState);
    scanCursor = matchIndex + matchText.length;
    if (scanState.type !== "normal") {
      continue;
    }
    if (matchText === "case") {
      if (context.caseDepth === 0) {
        context.caseOuterClause = context.clause;
        context.clause = "non-filtering";
      }
      context.caseDepth += 1;
      continue;
    }
    if (matchText === "end" && context.caseDepth > 0) {
      context.caseDepth -= 1;
      if (context.caseDepth === 0) {
        context.clause = context.caseOuterClause ?? "non-filtering";
        context.caseOuterClause = null;
      }
      continue;
    }
    if (matchText === "filter") {
      context.pendingAggregateFilter = true;
      continue;
    }
    if (matchText === "(") {
      if (context.pendingAggregateFilter) {
        Object.assign(context, {
          aggregateFilterDepth: 1,
          aggregateFilterOuterClause: context.clause,
          clause: "non-filtering",
          pendingAggregateFilter: false,
        });
      } else if (context.aggregateFilterDepth > 0) {
        context.aggregateFilterDepth += 1;
      } else if (context.functionArgumentDepth > 0) {
        context.functionArgumentDepth += 1;
      } else if (
        context.clause !== "non-filtering" &&
        isFunctionArgumentOpening(text, matchIndex, initialLexState)
      ) {
        Object.assign(context, {
          clause: "non-filtering",
          functionArgumentDepth: 1,
          functionArgumentOuterClause: context.clause,
        });
      }
      continue;
    }
    if (matchText === ")") {
      if (context.aggregateFilterDepth === 1) {
        Object.assign(context, {
          aggregateFilterDepth: 0,
          aggregateFilterOuterClause: null,
          clause: context.aggregateFilterOuterClause ?? "non-filtering",
        });
      } else if (context.aggregateFilterDepth > 1) {
        context.aggregateFilterDepth -= 1;
      } else if (context.functionArgumentDepth === 1) {
        Object.assign(context, {
          clause: context.functionArgumentOuterClause ?? "non-filtering",
          functionArgumentDepth: 0,
          functionArgumentOuterClause: null,
        });
      } else if (context.functionArgumentDepth > 1) {
        context.functionArgumentDepth -= 1;
      }
      continue;
    }
    if (/^(?:not\s+)?in\b/iu.test(matchText)) {
      context.hasNonConjunctiveFilter ||=
        context.clause !== "non-filtering" &&
        isInverseBooleanMembershipTest(matchText);
      continue;
    }
    if (!isSqlClauseKeyword(matchText)) {
      context.hasNonConjunctiveFilter ||= context.clause !== "non-filtering";
      continue;
    }
    const keyword = matchText;
    switch (keyword) {
      case "left":
      case "right":
      case "full":
        Object.assign(context, {
          clause: "non-filtering",
          pendingJoinIsOuter: true,
        });
        break;
      case "inner":
      case "cross":
        Object.assign(context, {
          clause: "non-filtering",
          pendingJoinIsOuter: false,
        });
        break;
      case "join":
        Object.assign(context, {
          clause: "non-filtering",
          currentJoinIsOuter: context.pendingJoinIsOuter,
          pendingJoinIsOuter: false,
        });
        break;
      case "on":
        context.clause = context.currentJoinIsOuter
          ? "non-filtering"
          : "inner-join-on";
        break;
      case "having":
        context.clause = "non-filtering";
        break;
      case "where":
        context.clause =
          context.aggregateFilterDepth > 0 || context.caseDepth > 0
            ? "non-filtering"
            : "query-filter";
        break;
      case "or":
      case "not":
        context.hasNonConjunctiveFilter ||= context.clause !== "non-filtering";
        break;
      case "from":
      case "group":
      case "limit":
      case "offset":
      case "order":
      case "returning":
      case "select":
      case "set":
      case "values":
      case "window":
        context.clause = "non-filtering";
        break;
      default: {
        const exhaustive: never = keyword;
        return exhaustive;
      }
    }
  }
  return context;
};

export default {
  meta: { name: "require-search-scope" },
  rules: {
    "require-search-scope": {
      meta: {
        type: "problem",
        messages: {
          missingScope:
            "Raw read from private search projection `{{table}}` must " +
            "compose an approved workspace/contact/chat authorization scope " +
            "fragment. Add the appropriate scope helper; do not post-filter.",
        },
      },
      create(context: RuleContext) {
        const resolveVariable = (
          identifier: AstNode & { name: string },
        ): ScopeVariable | null => {
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope) {
            const variable = scope.set.get(identifier.name);
            if (variable) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const isApprovedImport = (
          identifier: AstNode & { name: string },
          approvedImports: readonly ApprovedImport[],
        ): boolean => {
          const variable = resolveVariable(identifier);
          return (
            variable?.defs.some((definition) => {
              if (
                definition.type !== "ImportBinding" ||
                !isAstNode(definition.node) ||
                !isAstNode(definition.parent) ||
                definition.parent.type !== "ImportDeclaration" ||
                !isStringLiteral(definition.parent.source)
              ) {
                return false;
              }
              const importedName = getImportedName(definition.node);
              const source = definition.parent.source;
              return approvedImports.some(
                (approved) =>
                  approved.importedName === importedName &&
                  approved.module === source.value,
              );
            }) === true
          );
        };

        const isSqlMethodCall = (
          expression: unknown,
          method: "join" | "raw",
        ): boolean => {
          const unwrapped = unwrapExpression(expression);
          if (
            !isAstNode(unwrapped) ||
            unwrapped.type !== "CallExpression" ||
            !isAstNode(unwrapped.callee) ||
            unwrapped.callee.type !== "MemberExpression"
          ) {
            return false;
          }
          const object = unwrapExpression(unwrapped.callee.object);
          if (
            !isIdentifier(object) ||
            !isApprovedImport(object, DRIZZLE_SQL_IMPORTS)
          ) {
            return false;
          }
          const property = unwrapped.callee.property;
          return (
            (isIdentifier(property) &&
              unwrapped.callee.computed !== true &&
              property.name === method) ||
            (unwrapped.callee.computed === true &&
              isStringLiteral(property) &&
              property.value === method)
          );
        };

        const isApprovedScopeCall = (
          expression: unknown,
          approvedImports: readonly ApprovedImport[],
        ): boolean => {
          const unwrapped = unwrapExpression(expression);
          return (
            isAstNode(unwrapped) &&
            unwrapped.type === "CallExpression" &&
            isIdentifier(unwrapped.callee) &&
            isApprovedImport(unwrapped.callee, approvedImports)
          );
        };

        const isApprovedScopeFragment = (
          expression: unknown,
          approvedImports: readonly ApprovedImport[],
        ): boolean => {
          const unwrapped = unwrapExpression(expression);
          if (isApprovedScopeCall(unwrapped, approvedImports)) {
            return true;
          }
          if (!isIdentifier(unwrapped)) {
            return false;
          }
          const variable = resolveVariable(unwrapped);
          return (
            variable?.defs.some((definition) => {
              if (
                definition.type !== "Variable" ||
                !isAstNode(definition.node) ||
                definition.node.type !== "VariableDeclarator" ||
                !isAstNode(definition.parent) ||
                definition.parent.type !== "VariableDeclaration" ||
                definition.parent.kind !== "const"
              ) {
                return false;
              }
              return isApprovedScopeCall(definition.node.init, approvedImports);
            }) === true
          );
        };

        const isPrivateProjectionInterpolation = (
          expression: unknown,
          tableImports: readonly ApprovedImport[],
        ): boolean => {
          const unwrapped = unwrapExpression(expression);
          return (
            isIdentifier(unwrapped) && isApprovedImport(unwrapped, tableImports)
          );
        };

        const resolveConstInitializer = (expression: unknown): unknown => {
          const unwrapped = unwrapExpression(expression);
          if (!isIdentifier(unwrapped)) {
            return unwrapped;
          }
          const variable = resolveVariable(unwrapped);
          for (const definition of variable?.defs ?? []) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              continue;
            }
            return unwrapExpression(definition.node.init);
          }
          return unwrapped;
        };

        const expressionTokenPaths = (value: unknown): SqlTemplateToken[][] => [
          [
            {
              type: "expression",
              value,
            },
          ],
        ];

        const staticRawSqlText = (call: AstNode): string | null => {
          if (!Array.isArray(call.arguments)) {
            return null;
          }
          const argument = call.arguments.at(0);
          if (argument === undefined) {
            return null;
          }
          const resolved = resolveConstInitializer(argument);
          return isStringLiteral(resolved)
            ? resolved.value
            : staticTemplateLiteralText(resolved);
        };

        const resolveSqlArrayElements = (
          expression: unknown,
          ancestors: ReadonlySet<unknown>,
        ): unknown[] | null => {
          const unwrapped = unwrapExpression(expression);
          if (!isAstNode(unwrapped) || ancestors.has(unwrapped)) {
            return null;
          }
          const resolved = resolveConstInitializer(unwrapped);
          if (resolved !== unwrapped) {
            const nextAncestors = new Set(ancestors);
            nextAncestors.add(unwrapped);
            return resolveSqlArrayElements(resolved, nextAncestors);
          }
          if (
            !isAstNode(resolved) ||
            resolved.type !== "ArrayExpression" ||
            !Array.isArray(resolved.elements)
          ) {
            return null;
          }
          const nextAncestors = new Set(ancestors);
          nextAncestors.add(resolved);
          const elements: unknown[] = [];
          for (const element of resolved.elements) {
            if (element === null) {
              continue;
            }
            if (isAstNode(element) && element.type === "SpreadElement") {
              const spreadElements = resolveSqlArrayElements(
                element.argument,
                nextAncestors,
              );
              if (spreadElements === null) {
                return null;
              }
              elements.push(...spreadElements);
              continue;
            }
            elements.push(element);
          }
          return elements;
        };

        const flattenSqlTemplate = (
          node: AstNode,
          ancestors: ReadonlySet<unknown> = new Set(),
        ): SqlTemplateToken[][] => {
          if (ancestors.has(node)) {
            return [];
          }
          const nextAncestors = new Set(ancestors);
          nextAncestors.add(node);
          const quasiTexts = templateQuasiTexts(node);
          const expressions = templateExpressions(node);
          let paths: SqlTemplateToken[][] = [[]];
          for (const [index, quasiText] of quasiTexts.entries()) {
            paths = paths.map((path): SqlTemplateToken[] => [
              ...path,
              { type: "text", value: quasiText },
            ]);
            const expression = expressions.at(index);
            if (expression === undefined) {
              continue;
            }
            const nestedPaths =
              flattenSqlExpression(expression, nextAncestors) ??
              expressionTokenPaths(expression);
            paths = paths.flatMap((path) =>
              nestedPaths.map((nestedPath) => path.concat(nestedPath)),
            );
          }
          return paths;
        };

        const flattenSqlExpression = (
          expression: unknown,
          ancestors: ReadonlySet<unknown>,
        ): SqlTemplateToken[][] | null => {
          const unwrapped = unwrapExpression(expression);
          if (!isAstNode(unwrapped) || ancestors.has(unwrapped)) {
            return null;
          }
          const resolved = resolveConstInitializer(unwrapped);
          if (resolved !== unwrapped) {
            const nextAncestors = new Set(ancestors);
            nextAncestors.add(unwrapped);
            return (
              flattenSqlExpression(resolved, nextAncestors) ??
              expressionTokenPaths(resolved)
            );
          }
          if (!isAstNode(resolved)) {
            return null;
          }
          if (resolved.type === "TaggedTemplateExpression") {
            return flattenSqlTemplate(resolved, ancestors);
          }
          if (resolved.type === "SpreadElement") {
            return flattenSqlExpression(resolved.argument, ancestors);
          }
          if (
            resolved.type === "ArrayExpression" &&
            Array.isArray(resolved.elements)
          ) {
            const nextAncestors = new Set(ancestors);
            nextAncestors.add(resolved);
            return flattenSqlSequence({
              ancestors: nextAncestors,
              expressions: resolved.elements,
              isKnownSqlSequence: true,
            });
          }
          if (
            resolved.type === "CallExpression" &&
            Array.isArray(resolved.arguments)
          ) {
            const nextAncestors = new Set(ancestors);
            nextAncestors.add(resolved);
            if (isSqlMethodCall(resolved, "raw")) {
              const rawText = staticRawSqlText(resolved);
              return rawText === null
                ? null
                : [[{ type: "text", value: rawText }]];
            }
            if (isSqlMethodCall(resolved, "join")) {
              const values = resolved.arguments.at(0);
              if (values === undefined) {
                return null;
              }
              const elements = resolveSqlArrayElements(values, nextAncestors);
              if (elements === null) {
                return flattenSqlExpression(values, nextAncestors);
              }
              const separator = resolved.arguments.at(1);
              if (separator === undefined) {
                return flattenSqlSequence({
                  ancestors: nextAncestors,
                  expressions: elements,
                  isKnownSqlSequence: true,
                  textBoundary: "exact",
                });
              }
              const separatorPaths = flattenSqlExpression(
                separator,
                nextAncestors,
              );
              if (separatorPaths === null) {
                return flattenSqlAlternatives(elements, nextAncestors);
              }
              return flattenSqlSequence({
                ancestors: nextAncestors,
                expressions: elements,
                isKnownSqlSequence: true,
                separatorPaths,
                textBoundary: "exact",
              });
            }
            return flattenSqlAlternatives(resolved.arguments, nextAncestors);
          }
          if (
            resolved.type === "SequenceExpression" &&
            Array.isArray(resolved.expressions)
          ) {
            const finalExpression = resolved.expressions.at(-1);
            return finalExpression === undefined
              ? null
              : flattenSqlExpression(finalExpression, ancestors);
          }
          if (
            resolved.type !== "ConditionalExpression" &&
            resolved.type !== "LogicalExpression"
          ) {
            return null;
          }

          const nextAncestors = new Set(ancestors);
          nextAncestors.add(resolved);
          const branches =
            resolved.type === "ConditionalExpression"
              ? [resolved.consequent, resolved.alternate]
              : [resolved.left, resolved.right];
          return branches.flatMap(
            (branch) =>
              flattenSqlExpression(branch, nextAncestors) ??
              expressionTokenPaths(branch),
          );
        };

        type FlattenSqlSequenceOptions = {
          ancestors: ReadonlySet<unknown>;
          expressions: readonly unknown[];
          isKnownSqlSequence: boolean;
          separatorPaths?: readonly SqlTemplateToken[][] | undefined;
          textBoundary?: "exact" | "independent" | undefined;
        };

        const flattenSqlSequence = ({
          ancestors,
          expressions,
          isKnownSqlSequence,
          separatorPaths = [[]],
          textBoundary = "independent",
        }: FlattenSqlSequenceOptions): SqlTemplateToken[][] | null => {
          let hasSqlStructure = isKnownSqlSequence;
          let hasExpression = false;
          let paths: SqlTemplateToken[][] = [[]];
          for (const expression of expressions) {
            if (expression === null) {
              continue;
            }
            const flattened = flattenSqlExpression(expression, ancestors);
            if (flattened) {
              hasSqlStructure = true;
            }
            const expressionPaths =
              flattened ?? expressionTokenPaths(expression);
            if (hasExpression) {
              paths = paths.flatMap((path) =>
                separatorPaths.map((separatorPath) =>
                  textBoundary === "exact"
                    ? concatenateSqlTokenPaths(path, separatorPath)
                    : path.concat(separatorPath),
                ),
              );
            }
            paths = paths.flatMap((path) =>
              expressionPaths.map((expressionPath) =>
                textBoundary === "exact"
                  ? concatenateSqlTokenPaths(path, expressionPath)
                  : path.concat(expressionPath),
              ),
            );
            hasExpression = true;
          }
          return hasSqlStructure ? paths : null;
        };

        const flattenSqlAlternatives = (
          expressions: readonly unknown[],
          ancestors: ReadonlySet<unknown>,
        ): SqlTemplateToken[][] | null => {
          let hasSqlStructure = false;
          const paths: SqlTemplateToken[][] = [];
          for (const expression of expressions) {
            if (expression === null) {
              continue;
            }
            const flattened = flattenSqlExpression(expression, ancestors);
            if (flattened) {
              hasSqlStructure = true;
              for (const path of flattened) {
                paths.push(path);
              }
              continue;
            }
            for (const path of expressionTokenPaths(expression)) {
              paths.push(path);
            }
          }
          return hasSqlStructure ? paths : null;
        };

        const inspectSqlTokenPaths = (
          node: AstNode,
          tokenPaths: SqlTemplateToken[][],
        ): void => {
          const mergedTokenPaths = tokenPaths.map(mergeAdjacentSqlTextTokens);
          const text = mergedTokenPaths
            .flat()
            .filter(
              (token): token is Extract<SqlTemplateToken, { type: "text" }> =>
                token.type === "text",
            )
            .map((token) => token.value)
            .join(" ");
          if (!/\b(?:select|table)\b/iu.test(text)) {
            return;
          }

          for (const [table, projection] of Object.entries(
            PRIVATE_SEARCH_PROJECTIONS,
          )) {
            let hasUnscopedQuery = false;
            for (const tokens of mergedTokenPaths) {
              const queryStates = new Map<number, ProjectionQueryState>();
              const queryNestingState: SqlQueryNestingState = {
                currentQueryId: 0,
                lexState: { type: "normal" },
                nextQueryId: 1,
                parentheses: [],
              };
              const queryStateFor = (queryId: number): ProjectionQueryState => {
                const existing = queryStates.get(queryId);
                if (existing) {
                  return existing;
                }
                const created = createProjectionQueryState();
                queryStates.set(queryId, created);
                return created;
              };
              for (const [index, token] of tokens.entries()) {
                if (token.type === "text") {
                  for (const event of sqlQueryNestingEvents(
                    token.value,
                    queryNestingState,
                  )) {
                    if (event.type === "end-query") {
                      hasUnscopedQuery ||= finishProjectionQuery(
                        queryStates,
                        event.queryId,
                      );
                      continue;
                    }
                    const queryState = queryStateFor(event.queryId);
                    for (const part of splitAtSqlQueryBoundaries(
                      event.text,
                      queryState.sqlLexState,
                    )) {
                      const aliases = projectionReadAliases(
                        part.text,
                        table,
                        queryState.sqlLexState,
                      );
                      queryState.protectedReadCount += aliases.length;
                      queryState.unscopedReadCount += aliases.length;
                      queryState.scopeEligibleReadCount += aliases.filter(
                        (alias) => alias === projection.expectedAlias,
                      ).length;
                      queryState.scopeContext = sqlScopeContextAfter(
                        part.text,
                        queryState.sqlLexState,
                        queryState.scopeContext,
                      );
                      queryState.sqlLexState = sqlLexStateAfter(
                        part.text,
                        queryState.sqlLexState,
                      );
                      if (part.endsBranch) {
                        hasUnscopedQuery ||=
                          projectionQueryBranchIsUnscoped(queryState);
                        resetProjectionQueryBranch(queryState);
                      }
                    }
                  }
                  continue;
                }
                const queryState = queryStateFor(
                  queryNestingState.currentQueryId,
                );
                if (
                  queryState.sqlLexState.type === "normal" &&
                  hasProjectionReadIntroducer(tokens, index) &&
                  isPrivateProjectionInterpolation(
                    token.value,
                    projection.tableImports,
                  )
                ) {
                  queryState.protectedReadCount += 1;
                  queryState.unscopedReadCount += 1;
                  const nextToken = tokens.at(index + 1);
                  if (
                    nextToken?.type === "text" &&
                    leadingProjectionAlias(nextToken.value) ===
                      projection.expectedAlias
                  ) {
                    queryState.scopeEligibleReadCount += 1;
                  }
                }
                if (
                  queryState.unscopedReadCount > 0 &&
                  queryState.scopeEligibleReadCount > 0 &&
                  queryState.scopeContext.clause !== "non-filtering" &&
                  !queryState.scopeContext.hasNonConjunctiveFilter &&
                  queryState.sqlLexState.type === "normal" &&
                  isApprovedScopeFragment(token.value, projection.scopeImports)
                ) {
                  queryState.unscopedReadCount -= 1;
                  queryState.scopeEligibleReadCount -= 1;
                }
              }
              for (const queryId of [...queryStates.keys()]) {
                hasUnscopedQuery ||= finishProjectionQuery(
                  queryStates,
                  queryId,
                );
              }
            }
            if (!hasUnscopedQuery) {
              continue;
            }
            context.report({
              node,
              messageId: "missingScope",
              data: { table },
            });
          }
        };

        return {
          TaggedTemplateExpression(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            inspectSqlTokenPaths(node, flattenSqlTemplate(node));
          },
          CallExpression(node: unknown) {
            if (!isAstNode(node) || !isSqlMethodCall(node, "raw")) {
              return;
            }
            const rawText = staticRawSqlText(node);
            if (rawText === null) {
              return;
            }
            inspectSqlTokenPaths(node, [[{ type: "text", value: rawText }]]);
          },
        };
      },
    },
  },
};
