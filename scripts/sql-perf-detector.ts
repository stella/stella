// Static SQL shapes that can scan an input larger than the returned page.
//
// Flagged: a leading LIKE wildcard, any LIKE on an S3-key column, and a
// function or cast in GROUP BY over a corpus relation. Prefix LIKE on other
// columns, SELECT-only expressions, schema constraints, and plain strings pass.
// Analysis follows same-file const bindings; imported or runtime-built SQL is
// opaque. This detector is shared by oxlint and the baseline counter.

import ts from "typescript";

export type SqlPerfHit = {
  kind: "leading-wildcard" | "s3-key-like" | "group-by-expression";
  line: number;
  column: number;
  /**
   * Lines where a TypeScript comment can sit for this hit: its own line, the
   * start of the SQL template or call holding it, and the start of the
   * statement around that. A hit inside a multi-line template has no
   * TypeScript line of its own.
   */
  anchorLines: number[];
};

export type SqlPerfCommentError = { line: number; message: string };

const LIKE = /\b(?:NOT\s+)?I?LIKE\b/giu;
const CORPUS =
  /\b(?:case_law_decisions|legislation_documents|case_law_[a-z_]*citation[a-z_]*|caseLawDecisions|legislationDocuments|caseLaw\w*Citation\w*)\b/iu;
const GROUP_EXPRESSION =
  /\b(?:to_char|date_trunc|extract|substring|split_part|coalesce|lower)\s*\(|::\s*text\b|->>/iu;
const GROUP_NON_COLUMNS =
  /\b(?:to_char|date_trunc|extract|substring|split_part|coalesce|lower|cast|text|year|month|day|from|for|as|null|true|false|now|current_date|current_timestamp)\b/giu;
const SQL_STRING = /'(?:''|[^'])*'/gu;
const S3_KEY = /(?:\b[a-z][\w]*_s3_key\b|\b[a-z][\w]*S3Key\b)/iu;
const REASON =
  /^(?:small table\s+[a-z][\w.]*\b|index\s+[a-z][\w.]*\b|bounded by\s+\S[\s\S]*)/iu;
const COMMENT = /\/\/\s*sql-perf-allow:\s*(.*)$/iu;
const COMMENT_START = /\/\/\s*sql-perf-allow\b/iu;

type TemplateParts = {
  sql: string;
  offsets: number[];
  expressions: ts.Expression[];
};

const location = (file: ts.SourceFile, offset: number) => {
  const { line, character } = file.getLineAndCharacterOfPosition(offset);
  return { line: line + 1, column: character + 1 };
};

const propertyName = (node: ts.Node): string | undefined =>
  ts.isIdentifier(node) ? node.text : undefined;

const isSqlTag = (node: ts.TaggedTemplateExpression): boolean =>
  propertyName(node.tag) === "sql" ||
  (ts.isCallExpression(node.tag) &&
    propertyName(node.tag.expression) === "sql");

const isLikeCall = (node: ts.CallExpression): boolean => {
  const callee = node.expression;
  let name: string | undefined;
  if (ts.isIdentifier(callee)) {
    name = callee.text;
  } else if (ts.isPropertyAccessExpression(callee)) {
    name = callee.name.text;
  }
  return name !== undefined && /^(?:like|ilike|notLike|notIlike)$/u.test(name);
};

const isGroupByCall = (
  node: ts.CallExpression,
): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } =>
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "groupBy";

const textOfTemplate = (node: ts.TemplateLiteral): string =>
  ts.isNoSubstitutionTemplateLiteral(node) ? node.text : node.head.text;

const templateStartsWithWildcard = (node: ts.TemplateLiteral): boolean =>
  /^[%_]/u.test(textOfTemplate(node));

const sqlParts = (
  file: ts.SourceFile,
  template: ts.TemplateLiteral,
): TemplateParts => {
  const offsets: number[] = [];
  const expressions: ts.Expression[] = [];
  let sql = "";
  const append = (text: string, start: number) => {
    for (let index = 0; index < text.length; index += 1) {
      offsets.push(start + index);
    }
    sql += text;
  };
  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    append(template.text, template.getStart(file) + 1);
    return { sql, offsets, expressions };
  }
  append(template.head.text, template.head.getStart(file) + 1);
  for (const [index, span] of template.templateSpans.entries()) {
    expressions.push(span.expression);
    const marker = `__SQL_EXPR_${index}__`;
    append(marker, span.expression.getStart(file));
    append(span.literal.text, span.literal.getStart(file) + 1);
  }
  return { sql, offsets, expressions };
};

const constBindings = (file: ts.SourceFile): Map<string, ts.Expression> => {
  const bindings = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      // oxlint-disable-next-line eslint/no-bitwise -- TypeScript encodes declaration kind in flags
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bindings;
};

const resolve = (
  expression: ts.Expression,
  bindings: Map<string, ts.Expression>,
  depth = 0,
): ts.Expression => {
  if (depth > 4 || !ts.isIdentifier(expression)) {
    return expression;
  }
  const initializer = bindings.get(expression.text);
  return initializer === undefined
    ? expression
    : resolve(initializer, bindings, depth + 1);
};

const startsWithWildcard = (
  expression: ts.Expression,
  bindings: Map<string, ts.Expression>,
): boolean => {
  const value = resolve(expression, bindings);
  if (ts.isStringLiteral(value)) {
    return /^[%_]/u.test(value.text);
  }
  if (ts.isTemplateLiteral(value)) {
    return templateStartsWithWildcard(value);
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return startsWithWildcard(value.left, bindings);
  }
  return false;
};

const containsCorpus = (text: string): boolean => CORPUS.test(text);

const sqlExpressionText = (
  expression: ts.Expression,
  bindings: Map<string, ts.Expression>,
  file: ts.SourceFile,
): string => {
  const value = resolve(expression, bindings);
  return ts.isTaggedTemplateExpression(value) && isSqlTag(value)
    ? sqlParts(file, value.template).sql
    : value.getText(file);
};

const groupExpression = (
  expression: ts.Expression,
  bindings: Map<string, ts.Expression>,
  file: ts.SourceFile,
): boolean =>
  isGroupExpressionText(sqlExpressionText(expression, bindings, file));

const isGroupExpressionText = (text: string): boolean =>
  GROUP_EXPRESSION.test(text) &&
  /(?:__SQL_EXPR_\d+__|\b[a-z_][\w]*(?:\.[a-z_][\w]*)?\b)/iu.test(
    text.replace(SQL_STRING, " ").replace(GROUP_NON_COLUMNS, " "),
  );

const groupItems = (text: string) => {
  const items: { text: string; start: number }[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'") {
      if (quoted && text[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      items.push({ text: text.slice(start, index), start });
      start = index + 1;
    }
  }
  items.push({ text: text.slice(start), start });
  return items;
};

const allowCommentsOf = (source: string, file: ts.SourceFile) => {
  const comments: { line: number; reason: string }[] = [];
  const commentStarts = new Set<number>();
  const recordComments = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (
        range.kind !== ts.SyntaxKind.SingleLineCommentTrivia ||
        commentStarts.has(range.pos)
      ) {
        continue;
      }
      commentStarts.add(range.pos);
      const comment = source.slice(range.pos, range.end);
      if (!COMMENT_START.test(comment)) {
        continue;
      }
      const match = COMMENT.exec(comment);
      comments.push({
        line: location(file, range.pos).line,
        reason: match?.[1]?.trim() ?? "",
      });
    }
  };
  const visit = (node: ts.Node) => {
    recordComments(ts.getLeadingCommentRanges(source, node.getFullStart()));
    recordComments(ts.getTrailingCommentRanges(source, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return comments;
};

export const listSqlPerfAllowComments = (source: string, filename: string) => {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return allowCommentsOf(source, file);
};

/** The statement (or class member) a node sits in, where a comment can go. */
const statementOf = (node: ts.Node): ts.Node => {
  let current = node;
  while (
    current.parent !== undefined &&
    !ts.isBlock(current.parent) &&
    !ts.isSourceFile(current.parent) &&
    !ts.isModuleBlock(current.parent) &&
    !ts.isCaseClause(current.parent) &&
    !ts.isDefaultClause(current.parent) &&
    !ts.isClassLike(current.parent) &&
    !ts.isObjectLiteralExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
};

export const analyzeSqlPerf = (source: string, filename: string) => {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = constBindings(file);
  const rawHits: SqlPerfHit[] = [];
  const seen = new Set<string>();
  const add = (kind: SqlPerfHit["kind"], offset: number, holder: ts.Node) => {
    const place = location(file, offset);
    const key = `${kind}:${place.line}:${place.column}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    rawHits.push({
      kind,
      ...place,
      anchorLines: [
        place.line,
        location(file, holder.getStart(file)).line,
        location(file, statementOf(holder).getStart(file)).line,
      ],
    });
  };

  const inspectSql = (node: ts.TaggedTemplateExpression) => {
    if (!isSqlTag(node)) {
      return;
    }
    const { sql, offsets, expressions } = sqlParts(file, node.template);
    for (const match of /\bCHECK\s*\(/iu.test(sql) ? [] : sql.matchAll(LIKE)) {
      const index = match.index;
      const after = sql.slice(index + match[0].length);
      const before = sql.slice(Math.max(0, index - 100), index);
      const lhs = /(?:__SQL_EXPR_\d+__|[\w."-]+)\s*$/u.exec(before)?.[0] ?? "";
      const lhsMarker = /__SQL_EXPR_(\d+)__/u.exec(lhs);
      const lhsExpression =
        lhsMarker === null ? undefined : expressions[Number(lhsMarker[1])];
      const lhsText =
        lhsExpression === undefined ? lhs : lhsExpression.getText(file);
      const offset = offsets[index] ?? node.getStart(file);
      if (S3_KEY.test(lhsText)) {
        add("s3-key-like", offset, node);
      }

      const literal = /^\s*\(?\s*['"]\s*[%_]/u.test(after);
      const operand = /^\s*\(?\s*__SQL_EXPR_(\d+)__/u.exec(after);
      const expression =
        operand === null ? undefined : expressions[Number(operand[1])];
      if (
        literal ||
        (expression !== undefined && startsWithWildcard(expression, bindings))
      ) {
        add("leading-wildcard", offset, node);
      }
    }
    const group = /\bGROUP\s+BY\b/giu;
    for (const match of sql.matchAll(group)) {
      if (
        !containsCorpus(sql) &&
        !expressions.some((expression) =>
          containsCorpus(expression.getText(file)),
        )
      ) {
        continue;
      }
      const groupText =
        sql
          .slice(match.index + match[0].length)
          .split(/\b(?:ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION)\b/iu)
          .at(0) ?? "";
      for (const item of groupItems(groupText)) {
        const marker = /__SQL_EXPR_(\d+)__/u.exec(item.text);
        const expression =
          marker === null ? undefined : expressions[Number(marker[1])];
        if (
          isGroupExpressionText(item.text) ||
          (expression !== undefined &&
            groupExpression(expression, bindings, file))
        ) {
          const cursor = match.index + match[0].length + item.start;
          add(
            "group-by-expression",
            offsets[cursor] ?? node.getStart(file),
            node,
          );
        }
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      inspectSql(node);
    }
    if (ts.isCallExpression(node)) {
      if (isLikeCall(node) && node.arguments.length >= 2) {
        const column = node.arguments[0];
        const pattern = node.arguments[1];
        if (column !== undefined && S3_KEY.test(column.getText(file))) {
          add("s3-key-like", node.getStart(file), node);
        }
        if (pattern !== undefined && startsWithWildcard(pattern, bindings)) {
          add("leading-wildcard", node.getStart(file), node);
        }
      }
      if (isGroupByCall(node)) {
        const receiver = node.expression.expression.getText(file);
        if (containsCorpus(receiver)) {
          for (const argument of node.arguments) {
            if (groupExpression(argument, bindings, file)) {
              add("group-by-expression", argument.getStart(file), node);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const comments = allowCommentsOf(source, file).map(({ line, reason }) => ({
    line,
    reason,
    used: false,
  }));
  const hits = rawHits.filter((hit) => {
    const comment = comments.find(
      (entry) =>
        hit.anchorLines.some(
          (line) => entry.line === line || entry.line === line - 1,
        ) && REASON.test(entry.reason),
    );
    if (comment === undefined) {
      return true;
    }
    comment.used = true;
    return false;
  });
  const commentErrors: SqlPerfCommentError[] = comments.flatMap((comment) => {
    if (!REASON.test(comment.reason)) {
      return [
        {
          line: comment.line,
          message:
            "sql-perf-allow requires small table <name>, index <name>, or bounded by <description>.",
        },
      ];
    }
    return comment.used
      ? []
      : [
          {
            line: comment.line,
            message: "sql-perf-allow suppresses no SQL performance finding.",
          },
        ];
  });
  return { hits, commentErrors };
};
