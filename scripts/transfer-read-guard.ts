import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { BASELINE_PATHS } from "./baseline-paths.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LEDGER_REL = BASELINE_PATHS.transferRead;
const BOUNDED_OWNER = "apps/api/src/lib/db/read-bounded.ts";

type FindingKind =
  | "numeric-timeout"
  | "total-timeout-body"
  | "constant-limit"
  | "fixed-page-size";
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

const bindingNames = (name: ts.BindingName): string[] => {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
};

/**
 * Finds a `name` variable declared directly in a block or source file. The
 * wrapper distinguishes "declared without a const initializer" from "absent".
 */
const declarationIn = (
  scope: ts.Node,
  name: string,
): { initializer: ts.Expression | undefined } | undefined => {
  if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) {
    return undefined;
  }
  for (const statement of scope.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return {
          initializer:
            statement.declarationList.getFirstToken()?.kind ===
            ts.SyntaxKind.ConstKeyword
              ? declaration.initializer
              : undefined,
        };
      }
    }
  }
  return undefined;
};

const bindingOf = (from: ts.Node, name: string): ts.Expression | undefined => {
  let scope = from.parent;
  while (!ts.isSourceFile(scope)) {
    if (
      isFunction(scope) &&
      scope.parameters.some((parameter) =>
        bindingNames(parameter.name).includes(name),
      )
    ) {
      return undefined;
    }
    const declared = declarationIn(scope, name);
    if (declared !== undefined) {
      return declared.initializer;
    }
    scope = scope.parent;
  }
  return declarationIn(scope, name)?.initializer;
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

const isOne = (node: ts.Expression): boolean => {
  const value = resolve(node);
  return ts.isNumericLiteral(value) && Number(value.text) === 1;
};

const queryChain = (node: ts.CallExpression): ts.CallExpression[] => {
  let top = node;
  while (
    ts.isPropertyAccessExpression(top.parent) &&
    top.parent.expression === top &&
    ts.isCallExpression(top.parent.parent)
  ) {
    top = top.parent.parent;
  }
  const calls: ts.CallExpression[] = [];
  let current = unwrap(top);
  while (ts.isCallExpression(current)) {
    calls.push(current);
    const expression = unwrap(current.expression);
    if (
      !ts.isPropertyAccessExpression(expression) &&
      !ts.isElementAccessExpression(expression)
    ) {
      break;
    }
    current = unwrap(expression.expression);
  }
  return calls;
};

const containsIdentifier = (node: ts.Node, name: string): boolean => {
  if (ts.isIdentifier(node) && node.text === name) {
    return true;
  }
  return (
    ts.forEachChild(
      node,
      (child) => containsIdentifier(child, name) || undefined,
    ) === true
  );
};

const sameExpression = (left: ts.Expression, right: ts.Expression): boolean =>
  resolve(left).getText().replace(/\s/gu, "") ===
  resolve(right).getText().replace(/\s/gu, "");

type ImportedCallOptions = {
  call: ts.CallExpression;
  module: string;
  name: string;
};

const callsImported = ({
  call,
  module,
  name,
}: ImportedCallOptions): boolean => {
  const expression = unwrap(call.expression);
  if (!ts.isIdentifier(expression)) {
    return false;
  }
  const source = call.getSourceFile();
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          element.name.text === expression.text &&
          (element.propertyName?.text ?? element.name.text) === name,
      )
    );
  });
};

type SentinelBoundaryOptions = {
  cap: ts.Expression;
  boundary: ts.Expression;
};

const matchesSentinelBoundary = ({
  cap,
  boundary,
}: SentinelBoundaryOptions): boolean => {
  const value = resolve(cap);
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    isOne(value.right)
  ) {
    return sameExpression(boundary, value.left);
  }
  const compared = resolve(boundary);
  return (
    ts.isNumericLiteral(value) &&
    ts.isNumericLiteral(compared) &&
    Number(value.text) > 1 &&
    Number(value.text) === Number(compared.text) + 1
  );
};

const queryResultBinding = (node: ts.CallExpression) => {
  const declaration = ts.findAncestor(node, ts.isVariableDeclaration);
  if (declaration === undefined || !ts.isIdentifier(declaration.name)) {
    return undefined;
  }
  if (
    !ts.isVariableDeclarationList(declaration.parent) ||
    declaration.parent.declarations.length !== 1
  ) {
    return undefined;
  }
  const chain = new Set(queryChain(node));
  let ancestor = node.parent;
  while (ancestor !== declaration) {
    if (
      ts.isCallExpression(ancestor) &&
      !chain.has(ancestor) &&
      !["scopedDb", "safeDb", "await", "tryPromise"].includes(
        callName(ancestor.expression) ?? "",
      )
    ) {
      return undefined;
    }
    ancestor = ancestor.parent;
  }
  const statement = ts.findAncestor(declaration, ts.isVariableStatement);
  if (statement === undefined || !ts.isBlock(statement.parent)) {
    return undefined;
  }
  const nextIndex = statement.parent.statements.indexOf(statement) + 1;
  const following = statement.parent.statements.at(nextIndex);
  if (following === undefined) {
    return undefined;
  }
  return {
    rowName: declaration.name.text,
    following,
    rest: statement.parent.statements.slice(nextIndex + 1),
  };
};

const objectOption = (
  options: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined => {
  const property = options.properties.find(
    (candidate) =>
      (ts.isPropertyAssignment(candidate) ||
        ts.isShorthandPropertyAssignment(candidate)) &&
      propertyName(candidate.name) === name,
  );
  if (property === undefined) {
    return undefined;
  }
  if (ts.isPropertyAssignment(property)) {
    return unwrap(property.initializer);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name;
  }
  return undefined;
};

type CursorPageConsumptionOptions = {
  following: ts.Statement;
  rest: readonly ts.Statement[];
  rowName: string;
  cap: ts.Expression;
};

const consumesCursorPage = ({
  following,
  rest,
  rowName,
  cap,
}: CursorPageConsumptionOptions): boolean => {
  if (
    !ts.isVariableStatement(following) ||
    following.declarationList.declarations.length !== 1
  ) {
    return false;
  }
  const page = following.declarationList.declarations.at(0);
  if (
    page === undefined ||
    !ts.isIdentifier(page.name) ||
    page.initializer === undefined
  ) {
    return false;
  }
  const call = unwrap(page.initializer);
  if (
    !ts.isCallExpression(call) ||
    !callsImported({
      call,
      module: "@/api/lib/pagination",
      name: "createCursorPage",
    })
  ) {
    return false;
  }
  const options = call.arguments.at(0);
  if (options === undefined || !ts.isObjectLiteralExpression(options)) {
    return false;
  }
  const rows = objectOption(options, "rows");
  const limit = objectOption(options, "limit");
  if (
    rows === undefined ||
    !ts.isIdentifier(rows) ||
    rows.text !== rowName ||
    limit === undefined ||
    !matchesSentinelBoundary({ cap, boundary: limit })
  ) {
    return false;
  }
  if (rest.some((item) => containsIdentifier(item, rowName))) {
    return false;
  }
  return rest.some(
    (item) =>
      ts.isReturnStatement(item) &&
      containsIdentifier(item, page.name.getText()),
  );
};

type OverflowExitOptions = {
  following: ts.Statement;
  rowName: string;
  cap: ts.Expression;
};

const exitsOnOverflow = ({
  following,
  rowName,
  cap,
}: OverflowExitOptions): boolean => {
  if (!ts.isIfStatement(following)) {
    return false;
  }
  const condition = unwrap(following.expression);
  if (
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.GreaterThanToken
  ) {
    return false;
  }
  const length = unwrap(condition.left);
  if (
    !ts.isPropertyAccessExpression(length) ||
    length.name.text !== "length" ||
    !ts.isIdentifier(length.expression) ||
    length.expression.text !== rowName ||
    !matchesSentinelBoundary({ cap, boundary: condition.right })
  ) {
    return false;
  }
  const branch = following.thenStatement;
  const exit = ts.isBlock(branch) ? branch.statements.at(-1) : branch;
  if (exit === undefined || containsIdentifier(branch, rowName)) {
    return false;
  }
  if (ts.isReturnStatement(exit) || ts.isThrowStatement(exit)) {
    return true;
  }
  return (
    ts.isExpressionStatement(exit) &&
    ts.isCallExpression(exit.expression) &&
    callsImported({
      call: exit.expression,
      module: "better-result",
      name: "panic",
    })
  );
};

// A sentinel is safe only when its own result is checked against its own cap,
// before subsequent consumers, and the overflow branch exits without rows.
const rejectsOverflow = (
  node: ts.CallExpression,
  cap: ts.Expression,
): boolean => {
  const binding = queryResultBinding(node);
  if (binding === undefined) {
    return false;
  }
  return (
    consumesCursorPage({ ...binding, cap }) ||
    exitsOnOverflow({
      following: binding.following,
      rowName: binding.rowName,
      cap,
    })
  );
};

const paginationNames = (root: ts.Node): Set<string> =>
  new Set(
    isFunction(root)
      ? root.parameters.flatMap((parameter) => bindingNames(parameter.name))
      : [],
  );

const PAGINATION_INPUT =
  /^(?:cursor|page|offset|pageIndex|pageNumber|after|before)$/u;
type PaginationReferenceOptions = {
  node: ts.Node;
  inputs: ReadonlySet<string>;
  depth?: number;
};

const referencesPagination = ({
  node,
  inputs,
  depth = 0,
}: PaginationReferenceOptions): boolean => {
  if (depth >= 8) {
    return false;
  }
  if (ts.isIdentifier(node)) {
    if (
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.name === node
    ) {
      return false;
    }
    if (inputs.has(node.text) && PAGINATION_INPUT.test(node.text)) {
      return true;
    }
    const bound = bindingOf(node, node.text);
    if (
      bound !== undefined &&
      referencesPagination({ node: bound, inputs, depth: depth + 1 })
    ) {
      return true;
    }
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    PAGINATION_INPUT.test(node.name.text) &&
    ts.isIdentifier(node.expression) &&
    inputs.has(node.expression.text)
  ) {
    return true;
  }
  return (
    ts.forEachChild(
      node,
      (child) =>
        referencesPagination({ node: child, inputs, depth: depth + 1 }) ||
        undefined,
    ) === true
  );
};

type LimitDispositionOptions = {
  node: ts.CallExpression;
  cap: ts.Expression;
  root: ts.Node;
};

const limitDisposition = ({
  node,
  cap,
  root,
}: LimitDispositionOptions):
  | "exempt"
  | "fixed-page-size"
  | "constant-limit" => {
  if (isOne(cap) || rejectsOverflow(node, cap)) {
    return "exempt";
  }
  const chain = queryChain(node);
  const inputs = paginationNames(root);
  if (
    chain.some(
      (call) =>
        callName(call.expression) === "offset" &&
        call.arguments.some((argument) =>
          referencesPagination({ node: argument, inputs }),
        ),
    )
  ) {
    return "exempt";
  }
  if (
    chain.some(
      (call) =>
        callName(call.expression) === "where" &&
        call.arguments.some((argument) =>
          referencesPagination({ node: argument, inputs }),
        ),
    )
  ) {
    return "exempt";
  }
  if (
    referencesPagination({ node: root, inputs }) ||
    /(?:PAGE_SIZE|pageSize|pageLimit)/u.test(cap.getText())
  ) {
    return "fixed-page-size";
  }
  return "constant-limit";
};

const isPredicateSubquery = (
  node: ts.CallExpression,
  predicates: ReadonlyMap<string, number>,
) => {
  const parent = node.parent;
  if (!ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) {
    return false;
  }
  const name = parent.expression.text;
  const argument = predicates.get(name);
  if (argument === undefined || parent.arguments.at(argument) !== node) {
    return false;
  }
  let scope = parent.parent;
  while (!ts.isSourceFile(scope)) {
    if (
      declarationIn(scope, name) !== undefined ||
      (isFunction(scope) &&
        (scope.name?.getText() === name ||
          scope.parameters.some((parameter) =>
            bindingNames(parameter.name).includes(name),
          ))) ||
      (ts.isBlock(scope) &&
        scope.statements.some(
          (statement) =>
            (ts.isFunctionDeclaration(statement) ||
              ts.isClassDeclaration(statement)) &&
            statement.name?.text === name,
        ))
    ) {
      return false;
    }
    scope = scope.parent;
  }
  return true;
};

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
  const subqueryPredicates = new Map<string, number>();
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
        if (
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === "drizzle-orm"
        ) {
          const name = element.propertyName?.text ?? element.name.text;
          switch (name) {
            case "inArray":
            case "notInArray":
              subqueryPredicates.set(element.name.text, 1);
              break;
            case "exists":
            case "notExists":
              subqueryPredicates.set(element.name.text, 0);
              break;
            default:
              break;
          }
        }
      }
    }
  }
  const findings: ReadFinding[] = [];
  const scanScope = (root: ts.Node, name: string) => {
    const totalTimeouts: ts.Node[] = [];
    // A mutable record: `visit` sets this from a closure, which control-flow
    // narrowing of a plain `let` would not see after `visit(root)` returns.
    const body = { read: false };
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
        body.read = true;
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
          body.read = true;
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
          // Predicate subqueries stay in Postgres; their limit does not
          // truncate a collection transferred to the application.
          const disposition = isPredicateSubquery(node, subqueryPredicates)
            ? "exempt"
            : limitDisposition({ node, cap, root });
          if (disposition !== "exempt") {
            record(disposition, node);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    if (
      body.read &&
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
    value.kind === "constant-limit" ||
    value.kind === "fixed-page-size") &&
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

const membershipKey = (
  entry: Pick<BaselineEntry, "file" | "function" | "kind">,
): string =>
  entryKey({
    ...entry,
    kind: entry.kind === "fixed-page-size" ? "constant-limit" : entry.kind,
  });

export const transferMembership = (text: string, label: string): string[] => {
  const counts = new Map<string, number>();
  for (const entry of parseTransferBaseline(text, label)) {
    const key = membershipKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
  return [...counts].flatMap(([key, count]) =>
    Array.from({ length: count }, (_, index) => `${key}::${index}`),
  );
};

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
      if (!/timeoutMs|AbortSignal|\blimit\b/u.test(source)) {
        continue;
      }
      found.push(...findTransferReads(file, source));
    }
  }
  // Code-unit order: keys are repository paths and identifiers, not display text.
  return found.toSorted((a, b) => {
    const left = entryKey(a);
    const right = entryKey(b);
    if (left === right) {
      return a.line - b.line;
    }
    return left < right ? -1 : 1;
  });
};

const DEFAULT_REASON = {
  "numeric-timeout":
    "Existing total timeout; select an explicit header or idle policy at the fetch owner.",
  "total-timeout-body":
    "Existing total timeout; select an explicit header or idle policy at the fetch owner.",
  "constant-limit":
    "Existing fixed read budget; migrate unbounded decisions and exports to readBounded or document the pagination/table-cap contract.",
  "fixed-page-size":
    "Existing fixed page budget; prove the cursor/page input reaches this read before treating its rows as a complete result.",
} as const satisfies Record<FindingKind, string>;

const writeBaseline = async () => {
  const baselineFile = Bun.file(path.join(REPO_ROOT, LEDGER_REL));
  const baseline = (await baselineFile.exists())
    ? parseTransferBaseline(await baselineFile.text(), LEDGER_REL)
    : undefined;
  const entries = new Map<string, BaselineEntry>();
  for (const finding of await scanTransferTree()) {
    const key = entryKey(finding);
    const existing = entries.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    const previous = baseline?.find(
      (entry) =>
        entryKey(entry) === key ||
        membershipKey(entry) === membershipKey(finding),
    );
    const reason =
      (finding.kind === "fixed-page-size" && previous?.kind === "constant-limit"
        ? undefined
        : previous?.reason) ?? DEFAULT_REASON[finding.kind];
    entries.set(key, {
      file: finding.file,
      function: finding.function,
      kind: finding.kind,
      count: 1,
      reason,
    });
  }
  if (baseline !== undefined) {
    const before = new Set(
      transferMembership(JSON.stringify(baseline), LEDGER_REL),
    );
    const added = transferMembership(
      JSON.stringify([...entries.values()]),
      LEDGER_REL,
    ).filter((entry) => !before.has(entry));
    if (added.length > 0) {
      panic(`Cannot grow the transfer/read baseline: ${added.join(", ")}`);
    }
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
