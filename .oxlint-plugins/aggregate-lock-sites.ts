import {
  type Node,
  parseSource,
  type TemplateLiteral,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";
import { sha256Hex } from "../packages/sha256/src/node.ts";

export const AGGREGATE_LOCK_OWNER = "apps/api/src/lib/db/aggregate-lock.ts";
export const aggregateLockSourceIncluded = (file: string) =>
  /\.(?:[cm]?ts|tsx|[cm]?js|jsx|sql)$/u.test(file) &&
  file !== AGGREGATE_LOCK_OWNER &&
  !file.startsWith("apps/api/drizzle/") &&
  !/\.(?:test|fixture)\.|\/(?:__tests__|__fixtures__|fixtures|tests)\//u.test(
    file,
  ) &&
  file !== ".oxlint-plugins/aggregate-lock-sites.ts";
export type AggregateLockSite = {
  file: string;
  line: number;
  fingerprint: string;
  primitive: string;
};
export type AggregateLockBaselineRow = {
  file: string;
  fingerprint: string;
  count: number;
  reason: string;
};

const maskSqlLiteralsAndComments = (text: string) =>
  text.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:(?:'')|[^'])*'|"(?:(?:"")|[^"])*"/gu,
    (part) =>
      /^"pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?"$/iu.test(
        part,
      )
        ? part.replaceAll('"', " ")
        : part.replace(/[^\n]/gu, " "),
  );
const sqlLocks = (text: string, context: "sql" | "unknown" = "unknown") => {
  const masked = maskSqlLiteralsAndComments(text);
  const matches = [
    ...masked.matchAll(
      /\bpg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?\s*\(|\bLOCK\s+TABLE\b|\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b|\bROLLBACK\s+TO(?:\s+SAVEPOINT)?\b|\bRELEASE(?:\s+SAVEPOINT)?\b|\bSAVEPOINT\b/giu,
    ),
  ];
  return matches.filter((match) => {
    if (/^RELEASE$/iu.test(match[0]) && context === "unknown") {
      return false;
    }
    const start = masked.lastIndexOf(";", match.index) + 1;
    if (/^(?:SAVEPOINT|RELEASE|ROLLBACK)\b/iu.test(match[0])) {
      return (
        masked.slice(start, match.index).trim().length === 0 &&
        /^\s+\S/u.test(text.slice(match.index + match[0].length))
      );
    }
    // Outside a known SQL context, decide by what FOLLOWS the clause. In valid
    // SQL a row-lock clause is followed only by the end of the text, `;`, `)`,
    // `,`, a placeholder, `OF <table>`, NOWAIT, SKIP LOCKED, LIMIT, OFFSET,
    // FETCH or another locking clause. Lower-case wording followed by anything
    // else is prose ("metadata for update notifications"); a real clause
    // followed by such a word would not parse. Upper-case clauses always count.
    const after = masked.slice(match.index + match[0].length).trimStart();
    if (
      /^FOR\s/iu.test(match[0]) &&
      context === "unknown" &&
      match[0] !== match[0].toUpperCase() &&
      !/^(?:$|[;),$]|\$\{|(?:OF|NOWAIT|SKIP|LIMIT|OFFSET|FETCH|FOR)\b)/iu.test(
        after,
      )
    ) {
      return false;
    }
    if (!/^FOR\s+UPDATE$/iu.test(match[0])) {
      return true;
    }
    return !/\bCREATE\s+POLICY\b/iu.test(masked.slice(start, match.index));
  });
};
const fingerprint = (primitive: string, text: string) =>
  sha256Hex(`${primitive}:${text.replace(/\s+/gu, " ").trim()}`);
// The cooked text of a template without substitutions, like TypeScript's
// `text` of a string literal.
const templateText = (node: TemplateLiteral) =>
  node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
const staticText = (node: Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return templateText(node).join("");
  }
  if (node.type === "ParenthesizedExpression") {
    return staticText(node.expression);
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticText(node.left);
    const right = staticText(node.right);
    if (left !== undefined && right !== undefined) {
      return left + right;
    }
  }
  return undefined;
};
/** The name of a non-computed member, spelled as TypeScript's `name.text`. */
const memberName = (node: Node) => {
  if (node.type !== "MemberExpression" || node.computed) {
    return undefined;
  }
  return node.property.type === "PrivateIdentifier"
    ? `#${node.property.name}`
    : node.property.name;
};
type AddAggregateLockSiteOptions = {
  primitive: string;
  text: string;
  offset: number;
};
type SqlFragmentContextOptions = {
  ancestors: readonly Node[];
  source: string;
  text: string;
};
// Every operator TypeScript parses as one binary expression.
const BINARY_TYPES: ReadonlySet<string> = new Set([
  "AssignmentExpression",
  "BinaryExpression",
  "LogicalExpression",
  "SequenceExpression",
]);
const isSqlFragmentContext = ({
  ancestors,
  source,
  text,
}: SqlFragmentContextOptions) => {
  // The fragment's context is its nearest ancestor that does not combine it
  // into a larger expression.
  const parent = ancestors.findLast(
    (ancestor) =>
      !BINARY_TYPES.has(ancestor.type) &&
      ancestor.type !== "ParenthesizedExpression",
  );
  const textOf = (node: Node) => source.slice(node.start, node.end);
  const taggedSql =
    parent?.type === "TaggedTemplateExpression" && textOf(parent.tag) === "sql";
  const rawSql =
    parent?.type === "CallExpression" &&
    memberName(parent.callee) === "raw" &&
    parent.callee.type === "MemberExpression" &&
    textOf(parent.callee.object) === "sql";
  const executionSql =
    parent?.type === "CallExpression" &&
    ["execute", "query", "unsafe"].includes(
      (parent.callee.type === "Identifier"
        ? parent.callee.name
        : memberName(parent.callee)) ?? "",
    );
  const statement = text.trimStart();
  const sqlStatement =
    /^SELECT\b/iu.test(statement) ||
    (/^WITH\b/iu.test(statement) &&
      /\b(?:SELECT|UPDATE|DELETE|INSERT)\b/iu.test(statement)) ||
    (/^UPDATE\s+\S+/iu.test(statement) && /\bSET\b/iu.test(statement)) ||
    /^(?:DELETE\s+FROM|INSERT\s+INTO|LOCK\s+TABLE)\b/iu.test(statement);
  return taggedSql || rawSql || executionSql || sqlStatement;
};
export const aggregateLockSites = (
  file: string,
  source: string,
): AggregateLockSite[] => {
  const sites: AggregateLockSite[] = [];
  const add = ({ primitive, text, offset }: AddAggregateLockSiteOptions) =>
    sites.push({
      file,
      primitive,
      fingerprint: fingerprint(primitive, text),
      line: source.slice(0, offset).split("\n").length,
    });
  if (file.endsWith(".sql")) {
    for (const match of sqlLocks(source, "sql")) {
      const start = source.lastIndexOf(";", match.index) + 1;
      const end = source.indexOf(";", match.index);
      add({
        primitive: match[0].toLowerCase().replace(/\s+/gu, " "),
        text: source.slice(start, end === -1 ? source.length : end),
        offset: match.index,
      });
    }
    return sites;
  }
  const { program } = parseSource(file, source);
  const textOf = (node: Node) => source.slice(node.start, node.end);
  const addFragmentedSites = (
    node: Node,
    ancestors: readonly Node[],
    text: string,
  ) => {
    if (!isSqlFragmentContext({ ancestors, source, text })) {
      return;
    }
    const complete = sqlLocks(text, "sql");
    const fragments = maskSqlLiteralsAndComments(text).matchAll(
      /\bFOR(?:\s+(?:NO(?:\s+KEY)?|KEY))?\s*(?:$|\$\{expression\})|\bpg_(?:try_)?advisory[a-z_]*/giu,
    );
    for (const fragment of fragments) {
      if (complete.some((match) => match.index === fragment.index)) {
        continue;
      }
      add({
        primitive: fragment[0].toLowerCase().startsWith("for")
          ? "fragmented-row-lock"
          : "fragmented-advisory-lock",
        text: textOf(node),
        offset: node.start,
      });
    }
  };
  walk(program, (node, ancestors) => {
    if (node.type === "CallExpression") {
      const { callee } = node;
      const method =
        callee.type !== "MemberExpression"
          ? undefined
          : callee.computed
            ? staticText(callee.property)
            : memberName(callee);
      const receiver =
        callee.type === "MemberExpression" ? textOf(callee.object) : "";
      if (method === "for" && receiver !== "Symbol") {
        add({
          primitive: "builder-for",
          text: textOf(node),
          offset: node.start,
        });
      }
      if (method === "transaction" && file.startsWith("apps/api/")) {
        add({
          primitive: "transaction-boundary",
          text: textOf(node),
          offset: node.start,
        });
      }
      if (method === "raw" && receiver === "sql") {
        const argument = node.arguments.at(0);
        const text = argument === undefined ? undefined : staticText(argument);
        if (
          text !== undefined &&
          /^\s*pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?\s*$/iu.test(
            text,
          )
        ) {
          add({
            primitive: "raw-advisory-name",
            text: textOf(node),
            offset: node.start,
          });
          return "skip-children";
        }
      }
    }
    const literal =
      (node.type === "Literal" && typeof node.value === "string") ||
      node.type === "TemplateLiteral";
    let text: string | undefined;
    if (node.type === "TemplateLiteral") {
      // Each substitution reads as a placeholder between the static parts.
      text = templateText(node).join(` \${expression} `);
    } else if (node.type === "BinaryExpression" || literal) {
      text = staticText(node);
    }
    if (text === undefined) {
      return undefined;
    }
    for (const match of sqlLocks(
      text,
      isSqlFragmentContext({ ancestors, source, text }) ? "sql" : "unknown",
    )) {
      add({
        primitive: match[0].toLowerCase().replace(/\s+/gu, " "),
        text: textOf(node),
        offset: node.start,
      });
    }
    addFragmentedSites(node, ancestors, text);
    // A template's substitutions are read on their own; a concatenation of
    // static text has nothing left to read.
    return node.type === "TemplateLiteral" ? undefined : "skip-children";
  });
  return sites;
};
export const aggregateLockBaseline = (
  sites: readonly AggregateLockSite[],
): AggregateLockBaselineRow[] => {
  const rows = new Map<string, AggregateLockBaselineRow>();
  for (const site of sites) {
    const key = `${site.file}:${site.fingerprint}`;
    const existing = rows.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const reason =
      site.primitive === "transaction-boundary"
        ? "Existing transaction runner or savepoint; migrate nested boundaries through the aggregate owner."
        : /^(?:savepoint|release|rollback)\b/iu.test(site.primitive)
          ? "Existing SQL savepoint coordination; migrate through the aggregate owner to retain parent lock history."
          : /pg_(?:try_)?advisory_(?:lock|unlock)/iu.test(site.primitive)
            ? "Existing session coordination remains with its connection owner."
            : /entity-cap-lock|lock-for-write|flow-executor|write-file-version/iu.test(
                  site.file,
                )
              ? "Existing acquisition sequence; migrate together with its aggregate order."
              : /document-processing|ocr/iu.test(site.file)
                ? "Existing document processing coordination; retain until its acquisition order is migrated."
                : /migration|schema-lane/iu.test(site.file)
                  ? "Existing schema coordination remains with its deployment owner."
                  : /maintenance|load-gate/iu.test(site.file)
                    ? "Existing session coordination remains with its connection owner."
                    : "Existing transaction coordination; migrate this acquisition through the aggregate owner.";
    rows.set(key, {
      file: site.file,
      fingerprint: site.fingerprint,
      count: 1,
      reason: `${site.primitive} in ${site.file}: ${reason}`,
    });
  }
  return [...rows.values()].toSorted((a, b) =>
    `${a.file}:${a.fingerprint}`.localeCompare(`${b.file}:${b.fingerprint}`),
  );
};
/**
 * A reviewed replacement of one existing baseline row by a changed acquisition
 * (same lock, edited SQL or moved file). It never admits an additional
 * acquisition: the replaced row must exist in the merge base and be gone now,
 * and the new count may not exceed the replaced one.
 */
export type AggregateLockRekey = {
  file: string;
  from: string;
  to: string;
  fromFile?: string | undefined;
  reason: string;
};
type AggregateLockBaselineOptions = {
  actual: readonly AggregateLockBaselineRow[];
  baseline: readonly AggregateLockBaselineRow[];
  previous?: readonly AggregateLockBaselineRow[];
  rekeys?: readonly AggregateLockRekey[];
};
export const aggregateLockBaselineProblems = ({
  actual,
  baseline,
  previous,
  rekeys = [],
}: AggregateLockBaselineOptions) => {
  const problems: string[] = [];
  const keyed = (rows: readonly AggregateLockBaselineRow[]) =>
    new Map(rows.map((row) => [`${row.file}:${row.fingerprint}`, row]));
  const accepted = keyed(baseline);
  const observed = keyed(actual);
  if (accepted.size !== baseline.length) {
    problems.push("Duplicate aggregate lock baseline row");
  }
  for (const [key, row] of accepted) {
    if (!row.reason.trim() || !Number.isInteger(row.count) || row.count < 1) {
      problems.push(`Invalid aggregate lock baseline row: ${key}`);
    }
    if (observed.get(key)?.count !== row.count) {
      problems.push(`Stale aggregate lock baseline row: ${key}`);
    }
  }
  for (const [key, row] of observed) {
    if (accepted.get(key)?.count !== row.count) {
      problems.push(`Unowned aggregate lock: ${key}`);
    }
  }
  if (previous) {
    const old = keyed(previous);
    const usedSources = new Set<string>();
    const replaces = (key: string, row: AggregateLockBaselineRow) =>
      rekeys.some((rekey) => {
        const source = `${rekey.fromFile ?? rekey.file}:${rekey.from}`;
        const replaced = old.get(source);
        if (
          `${rekey.file}:${rekey.to}` !== key ||
          !rekey.reason.trim() ||
          replaced === undefined ||
          accepted.has(source) ||
          usedSources.has(source) ||
          row.count > replaced.count
        ) {
          return false;
        }
        usedSources.add(source);
        return true;
      });
    for (const [key, row] of accepted) {
      const grew = !old.has(key) || row.count > (old.get(key)?.count ?? 0);
      if (grew && !replaces(key, row)) {
        problems.push(`Aggregate lock baseline may only shrink: ${key}`);
      }
    }
  }
  return problems;
};
