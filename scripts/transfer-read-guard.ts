import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { BASELINE_PATHS } from "./baseline-paths.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LEDGER_REL = BASELINE_PATHS.transferRead;
const BOUNDED_OWNER = "apps/api/src/lib/db/read-bounded.ts";

type FindingKind = "numeric-timeout" | "total-timeout-body" | "constant-limit";
export type ReadFinding = {
  file: string;
  function: string;
  kind: FindingKind;
  line: number;
};
type BaselineEntry = {
  file: string;
  function: string;
  kind: FindingKind;
  count: number;
  reason: string;
};

const unwrap = (node: ts.Expression): ts.Expression => {
  let value = node;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isTypeAssertionExpression(value)
  ) {
    value = value.expression;
  }
  return value;
};

const propertyName = (node: ts.PropertyName): string | undefined => {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    const value = unwrap(node.expression);
    if (ts.isStringLiteral(value)) {
      return value.text;
    }
  }
  return undefined;
};

const callName = (node: ts.Expression): string | undefined => {
  const value = unwrap(node);
  if (ts.isIdentifier(value)) {
    return value.text;
  }
  if (ts.isPropertyAccessExpression(value)) {
    return value.name.text;
  }
  if (
    ts.isElementAccessExpression(value) &&
    ts.isStringLiteral(value.argumentExpression)
  ) {
    return value.argumentExpression.text;
  }
  return undefined;
};

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const bindingOf = (from: ts.Node, name: string): ts.Expression | undefined => {
  let scope: ts.Node | undefined = from.parent;
  while (scope !== undefined) {
    if (
      isFunction(scope) &&
      scope.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === name,
      )
    ) {
      return undefined;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) {
          continue;
        }
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name
          ) {
            return statement.declarationList.getFirstToken()?.kind ===
              ts.SyntaxKind.ConstKeyword
              ? declaration.initializer
              : undefined;
          }
        }
      }
    }
    scope = scope.parent;
  }
  return undefined;
};

const resolve = (node: ts.Expression, depth = 0): ts.Expression => {
  const value = unwrap(node);
  if (!ts.isIdentifier(value) || depth >= 8) {
    return value;
  }
  const bound = bindingOf(value, value.text);
  return bound === undefined ? value : resolve(bound, depth + 1);
};

const timeoutProperties = (node: ts.Expression, depth = 0): ts.Node[] => {
  if (depth >= 8) {
    return [];
  }
  const value = resolve(node);
  if (!ts.isObjectLiteralExpression(value)) {
    return [];
  }
  const found: ts.Node[] = [];
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      found.push(...timeoutProperties(property.expression, depth + 1));
    } else if (
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property.name) === "timeoutMs"
    ) {
      found.push(property);
    }
  }
  return found;
};

// Callback identities follow their enclosing declaration and call position,
// rather than source locations, so moving code does not reset the budget.
const scopeName = (node: ts.FunctionLikeDeclaration): string => {
  if (node.name !== undefined) {
    return node.name.getText();
  }
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  ) {
    parent = parent.parent;
  }
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
    return parent.name.getText();
  }
  if (ts.isCallExpression(parent)) {
    const index = parent.arguments.findIndex(
      (arg) => arg === node || (ts.isExpression(arg) && unwrap(arg) === node),
    );
    const declaration = ts.findAncestor(
      parent,
      (ancestor) => ts.isVariableDeclaration(ancestor) || isFunction(ancestor),
    );
    const prefix =
      declaration !== undefined && ts.isVariableDeclaration(declaration)
        ? `${declaration.name.getText()}/`
        : "";
    return `${prefix}${callName(parent.expression) ?? "call"}[${index}]`;
  }
  return "callback";
};

const isConstant = (node: ts.Expression, depth = 0): boolean => {
  if (depth >= 8) {
    return true;
  }
  const value = resolve(node);
  if (ts.isNumericLiteral(value)) {
    return true;
  }
  if (ts.isIdentifier(value)) {
    return /^[A-Z][A-Z_\d]*$/u.test(value.text);
  }
  if (ts.isPropertyAccessExpression(value)) {
    const root = value.expression;
    return ts.isIdentifier(root) && /^[A-Z][A-Z_\d]*$/u.test(root.text);
  }
  if (ts.isElementAccessExpression(value)) {
    return (
      ts.isIdentifier(value.expression) &&
      /^[A-Z][A-Z_\d]*$/u.test(value.expression.text)
    );
  }
  if (ts.isBinaryExpression(value)) {
    return (
      isConstant(value.left, depth + 1) && isConstant(value.right, depth + 1)
    );
  }
  return (
    ts.isPrefixUnaryExpression(value) && isConstant(value.operand, depth + 1)
  );
};

const isBodyAccess = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) && node.name.text === "body") ||
  (ts.isElementAccessExpression(node) &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "body");

/** Conservative syntax census: JSON/text may also carry user-sized content.
 * Existing bounded metadata and paginated reads retain explicit baseline reasons. */
export const findTransferReads = (
  file: string,
  source: string,
): ReadFinding[] => {
  if (
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.includes("/tests/")
  ) {
    return [];
  }
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imported = new Map<string, string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imported.set(
          element.name.text,
          element.propertyName?.text ?? element.name.text,
        );
      }
    }
  }
  const findings: ReadFinding[] = [];
  const scanScope = (root: ts.Node, name: string) => {
    const totalTimeouts: ts.Node[] = [];
    let readsBody = false;
    const record = (kind: FindingKind, node: ts.Node) =>
      findings.push({
        file,
        function: name,
        kind,
        line:
          parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      });
    const visit = (node: ts.Node) => {
      if (
        node !== root &&
        isFunction(node) &&
        (ts.isSourceFile(root) ||
          node.name !== undefined ||
          ts.isVariableDeclaration(node.parent))
      ) {
        scanScope(node, `${name}/${scopeName(node)}`);
        return;
      }
      if (isBodyAccess(node)) {
        readsBody = true;
      }
      if (ts.isCallExpression(node)) {
        const resolvedCall = resolve(node.expression);
        const named = callName(
          ts.isCallExpression(resolvedCall)
            ? resolvedCall.expression
            : resolvedCall,
        );
        const called =
          named === undefined ? undefined : (imported.get(named) ?? named);
        if (
          called !== undefined &&
          [
            "arrayBuffer",
            "blob",
            "text",
            "json",
            "pipeTo",
            "pipeThrough",
            "getReader",
          ].includes(called)
        ) {
          readsBody = true;
        }
        if (
          called === "timeout" &&
          (ts.isPropertyAccessExpression(resolvedCall) ||
            ts.isElementAccessExpression(resolvedCall)) &&
          resolve(resolvedCall.expression).getText(parsed) === "AbortSignal"
        ) {
          totalTimeouts.push(node);
        }
        if (called !== undefined && /fetch/iu.test(called)) {
          for (const argument of node.arguments) {
            for (const property of timeoutProperties(argument)) {
              record("numeric-timeout", property);
              totalTimeouts.push(property);
            }
          }
        }
        const cap = node.arguments.at(0);
        if (
          file !== BOUNDED_OWNER &&
          /^apps\/api\/src\/(?:handlers|lib)\//u.test(file) &&
          called === "limit" &&
          cap !== undefined &&
          isConstant(cap)
        ) {
          record("constant-limit", node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    if (
      readsBody &&
      !(
        file === "packages/fetch/src/index.ts" &&
        name === "module/executeFetchWithTimeout"
      )
    ) {
      for (const node of totalTimeouts) {
        record("total-timeout-body", node);
      }
    }
  };
  scanScope(parsed, "module");
  return findings;
};

const entryKey = ({
  file,
  function: fn,
  kind,
}: Pick<BaselineEntry, "file" | "function" | "kind">) =>
  `${file}::${fn}::${kind}`;

const isBaselineEntry = (value: unknown): value is BaselineEntry =>
  typeof value === "object" &&
  value !== null &&
  "file" in value &&
  typeof value.file === "string" &&
  "function" in value &&
  typeof value.function === "string" &&
  "kind" in value &&
  (value.kind === "numeric-timeout" ||
    value.kind === "total-timeout-body" ||
    value.kind === "constant-limit") &&
  "count" in value &&
  typeof value.count === "number" &&
  Number.isSafeInteger(value.count) &&
  value.count > 0 &&
  "reason" in value &&
  typeof value.reason === "string" &&
  value.reason.trim().length > 0;

export const parseTransferBaseline = (
  text: string,
  label: string,
): BaselineEntry[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(isBaselineEntry)) {
    return panic(`${label} must contain reasoned transfer/read budgets`);
  }
  if (new Set(parsed.map(entryKey)).size !== parsed.length) {
    return panic(`${label} has duplicate file/function budgets`);
  }
  return parsed;
};

export const transferMembership = (text: string, label: string): string[] =>
  parseTransferBaseline(text, label).flatMap((entry) =>
    Array.from(
      { length: entry.count },
      (_, index) => `${entryKey(entry)}::${index}`,
    ),
  );

export const compareTransferBaseline = (
  found: readonly ReadFinding[],
  baseline: readonly BaselineEntry[],
) => {
  const counts = new Map<string, number>();
  for (const item of found) {
    counts.set(entryKey(item), (counts.get(entryKey(item)) ?? 0) + 1);
  }
  const budgets = new Map(
    baseline.map((entry) => [entryKey(entry), entry.count]),
  );
  return {
    unlisted: found.filter(
      (item) =>
        (counts.get(entryKey(item)) ?? 0) > (budgets.get(entryKey(item)) ?? 0),
    ),
    stale: baseline.filter(
      (item) => (counts.get(entryKey(item)) ?? 0) < item.count,
    ),
  };
};

export const scanTransferTree = async (): Promise<ReadFinding[]> => {
  const found: ReadFinding[] = [];
  for (const pattern of [
    "apps/**/src/**/*.{ts,tsx}",
    "packages/**/src/**/*.{ts,tsx}",
  ]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT })) {
      if (file.includes("/node_modules/") || file.endsWith(".d.ts")) {
        continue;
      }
      const source = await Bun.file(path.join(REPO_ROOT, file)).text();
      if (!/timeoutMs|AbortSignal|\.limit\s*\(/u.test(source)) {
        continue;
      }
      found.push(...findTransferReads(file, source));
    }
  }
  return found.toSorted(
    (a, b) => entryKey(a).localeCompare(entryKey(b)) || a.line - b.line,
  );
};

const writeBaseline = async () => {
  const entries = new Map<string, BaselineEntry>();
  for (const finding of await scanTransferTree()) {
    const key = entryKey(finding);
    const existing = entries.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    const reason =
      finding.kind === "constant-limit"
        ? "Existing fixed read budget; migrate unbounded decisions and exports to readBounded or document the pagination/table-cap contract."
        : "Existing total timeout; select an explicit header or idle policy at the fetch owner.";
    entries.set(key, {
      file: finding.file,
      function: finding.function,
      kind: finding.kind,
      count: 1,
      reason,
    });
  }
  writeFileSync(
    path.join(REPO_ROOT, LEDGER_REL),
    `${JSON.stringify([...entries.values()], null, 2)}\n`,
  );
};

const check = async () => {
  const baseline = parseTransferBaseline(
    readFileSync(path.join(REPO_ROOT, LEDGER_REL), "utf-8"),
    LEDGER_REL,
  );
  const { unlisted, stale } = compareTransferBaseline(
    await scanTransferTree(),
    baseline,
  );
  for (const item of unlisted) {
    console.error(
      `${item.file}:${item.line}: ${item.kind} in ${item.function}; use an explicit transfer policy or readBounded.`,
    );
  }
  for (const item of stale) {
    console.error(
      `${entryKey(item)}: lower or remove the stale baseline budget.`,
    );
  }
  // Reuse the shared shrink-only membership guard, expanding counts so an
  // existing function cannot hide a second unsafe read by raising its budget.
  const membership = runLedgerMembershipGuard({
    ledgerRel: LEDGER_REL,
    repoRoot: REPO_ROOT,
    parseLedger: transferMembership,
    label: "transfer-read",
    remediation: "use the owning helper rather than increasing a budget",
  });
  if (unlisted.length || stale.length) {
    return 1;
  }
  return membership;
};

if (import.meta.main) {
  if (process.argv.includes("--write")) {
    await writeBaseline();
  } else {
    process.exit(await check());
  }
}
