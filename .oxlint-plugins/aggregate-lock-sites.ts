import ts from "typescript";

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

const sqlLocks = (text: string) => {
  const masked = text.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:(?:'')|[^'])*'|"(?:(?:"")|[^"])*"/gu,
    (part) =>
      /^"pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?"$/iu.test(
        part,
      )
        ? part.replaceAll('"', " ")
        : part.replace(/[^\n]/gu, " "),
  );
  const matches = [
    ...masked.matchAll(
      /\bpg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?\s*\(|\bLOCK\s+TABLE\b|\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/giu,
    ),
  ];
  return matches.filter((match) => {
    if (!/^FOR\s+UPDATE$/iu.test(match[0])) {
      return true;
    }
    const start = masked.lastIndexOf(";", match.index) + 1;
    return !/\bCREATE\s+POLICY\b/iu.test(masked.slice(start, match.index));
  });
};
const fingerprint = (primitive: string, text: string) =>
  sha256Hex(`${primitive}:${text.replace(/\s+/gu, " ").trim()}`);
const staticText = (node: ts.Expression): string | undefined => {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return staticText(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    if (left !== undefined && right !== undefined) {
      return left + right;
    }
  }
  return undefined;
};
type AddAggregateLockSiteOptions = {
  primitive: string;
  text: string;
  offset: number;
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
    for (const match of sqlLocks(source)) {
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
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const method = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isElementAccessExpression(expression)
          ? staticText(expression.argumentExpression)
          : undefined;
      const receiver =
        ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression)
          ? expression.expression.getText(ast)
          : "";
      if (method === "for" && receiver !== "Symbol") {
        add({
          primitive: "builder-for",
          text: node.getText(ast),
          offset: node.getStart(ast),
        });
      }
    }
    if (ts.isBinaryExpression(node)) {
      const text = staticText(node);
      if (text !== undefined) {
        for (const match of sqlLocks(text)) {
          add({
            primitive: match[0].toLowerCase().replace(/\s+/gu, " "),
            text: node.getText(ast),
            offset: node.getStart(ast),
          });
        }
        return;
      }
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node)
        ? node.head.text +
          node.templateSpans
            .map((span) => ` \${expression} ${span.literal.text}`)
            .join("")
        : node.text;
      for (const match of sqlLocks(text)) {
        add({
          primitive: match[0].toLowerCase().replace(/\s+/gu, " "),
          text: node.getText(ast),
          offset: node.getStart(ast),
        });
      }
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) {
          visit(span.expression);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
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
    const reason = /pg_(?:try_)?advisory_(?:lock|unlock)/iu.test(site.primitive)
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
type AggregateLockBaselineOptions = {
  actual: readonly AggregateLockBaselineRow[];
  baseline: readonly AggregateLockBaselineRow[];
  previous?: readonly AggregateLockBaselineRow[];
};
export const aggregateLockBaselineProblems = ({
  actual,
  baseline,
  previous,
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
    for (const [key, row] of accepted) {
      if (!old.has(key) || row.count > (old.get(key)?.count ?? 0)) {
        problems.push(`Aggregate lock baseline may only shrink: ${key}`);
      }
    }
  }
  return problems;
};
