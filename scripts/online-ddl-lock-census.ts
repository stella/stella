import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { censusSql, DDL_FORMS } from "./migration-lock-census";

const OWNER_PATH = "apps/api/src/db/online-ddl.ts";
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const SQL_START =
  /^\s*(?:CREATE|ALTER|DROP|REINDEX|ANALYZE|COMMENT|TRUNCATE|REFRESH|CLUSTER|VACUUM|GRANT|REVOKE|LOCK|SECURITY|IMPORT|REASSIGN)\b/iu;
const IDENTIFIER_PLACEHOLDER = '"__online_ddl_identifier__"';

type SqlVariant = { text: string; node: ts.Node };

const isSql = (text: string): boolean => SQL_START.test(text);

const expand = (node: ts.Expression): string[] => {
  if (ts.isParenthesizedExpression(node)) {
    return expand(node.expression);
  }
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return [node.text];
  }
  if (ts.isConditionalExpression(node)) {
    return [...expand(node.whenTrue), ...expand(node.whenFalse)];
  }
  if (ts.isTemplateExpression(node)) {
    let variants = [node.head.text];
    for (const span of node.templateSpans) {
      const values = expand(span.expression);
      variants = variants.flatMap((prefix) =>
        values.map((value) => `${prefix}${value}${span.literal.text}`),
      );
    }
    return variants;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return expand(node.left).flatMap((left) =>
      expand(node.right).map((right) => `${left}${right}`),
    );
  }
  if (ts.isIdentifier(node)) {
    return [IDENTIFIER_PLACEHOLDER];
  }
  return [IDENTIFIER_PLACEHOLDER];
};

const isWithinLockTaking = (node: ts.Node): boolean => {
  let current = node;
  while (current.kind !== ts.SyntaxKind.SourceFile) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "lockTaking"
    ) {
      return current.arguments.some(
        (argument) =>
          argument === node ||
          (argument.pos <= node.pos && argument.end >= node.end),
      );
    }
    current = current.parent;
  }
  return false;
};

const isCreateSqlIdentifier = (node: ts.Expression): boolean =>
  ts.isIdentifier(node) && node.text === "createSql";

const enclosingVariableName = (node: ts.Node): string | undefined => {
  let current = node;
  while (current.kind !== ts.SyntaxKind.SourceFile) {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer &&
      ts.isArrowFunction(current.initializer)
    ) {
      return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
};

const isRuntimeAttemptCallback = (call: ts.CallExpression): boolean => {
  let current = call.parent;
  while (current.kind !== ts.SyntaxKind.SourceFile) {
    if (
      ts.isArrowFunction(current) &&
      current.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === "guardedConnection",
      )
    ) {
      const parent = current.parent;
      return (
        ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === "attempt" &&
        ts.isIdentifier(parent.expression.expression) &&
        parent.expression.expression.text === "runtime" &&
        parent.arguments.at(0) === current
      );
    }
    current = current.parent;
  }
  return false;
};

const provesConcurrentCreateSql = (
  source: ts.SourceFile,
  call: ts.CallExpression,
): boolean => {
  const sourceNodes: ts.Node[] = [];
  const collectSourceNodes = (node: ts.Node): void => {
    sourceNodes.push(node);
    ts.forEachChild(node, collectSourceNodes);
  };
  collectSourceNodes(source);
  const anchoredPattern = sourceNodes.some(
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "createSqlTarget" &&
      node.initializer &&
      ts.isRegularExpressionLiteral(node.initializer) &&
      node.initializer.text.startsWith(
        "/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY ",
      ),
  );
  let current = call.parent;
  while (
    current.kind !== ts.SyntaxKind.SourceFile &&
    !(
      ts.isVariableDeclaration(current) &&
      current.name.getText(source) === "createIndexConcurrently"
    )
  ) {
    current = current.parent;
  }
  if (
    !ts.isVariableDeclaration(current) ||
    !current.initializer ||
    !ts.isArrowFunction(current.initializer)
  ) {
    return false;
  }
  const functionNodes: ts.Node[] = [];
  const collectFunctionNodes = (node: ts.Node): void => {
    functionNodes.push(node);
    ts.forEachChild(node, collectFunctionNodes);
  };
  collectFunctionNodes(current.initializer.body);
  const execInput = functionNodes.some((node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "exec" ||
      !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== "createSqlTarget"
    ) {
      return false;
    }
    const input = node.arguments.at(0);
    return (
      node.arguments.length === 1 &&
      input !== undefined &&
      isCreateSqlIdentifier(input)
    );
  });
  const guardedTarget = functionNodes.some((node) => {
    if (!ts.isIfStatement(node)) {
      return false;
    }
    const condition = node.expression.getText(source);
    return (
      node.thenStatement.getText(source).includes("panic(") &&
      condition.includes("built?.[1] !== name") &&
      condition.includes("built[2] !== tableName")
    );
  });
  return anchoredPattern && execInput && guardedTarget;
};

const validateStatementBrand = (source: ts.SourceFile): string[] => {
  const errors: string[] = [];
  const nodes: ts.Node[] = [];
  const findConstructor = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, findConstructor);
  };
  findConstructor(source);
  const lockTakingConstructor = nodes.some(
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "lockTaking" &&
      node.initializer &&
      ts.isArrowFunction(node.initializer) &&
      node.initializer.getText(source).includes("[LOCK_TAKING]: text"),
  );
  if (!lockTakingConstructor) {
    errors.push(
      "lockTaking constructor is missing or does not construct the private brand",
    );
  }

  const insideConstructor = (node: ts.Node): boolean => {
    let current = node;
    while (current.kind !== ts.SyntaxKind.SourceFile) {
      if (
        ts.isVariableDeclaration(current) &&
        ts.isIdentifier(current.name) &&
        current.name.text === "lockTaking"
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };

  const validateBrandUse = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "LOCK_TAKING") {
      const parent = node.parent;
      const declaration =
        ts.isVariableDeclaration(parent) && parent.name === node;
      const typeKey =
        ts.isComputedPropertyName(parent) &&
        ts.isPropertySignature(parent.parent);
      const objectKey =
        ts.isComputedPropertyName(parent) &&
        ts.isPropertyAssignment(parent.parent) &&
        parent.parent.getText(source).includes("[LOCK_TAKING]: text") &&
        insideConstructor(parent);
      const sessionRead =
        ts.isElementAccessExpression(parent) &&
        parent.argumentExpression === node &&
        parent.getText(source) === "statement[LOCK_TAKING]" &&
        enclosingVariableName(parent) === "sessionOn";
      if (!declaration && !typeKey && !objectKey && !sessionRead) {
        errors.push(
          `LOCK_TAKING may only define the brand and be read by sessionOn (line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1})`,
        );
      }
    }
    if (
      (ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node)) &&
      node.type.getText(source) === "LockTakingStatement"
    ) {
      errors.push(
        `LockTakingStatement must be constructed by lockTaking (line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1})`,
      );
    }
    ts.forEachChild(node, validateBrandUse);
  };
  validateBrandUse(source);

  return errors;
};

export const censusOnlineDdlSource = (sourceText: string): string[] => {
  const source = ts.createSourceFile(
    OWNER_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const errors: string[] = [];
  const lockCalls: ts.CallExpression[] = [];
  const sessionCalls: ts.CallExpression[] = [];
  const sqlNodes: SqlVariant[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "lockTaking"
    ) {
      lockCalls.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "sessionOn"
    ) {
      sessionCalls.push(node);
    }
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const variants = ts.isTemplateExpression(node)
        ? expand(node)
        : [node.text];
      if (variants.some(isSql)) {
        sqlNodes.push({ text: variants.join("\n-- variant --\n"), node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const checked = new Set<ts.Node>();
  const checkSql = (text: string, node: ts.Node, context: string): void => {
    const variants = text.split("\n-- variant --\n");
    for (const sql of variants) {
      if (!isSql(sql)) {
        continue;
      }
      const result = censusSql(sql);
      const line =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      for (const error of result.errors) {
        errors.push(`${context} at line ${line}: ${error}`);
      }
      if (result.forms.length === 0 && result.errors.length === 0) {
        errors.push(`${context} at line ${line} has no classified DDL form`);
      }
      for (const form of result.forms) {
        if (!Object.hasOwn(DDL_FORMS, form.form)) {
          errors.push(
            `${context} at line ${line} classified an unknown DDL form: ${form.form}`,
          );
        }
        if (form.lockMode === "ACCESS EXCLUSIVE" && !isWithinLockTaking(node)) {
          errors.push(
            `ACCESS EXCLUSIVE ${form.form} SQL at line ${line} must be passed through lockTaking`,
          );
        }
      }
    }
    checked.add(node);
  };

  for (const call of lockCalls) {
    const sqlArg = call.arguments[1];
    if (!sqlArg) {
      errors.push(
        `lockTaking at line ${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1} has no SQL argument`,
      );
      continue;
    }
    if (isCreateSqlIdentifier(sqlArg)) {
      if (!provesConcurrentCreateSql(source, call)) {
        errors.push(
          "createSql pass-through lacks an anchored concurrent-index AST proof",
        );
      }
      continue;
    }
    const line =
      source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
    const variants = expand(sqlArg);
    if (!variants.some(isSql)) {
      errors.push(
        `lockTaking SQL argument at line ${line} has no recognizable DDL form`,
      );
      continue;
    }
    for (const sql of variants) {
      checkSql(sql, sqlArg, "lockTaking SQL");
    }
  }

  for (const { text, node } of sqlNodes) {
    if (checked.has(node)) {
      continue;
    }
    checkSql(text, node, "SQL literal");
  }

  for (const call of sessionCalls) {
    const owner = enclosingVariableName(call);
    const connection = call.arguments.at(0);
    const line =
      source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
    if (owner === "runGatedTableWork") {
      if (
        !connection ||
        !ts.isIdentifier(connection) ||
        connection.text !== "guardedConnection" ||
        !isRuntimeAttemptCallback(call)
      ) {
        errors.push(
          `sessionOn at line ${line} in runGatedTableWork must use the guarded runtime.attempt connection`,
        );
      }
      continue;
    }
    if (owner === "createUngatedTableGateForTests") {
      if (
        !connection ||
        !ts.isIdentifier(connection) ||
        connection.text !== "connection"
      ) {
        errors.push(
          `sessionOn at line ${line} in the test gate must use its supplied connection`,
        );
      }
      continue;
    }
    errors.push(
      `sessionOn at line ${line} is outside runGatedTableWork or createUngatedTableGateForTests`,
    );
  }

  errors.push(...validateStatementBrand(source));

  return [...new Set(errors)];
};

export const checkOnlineDdlLockCensus = (): string[] =>
  censusOnlineDdlSource(
    readFileSync(path.resolve(REPOSITORY_ROOT, OWNER_PATH), "utf-8"),
  );

if (import.meta.main) {
  const errors = checkOnlineDdlLockCensus();
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
