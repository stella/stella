import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SOURCE_ROOTS = [
  "apps/api/src/handlers/time-entries/",
  "apps/api/src/handlers/time-timers/",
  "apps/api/src/lib/billing/",
];
const SOURCE_FILES = new Set(["apps/api/src/lib/time-entry-offboarding.ts"]);
const POLICY_OWNER = "@/api/lib/billing-time";
const MUTATIONS = new Set(["insert", "update", "delete"]);

export type TimeEntryPolicyFinding = {
  file: string;
  line: number;
  operation: string;
};

export const isTimeEntryPolicySource = (file: string): boolean =>
  (SOURCE_FILES.has(file) ||
    SOURCE_ROOTS.some((root) => file.startsWith(root))) &&
  file.endsWith(".ts") &&
  !/\.(?:test|spec|d)\.ts$/u.test(file);

type FunctionScope =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration;
const isFunctionScope = (node: ts.Node): node is FunctionScope =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node);

const enclosingFunction = (node: ts.Node): FunctionScope | undefined => {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionScope(current)) {
      return current;
    }
  }
  return undefined;
};

const enclosingBlocks = (node: ts.Node, scope: FunctionScope): Set<ts.Node> => {
  const blocks = new Set<ts.Node>();
  for (
    let current = node.parent;
    current && current !== scope;
    current = current.parent
  ) {
    if (ts.isBlock(current)) {
      blocks.add(current);
    }
  }
  return blocks;
};

const sqlCode = (source: string): string => {
  let mode: "code" | "string" | "lineComment" | "blockComment" = "code";
  const output: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index);
    const next = source.charAt(index + 1);
    if (mode === "string") {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        mode = "code";
      }
      output.push(" ");
      continue;
    }
    if (mode === "lineComment") {
      if (character === "\n") {
        mode = "code";
      }
      output.push(" ");
      continue;
    }
    if (mode === "blockComment") {
      if (character === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      output.push(" ");
      continue;
    }
    if (character === "'") {
      mode = "string";
    } else if (character === "-" && next === "-") {
      mode = "lineComment";
      index += 1;
    } else if (character === "/" && next === "*") {
      mode = "blockComment";
      index += 1;
    }
    output.push(mode === "code" ? character : " ");
  }
  return output.join("");
};

const createTableResolver = (
  parsed: ts.SourceFile,
  tableNames: Set<string>,
) => {
  const variables = new Map<string, ts.VariableDeclaration[]>();
  const collectVariables = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const declarations = variables.get(node.name.text) ?? [];
      declarations.push(node);
      variables.set(node.name.text, declarations);
    }
    ts.forEachChild(node, collectVariables);
  };
  collectVariables(parsed);
  const aliasInitializer = (node: ts.Identifier): ts.Expression | undefined => {
    const ancestors = new Set<ts.Node>();
    for (let current = node.parent; current; current = current.parent) {
      ancestors.add(current);
    }
    return variables
      .get(node.text)
      ?.findLast(
        (declaration) =>
          declaration.end <= node.getStart(parsed) &&
          ancestors.has(declaration.parent.parent.parent),
      )?.initializer;
  };
  const isTable = (node: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === "timeEntries";
    }
    if (!ts.isIdentifier(node) || seen.has(node)) {
      return false;
    }
    const initializer = aliasInitializer(node);
    return initializer
      ? isTable(initializer, new Set([...seen, node]))
      : tableNames.has(node.text);
  };

  const sqlText = (
    node: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string | undefined => {
    if (seen.has(node)) {
      return undefined;
    }
    const visited = new Set([...seen, node]);
    if (ts.isIdentifier(node)) {
      const initializer = aliasInitializer(node);
      return initializer ? sqlText(initializer, visited) : undefined;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      return sqlText(node.template, visited);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "raw"
    ) {
      const argument = node.arguments.at(0);
      return argument ? sqlText(argument, visited) : undefined;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text];
      for (const span of node.templateSpans) {
        parts.push(
          isTable(span.expression) ? "time_entries" : "__expression__",
          span.literal.text,
        );
      }
      return parts.join("");
    }
    return undefined;
  };

  return { isTable, sqlText };
};

export const findTimeEntryPolicyLocks = (
  file: string,
  source: string,
): TimeEntryPolicyFinding[] => {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lockNames = new Set<string>();
  const proofNames = new Set<string>();
  const tableNames = new Set(["timeEntries"]);
  const types = new Map<string, ts.TypeNode>();
  for (const statement of parsed.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      types.set(statement.name.text, statement.type);
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const binding of bindings.elements) {
      const imported = binding.propertyName?.text ?? binding.name.text;
      if (imported === "timeEntries") {
        tableNames.add(binding.name.text);
      }
      if (statement.moduleSpecifier.text !== POLICY_OWNER) {
        continue;
      }
      if (
        imported === "lockTimePolicy" &&
        !binding.isTypeOnly &&
        !statement.importClause?.isTypeOnly
      ) {
        lockNames.add(binding.name.text);
      }
      if (imported === "LockedTimePolicy") {
        proofNames.add(binding.name.text);
      }
    }
  }

  const { isTable, sqlText } = createTableResolver(parsed, tableNames);

  // A helper's required proof must remain required through every alias branch.
  const containsProof = (
    type: ts.TypeNode,
    seen = new Set<string>(),
  ): boolean => {
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      if (proofNames.has(type.typeName.text)) {
        return true;
      }
      const name = type.typeName.text;
      const target = types.get(name);
      if (target && !seen.has(name)) {
        return containsProof(target, new Set([...seen, name]));
      }
    }
    if (ts.isTypeLiteralNode(type)) {
      return type.members.some(
        (member) =>
          ts.isPropertySignature(member) &&
          !member.questionToken &&
          member.type !== undefined &&
          containsProof(member.type, seen),
      );
    }
    if (ts.isIntersectionTypeNode(type)) {
      return type.types.some((branch) => containsProof(branch, seen));
    }
    if (ts.isUnionTypeNode(type)) {
      return type.types.every((branch) => containsProof(branch, seen));
    }
    return false;
  };

  const isProtected = (mutation: ts.Node, receiver: ts.Expression): boolean => {
    const scope = enclosingFunction(mutation);
    if (!scope || !ts.isIdentifier(receiver)) {
      return false;
    }
    if (
      scope.parameters.some(
        (parameter) =>
          !parameter.questionToken &&
          !parameter.initializer &&
          parameter.type !== undefined &&
          containsProof(parameter.type),
      )
    ) {
      return true;
    }
    const blocks = enclosingBlocks(mutation, scope);
    let locked = false;
    const visit = (node: ts.Node): void => {
      if (isFunctionScope(node) && node !== scope) {
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isAwaitExpression(node.initializer) &&
        ts.isCallExpression(node.initializer.expression)
      ) {
        const call = node.initializer.expression;
        const transaction = call.arguments.at(0);
        const statement = node.parent.parent;
        if (
          ts.isIdentifier(call.expression) &&
          lockNames.has(call.expression.text) &&
          transaction &&
          ts.isIdentifier(transaction) &&
          transaction.text === receiver.text &&
          statement.end <= mutation.getStart(parsed) &&
          blocks.has(statement.parent)
        ) {
          locked = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return locked;
  };

  const findings: TimeEntryPolicyFinding[] = [];
  const record = (
    node: ts.Node,
    receiver: ts.Expression,
    operation: string,
  ): void => {
    if (!isProtected(node, receiver)) {
      findings.push({
        file,
        line:
          parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        operation,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MUTATIONS.has(node.expression.name.text)
    ) {
      const table = node.arguments.at(0);
      if (table && isTable(table)) {
        record(node, node.expression.expression, node.expression.name.text);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "execute"
    ) {
      const query = node.arguments.at(0);
      const text = query ? sqlText(query) : undefined;
      const operation =
        text === undefined
          ? undefined
          : /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:time_entries\b|"time_entries")/iu
              .exec(sqlCode(text))
              ?.at(1)
              ?.split(/\s/u)
              .at(0);
      if (operation) {
        record(node, node.expression.expression, operation.toLowerCase());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
};

const timeEntryPolicySources = (): string[] => {
  const files = Array.from(SOURCE_FILES);
  for (const root of SOURCE_ROOTS) {
    for (const file of new Bun.Glob(`${root}**/*.ts`).scanSync({
      cwd: REPO_ROOT,
      onlyFiles: true,
    })) {
      files.push(file);
    }
  }
  return files;
};

type ScanOptions = {
  files?: Iterable<string>;
  read?: (file: string) => string;
};
export const checkTimeEntryPolicyLocks = ({
  files = timeEntryPolicySources(),
  read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf-8"),
}: ScanOptions = {}): TimeEntryPolicyFinding[] => {
  const findings: TimeEntryPolicyFinding[] = [];
  for (const file of files) {
    if (isTimeEntryPolicySource(file)) {
      findings.push(...findTimeEntryPolicyLocks(file, read(file)));
    }
  }
  return findings.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line,
  );
};

if (import.meta.main) {
  const findings = checkTimeEntryPolicyLocks();
  for (const { file, line, operation } of findings) {
    console.error(
      `${file}:${line}: time entry ${operation} requires an awaited policy lock on the write transaction or a required LockedTimePolicy argument`,
    );
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  }
}
