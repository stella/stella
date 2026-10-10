/** Keep timeout changes on shared pools behind their budget-owning setter. */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { compareCodeUnit } from "@stll/collation";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const API_SOURCE = "apps/api/src/";
const SHARED_OWNER = `${API_SOURCE}db/shared-pool-timeouts.ts`;
const DEDICATED_OWNER = `${API_SOURCE}db/long-running-connection.ts`;

// These modules run under the migrator's independently reserved connection.
const MIGRATION_OWNERS = new Set([
  `${API_SOURCE}db/migration-runner.ts`,
  `${API_SOURCE}db/online-migrations.ts`,
  `${API_SOURCE}db/online-index-gate.ts`,
  `${API_SOURCE}db/corpus-schema-lane.ts`,
  `${API_SOURCE}db/corpus-projection-cleanup-stall-repair.ts`,
  `${API_SOURCE}db/corpus-projection-delete-receipt-repair.ts`,
  `${API_SOURCE}db/better-auth-oauth-resource-repair.ts`,
  `${API_SOURCE}db/decision-date-ceiling-repair.ts`,
]);

// These operator commands construct their own SQL client, apart from rootDb.
const STANDALONE_CONNECTION_OWNERS = new Set([
  `${API_SOURCE}scripts/better-auth-17-backfill.ts`,
  `${API_SOURCE}scripts/better-auth-microsoft-identity-map.ts`,
  `${API_SOURCE}scripts/better-auth-migration-audit.ts`,
  `${API_SOURCE}scripts/database-census.ts`,
  `${API_SOURCE}scripts/seed-migration-rehearsal.ts`,
]);

const TIMEOUT_SETTINGS = new Set([
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
]);
const SETTING_CALL = /\b(?:[a-z_][\w]*\.)*set_config\s*\(\s*([^,)]*)/giu;
const SETTING_COMMAND =
  /(?:^|;)\s*(?:SET\s+(?:(?:LOCAL|SESSION)\s+)?|RESET\s+)("[a-z_][\w.]*"|[a-z_][\w.]*)/giu;
const UNKNOWN = "__STELLA_DYNAMIC_SQL_EXPRESSION__";
const MAY_MUTATE_TIMEOUT = /\b(?:set_config|SET|RESET)\b/iu;
const SHARED_HANDLE_MODULES = new Set([
  `${API_SOURCE}db/root.ts`,
  `${API_SOURCE}lib/public-law-read-db.ts`,
  SHARED_OWNER,
]);
const SHARED_HANDLE_EXPORTS = new Set(["rootDb", "rlsDb", "publicLawReadDb"]);
const isSharedSetterName = (name: string): boolean =>
  /^(?:setShared|withShared)[A-Z]/u.test(name);

export type TimeoutMutation = {
  file: string;
  line: number;
  setting: string;
};

export const isTimeoutMutationSource = (file: string): boolean =>
  file.startsWith(API_SOURCE) &&
  file.endsWith(".ts") &&
  !/\.(?:test|spec|d)\.ts$/u.test(file) &&
  !STANDALONE_CONNECTION_OWNERS.has(file) &&
  file !== SHARED_OWNER &&
  file !== DEDICATED_OWNER &&
  !MIGRATION_OWNERS.has(file);

type SourceLoader = (file: string) => string | undefined;

const defaultSourceLoader: SourceLoader = (file) => {
  const absolute = path.resolve(REPO_ROOT, file);
  if (!absolute.startsWith(`${REPO_ROOT}${path.sep}`)) {
    return undefined;
  }
  return existsSync(absolute) ? readFileSync(absolute, "utf-8") : undefined;
};

const sourceFile = (file: string, source: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

const modulePath = (from: string, specifier: string): string | undefined => {
  if (specifier.startsWith("@/api/")) {
    const resolved = path.posix.normalize(
      `${API_SOURCE}${specifier.slice("@/api/".length)}`,
    );
    return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
  }
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), specifier),
  );
  return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
};

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

type Resolver = {
  resolve: (node: ts.Expression, file: string) => string | undefined;
  sqlNames: (file: string) => Set<string>;
};

const createResolver = (load: SourceLoader): Resolver => {
  const files = new Map<string, ts.SourceFile>();
  const getFile = (file: string): ts.SourceFile | undefined => {
    const cached = files.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const content = load(file);
    if (content === undefined) {
      return undefined;
    }
    const parsed = sourceFile(file, content);
    files.set(file, parsed);
    return parsed;
  };

  const binding = (
    file: string,
    name: string,
    visited = new Set<string>(),
  ): { expression: ts.Expression; file: string } | undefined => {
    const key = `${file}:${name}`;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const parsed = getFile(file);
    if (parsed === undefined) {
      return undefined;
    }
    for (const statement of parsed.statements) {
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find(
          (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
        );
        if (declaration?.initializer !== undefined) {
          return { expression: declaration.initializer, file };
        }
      }
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.importClause?.namedBindings === undefined ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }
      const imported = statement.importClause.namedBindings.elements.find(
        (entry) => entry.name.text === name && !entry.isTypeOnly,
      );
      const target = modulePath(file, statement.moduleSpecifier.text);
      if (imported !== undefined && target !== undefined) {
        return binding(target, imported.propertyName?.text ?? name, visited);
      }
    }
    for (const statement of parsed.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.moduleSpecifier === undefined ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const target = modulePath(file, statement.moduleSpecifier.text);
      if (target === undefined) {
        continue;
      }
      if (statement.exportClause === undefined) {
        const found = binding(target, name, visited);
        if (found !== undefined) {
          return found;
        }
      } else if (ts.isNamedExports(statement.exportClause)) {
        const exported = statement.exportClause.elements.find(
          (entry) => entry.name.text === name,
        );
        if (exported !== undefined) {
          return binding(target, exported.propertyName?.text ?? name, visited);
        }
      }
    }
    return undefined;
  };

  const evaluate = (
    expression: ts.Expression,
    file: string,
    seen: Set<string>,
  ): string | undefined => {
    const node = unwrap(expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return (
        (evaluate(node.left, file, seen) ?? UNKNOWN) +
        (evaluate(node.right, file, seen) ?? UNKNOWN)
      );
    }
    if (ts.isIdentifier(node)) {
      const key = `${file}:${node.text}`;
      if (seen.has(key)) {
        return undefined;
      }
      const found = binding(file, node.text);
      return found === undefined
        ? undefined
        : evaluate(found.expression, found.file, new Set([...seen, key]));
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = unwrap(node.expression);
      if (!ts.isIdentifier(base)) {
        return undefined;
      }
      const found = binding(file, base.text);
      if (found === undefined) {
        return undefined;
      }
      const object = unwrap(found.expression);
      if (!ts.isObjectLiteralExpression(object)) {
        return undefined;
      }
      const property = object.properties.find(
        (entry) =>
          ts.isPropertyAssignment(entry) &&
          (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
          entry.name.text === node.name.text,
      );
      return property !== undefined && ts.isPropertyAssignment(property)
        ? evaluate(property.initializer, found.file, seen)
        : undefined;
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const value = evaluate(span.expression, file, seen);
        if (value === undefined) {
          return undefined;
        }
        result += value + span.literal.text;
      }
      return result;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "raw" &&
      node.arguments.length === 1
    ) {
      const [argument] = node.arguments;
      return argument === undefined
        ? undefined
        : evaluate(argument, file, seen);
    }
    return undefined;
  };

  const sqlNames = (file: string): Set<string> => {
    const names = new Set<string>();
    for (const statement of getFile(file)?.statements ?? []) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "drizzle-orm" ||
        statement.importClause?.namedBindings === undefined ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }
      for (const entry of statement.importClause.namedBindings.elements) {
        if ((entry.propertyName?.text ?? entry.name.text) === "sql") {
          names.add(entry.name.text);
        }
      }
    }
    return names;
  };
  return { resolve: (node, file) => evaluate(node, file, new Set()), sqlNames };
};

const templateText = (
  template: ts.TemplateLiteral,
  file: string,
  resolver: Resolver,
): string => {
  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    return template.text;
  }
  let result = template.head.text;
  for (const span of template.templateSpans) {
    const value = resolver.resolve(span.expression, file);
    const isRaw =
      ts.isCallExpression(span.expression) &&
      ts.isPropertyAccessExpression(span.expression.expression) &&
      span.expression.expression.name.text === "raw";
    const alreadyQuoted =
      result.endsWith("'") && span.literal.text.startsWith("'");
    let rendered = UNKNOWN;
    if (value !== undefined) {
      rendered =
        isRaw || alreadyQuoted ? value : `'${value.replaceAll("'", "''")}'`;
    }
    result += rendered + span.literal.text;
  }
  return result;
};

const settingName = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (trimmed.includes(UNKNOWN)) {
    return undefined;
  }
  if (/^'(?:[^']|'')*'$/u.test(trimmed)) {
    return trimmed
      .slice(1, -1)
      .replaceAll("''", "'")
      .replace(/^"(.*)"$/u, "$1")
      .toLowerCase();
  }
  return undefined;
};

const inspectSql = (sql: string): string[] => {
  const findings: string[] = [];
  const withoutComments = sql
    .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
    .replaceAll(/--[^\n]*/gu, " ");
  for (const match of withoutComments.matchAll(SETTING_CALL)) {
    const rawName = match[1];
    const name = rawName === undefined ? undefined : settingName(rawName);
    if (name === undefined || TIMEOUT_SETTINGS.has(name)) {
      findings.push(name ?? "dynamic set_config name");
    }
  }
  for (const match of withoutComments.matchAll(SETTING_COMMAND)) {
    const rawName = match[1];
    if (rawName === undefined) {
      findings.push("dynamic timeout setting");
      continue;
    }
    const name = rawName.replace(/^"(.*)"$/u, "$1").toLowerCase();
    if (
      TIMEOUT_SETTINGS.has(name) ||
      name === "all" ||
      name === UNKNOWN.toLowerCase()
    ) {
      findings.push(
        name === "all" || name === UNKNOWN.toLowerCase()
          ? "dynamic timeout setting"
          : name,
      );
    }
  }
  return findings;
};

/** The dedicated timeout owner may only configure its own reserved client. */
export const findDedicatedOwnerViolations = (
  source: string,
): TimeoutMutation[] => {
  const parsed = sourceFile(DEDICATED_OWNER, source);
  const findings: TimeoutMutation[] = [];
  const setterAliases = new Set(SHARED_HANDLE_EXPORTS);
  const record = (node: ts.Node, setting: string): void => {
    findings.push({
      file: DEDICATED_OWNER,
      line:
        parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      setting,
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const target = modulePath(DEDICATED_OWNER, node.moduleSpecifier.text);
      if (target !== undefined && SHARED_HANDLE_MODULES.has(target)) {
        record(node, `shared-pool import ${node.moduleSpecifier.text}`);
      }
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const entry of bindings.elements) {
          const importedName = entry.propertyName?.text ?? entry.name.text;
          if (
            SHARED_HANDLE_EXPORTS.has(importedName) ||
            isSharedSetterName(importedName)
          ) {
            setterAliases.add(entry.name.text);
            record(entry, `shared-pool binding ${entry.name.text}`);
          }
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = node.arguments.at(0);
      if (specifier === undefined || !ts.isStringLiteral(specifier)) {
        record(node, "dynamic import");
      } else {
        const target = modulePath(DEDICATED_OWNER, specifier.text);
        if (target !== undefined && SHARED_HANDLE_MODULES.has(target)) {
          record(node, `shared-pool import ${specifier.text}`);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) &&
          (setterAliases.has(callee.text) ||
            isSharedSetterName(callee.text))) ||
        (ts.isPropertyAccessExpression(callee) &&
          isSharedSetterName(callee.name.text))
      ) {
        record(node, `shared-pool call ${callee.getText(parsed)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
};

export const findApiTimeoutMutations = (
  file: string,
  source: string,
  load: SourceLoader = defaultSourceLoader,
): TimeoutMutation[] => {
  if (file === DEDICATED_OWNER) {
    return findDedicatedOwnerViolations(source);
  }
  if (!isTimeoutMutationSource(file) || !MAY_MUTATE_TIMEOUT.test(source)) {
    return [];
  }
  const resolver = createResolver((requested) =>
    requested === file ? source : load(requested),
  );
  const parsed = sourceFile(file, source);
  const sqlNames = resolver.sqlNames(file);
  const findings: TimeoutMutation[] = [];
  const seen = new Set<string>();
  const record = (node: ts.Node, sql: string): void => {
    const line =
      parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
    for (const setting of inspectSql(sql)) {
      const key = `${line}:${setting}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      findings.push({ file, line, setting });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      if (ts.isIdentifier(node.tag) && sqlNames.has(node.tag.text)) {
        record(node, templateText(node.template, file, resolver));
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      sqlNames.has(node.expression.expression.text) &&
      node.expression.name.text === "raw" &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments.at(0);
      if (argument !== undefined) {
        const value = resolver.resolve(argument, file);
        if (value !== undefined) {
          record(node, value);
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (!ts.isBinaryExpression(node.parent) ||
        node.parent.operatorToken.kind !== ts.SyntaxKind.PlusToken)
    ) {
      const value = resolver.resolve(node, file);
      if (value !== undefined) {
        record(node, value);
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !ts.isTaggedTemplateExpression(node.parent)
    ) {
      record(node, node.text);
    } else if (
      ts.isTemplateExpression(node) &&
      !ts.isTaggedTemplateExpression(node.parent)
    ) {
      record(node, templateText(node, file, resolver));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
};

type ScanOptions = {
  files?: Iterable<string>;
  read?: (file: string) => string;
};

export const checkApiTimeoutMutations = ({
  files = new Bun.Glob(`${API_SOURCE}**/*.ts`).scanSync({
    cwd: REPO_ROOT,
    onlyFiles: true,
  }),
  read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf-8"),
}: ScanOptions = {}): TimeoutMutation[] => {
  const findings: TimeoutMutation[] = [];
  for (const file of files) {
    if (file !== DEDICATED_OWNER && !isTimeoutMutationSource(file)) {
      continue;
    }
    findings.push(...findApiTimeoutMutations(file, read(file)));
  }
  return findings.toSorted(
    (left, right) =>
      compareCodeUnit(left.file, right.file) || left.line - right.line,
  );
};

if (import.meta.main) {
  const findings = checkApiTimeoutMutations();
  for (const { file, line, setting } of findings) {
    console.error(
      file === DEDICATED_OWNER
        ? `${file}:${line}: dedicated timeout owner must use its reserved connection; forbidden ${setting}`
        : `${file}:${line}: ${setting} mutation must use ${SHARED_OWNER} (or ${DEDICATED_OWNER} on a dedicated connection)`,
    );
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  }
}
