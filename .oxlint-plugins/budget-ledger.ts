// Per-site budgets for a lint plugin whose existing hits are listed in a
// shrink-only ledger (scripts/<plugin>-ledger.json). A row's id is
// `rule::file::enclosing function::spelling` with a count and a reason; no
// line numbers, so unrelated edits do not move a key. A hit beyond a budget is
// reported, and so is a budget the file no longer reaches.

import { panic } from "better-result";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import {
  isAstNode,
  isIdentifier,
  memberPropertyName,
  unwrapExpression,
  type AstNode,
} from "./utils.ts";

type LedgerRow = { id: string; count: number; reason: string };
type Budget = Map<string, number>;
type Report = { messageId: string; data: Record<string, string> };

export const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const functionName = (node: AstNode): string | null => {
  if (node.type === "FunctionDeclaration" && isIdentifier(node.id)) {
    return node.id.name;
  }
  const parent = isAstNode(node.parent) ? node.parent : null;
  if (parent === null) {
    return null;
  }
  if (parent.type === "VariableDeclarator" && isIdentifier(parent.id)) {
    return parent.id.name;
  }
  if (
    (parent.type === "Property" ||
      parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition") &&
    parent.computed !== true &&
    isIdentifier(parent.key)
  ) {
    return parent.key.name;
  }
  if (parent.type === "AssignmentExpression") {
    const left = unwrapExpression(parent.left);
    if (isIdentifier(left)) {
      return left.name;
    }
    if (left?.type === "MemberExpression") {
      return memberPropertyName(left);
    }
  }
  return null;
};

/** The nearest named enclosing function, or `<module>`. */
export const enclosingScopeName = (node: AstNode): string => {
  let current: unknown = node.parent;
  while (isAstNode(current)) {
    if (FUNCTION_TYPES.has(current.type)) {
      const name = functionName(current);
      if (name !== null) {
        return name;
      }
    }
    current = current.parent;
  }
  return "<module>";
};

/** rule -> file -> "scope::pattern" -> count, from validated ledger rows. */
const parseBudgets = (
  ledgerPath: string,
  rows: readonly LedgerRow[],
): Map<string, Map<string, Budget>> => {
  const budgets = new Map<string, Map<string, Budget>>();
  for (const [index, row] of rows.entries()) {
    const previous = index === 0 ? undefined : rows.at(index - 1);
    if (
      row.reason.trim().length < 12 ||
      !Number.isInteger(row.count) ||
      row.count < 1 ||
      (previous !== undefined && previous.id >= row.id)
    ) {
      panic(
        `${ledgerPath} must be sorted, duplicate-free, with a positive count and a reason per row (${row.id})`,
      );
    }
    const [rule, file, scope, pattern, ...rest] = row.id.split("::");
    if (
      rule === undefined ||
      file === undefined ||
      scope === undefined ||
      pattern === undefined ||
      rest.length > 0
    ) {
      panic(`${ledgerPath}: malformed id ${row.id}`);
    }
    const byFile = budgets.get(rule) ?? new Map<string, Budget>();
    const budget = byFile.get(file) ?? new Map<string, number>();
    budget.set(`${scope}::${pattern}`, row.count);
    byFile.set(file, budget);
    budgets.set(rule, byFile);
  }
  return budgets;
};

type BudgetLedger = {
  /** Tallies a rule's hits per scope and spelling against a file's budget. */
  tracker: (rule: string) => BudgetTracker;
  /** The `stale` message, naming the ledger file. */
  staleMessage: string;
};

export type BudgetTracker = {
  reset: (filename: string) => void;
  /** The report for a hit beyond the budget, or null within it. */
  record: (node: unknown, pattern: string, messageId: string) => Report | null;
  /** One report per budget the file no longer reaches. */
  stale: () => Report[];
};

export const createBudgetLedger = (
  ledgerPath: string,
  rows: readonly LedgerRow[],
): BudgetLedger => {
  const budgets = parseBudgets(ledgerPath, rows);
  const tracker = (rule: string): BudgetTracker => {
    let file = "";
    let budget: Budget = new Map();
    const seen = new Map<string, number>();
    return {
      reset(filename) {
        file = "";
        budget = new Map();
        seen.clear();
        for (const [entryFile, entries] of budgets.get(rule) ?? []) {
          if (filename === entryFile || filename.endsWith(`/${entryFile}`)) {
            file = entryFile;
            budget = entries;
            break;
          }
        }
        if (file === "") {
          // oxlint runs from the repository root, so the ledger key of a file
          // without a budget is its path relative to the working directory.
          file = path.isAbsolute(filename)
            ? repoRelativePath(process.cwd(), filename)
            : filename;
        }
      },
      record(node, pattern, messageId) {
        const scope = isAstNode(node) ? enclosingScopeName(node) : "<module>";
        const key = `${scope}::${pattern}`;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count <= (budget.get(key) ?? 0)) {
          return null;
        }
        return {
          messageId,
          data: { pattern, key: `${rule}::${file}::${key}` },
        };
      },
      stale() {
        return [...budget]
          .filter(([key, count]) => (seen.get(key) ?? 0) < count)
          .map(([key, count]) => ({
            messageId: "stale",
            data: {
              entry: `${rule}::${file}::${key}`,
              count: String(count),
              found: String(seen.get(key) ?? 0),
            },
          }));
      },
    };
  };
  return {
    tracker,
    staleMessage: `Lower {{entry}} in ${ledgerPath} from {{count}} to {{found}} (remove the row at 0): the ledger only shrinks.`,
  };
};
