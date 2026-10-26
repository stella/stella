/** Keep timeout changes on shared pools behind their budget-owning setter. */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import {
  type CallExpression,
  type Node,
  type ParsedSource,
  parseSource,
  type TemplateLiteral,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const API_SOURCE = "apps/api/src/";
const SHARED_OWNER = `${API_SOURCE}db/shared-pool-timeouts.ts`;
const DEDICATED_OWNER = `${API_SOURCE}db/long-running-connection.ts`;

// These modules run under the migrator's independently reserved connection.
const MIGRATION_OWNERS = new Set([
  `${API_SOURCE}db/migration-runner.ts`,
  `${API_SOURCE}db/online-migrations.ts`,
  `${API_SOURCE}db/online-index-gate.ts`,
  `${API_SOURCE}db/online-ddl.ts`,
  `${API_SOURCE}db/corpus-schema-lane.ts`,
  `${API_SOURCE}db/corpus-projection-delete-receipt-repair.ts`,
  `${API_SOURCE}db/better-auth-oauth-resource-repair.ts`,
  `${API_SOURCE}db/decision-date-ceiling-repair.ts`,
  `${API_SOURCE}db/chat-content-v3-backfill.ts`,
]);

// These operator commands construct their own SQL client, apart from rootDb.
const STANDALONE_CONNECTION_OWNERS = new Set([
  `${API_SOURCE}scripts/better-auth-17-backfill.ts`,
  `${API_SOURCE}scripts/better-auth-microsoft-identity-map.ts`,
  `${API_SOURCE}scripts/better-auth-migration-audit-command.ts`,
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

const sourceFile = (file: string, source: string): ParsedSource =>
  parseSource(file, source);

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

const unwrap = (node: Node): Node => {
  let current = node;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "ChainExpression"
  ) {
    current = current.expression;
  }
  return current;
};

const stringText = (node: Node): string | undefined => {
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : undefined;
  }
  return node.type === "TemplateLiteral" && node.expressions.length === 0
    ? (node.quasis.at(0)?.value.cooked ?? "")
    : undefined;
};

const moduleExportName = (name: Node): string | undefined => {
  if (name.type === "Identifier") {
    return name.name;
  }
  return name.type === "Literal" && typeof name.value === "string"
    ? name.value
    : undefined;
};

// `object.name`, not computed.
const memberName = (node: Node): string | undefined =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier"
    ? node.property.name
    : undefined;

const isRawCall = (node: Node): node is CallExpression =>
  node.type === "CallExpression" && memberName(node.callee) === "raw";

type Resolver = {
  resolve: (node: Node, file: string) => string | undefined;
  sqlNames: (file: string) => Set<string>;
};

const createResolver = (load: SourceLoader): Resolver => {
  const files = new Map<string, ParsedSource>();
  const getFile = (file: string): ParsedSource | undefined => {
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
  ): { expression: Node; file: string } | undefined => {
    const key = `${file}:${name}`;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const parsed = getFile(file);
    if (parsed === undefined) {
      return undefined;
    }
    for (const statement of parsed.program.body) {
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
      if (declaration?.type === "VariableDeclaration") {
        const declarator = declaration.declarations.find(
          (entry) => entry.id.type === "Identifier" && entry.id.name === name,
        );
        if (declarator?.init) {
          return { expression: declarator.init, file };
        }
      }
      if (statement.type !== "ImportDeclaration") {
        continue;
      }
      const imported = statement.specifiers.find(
        (entry) =>
          entry.type === "ImportSpecifier" &&
          entry.local.name === name &&
          entry.importKind !== "type",
      );
      const target = modulePath(file, statement.source.value);
      if (imported?.type === "ImportSpecifier" && target !== undefined) {
        return binding(
          target,
          moduleExportName(imported.imported) ?? name,
          visited,
        );
      }
    }
    for (const statement of parsed.program.body) {
      if (
        statement.type === "ExportAllDeclaration" &&
        statement.exported === null
      ) {
        const target = modulePath(file, statement.source.value);
        const found =
          target === undefined ? undefined : binding(target, name, visited);
        if (found !== undefined) {
          return found;
        }
        continue;
      }
      if (
        statement.type !== "ExportNamedDeclaration" ||
        statement.source === null
      ) {
        continue;
      }
      const target = modulePath(file, statement.source.value);
      const exported = statement.specifiers.find(
        (entry) => moduleExportName(entry.exported) === name,
      );
      if (target !== undefined && exported !== undefined) {
        return binding(
          target,
          moduleExportName(exported.local) ?? name,
          visited,
        );
      }
    }
    return undefined;
  };

  const evaluate = (
    expression: Node,
    file: string,
    seen: Set<string>,
  ): string | undefined => {
    const node = unwrap(expression);
    const text = stringText(node);
    if (text !== undefined) {
      return text;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      return (
        (evaluate(node.left, file, seen) ?? UNKNOWN) +
        (evaluate(node.right, file, seen) ?? UNKNOWN)
      );
    }
    if (node.type === "Identifier") {
      const key = `${file}:${node.name}`;
      if (seen.has(key)) {
        return undefined;
      }
      const found = binding(file, node.name);
      return found === undefined
        ? undefined
        : evaluate(found.expression, found.file, new Set([...seen, key]));
    }
    const name = memberName(node);
    if (node.type === "MemberExpression" && name !== undefined) {
      const base = unwrap(node.object);
      if (base.type !== "Identifier") {
        return undefined;
      }
      const found = binding(file, base.name);
      if (found === undefined) {
        return undefined;
      }
      const object = unwrap(found.expression);
      if (object.type !== "ObjectExpression") {
        return undefined;
      }
      const property = object.properties.find(
        (entry) =>
          entry.type === "Property" &&
          entry.kind === "init" &&
          !entry.method &&
          !entry.shorthand &&
          !entry.computed &&
          moduleExportName(entry.key) === name,
      );
      return property?.type === "Property"
        ? evaluate(property.value, found.file, seen)
        : undefined;
    }
    if (node.type === "TemplateLiteral") {
      let result = node.quasis.at(0)?.value.cooked ?? "";
      for (const [index, part] of node.expressions.entries()) {
        const value = evaluate(part, file, seen);
        if (value === undefined) {
          return undefined;
        }
        result += value + (node.quasis.at(index + 1)?.value.cooked ?? "");
      }
      return result;
    }
    if (isRawCall(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      return argument === undefined
        ? undefined
        : evaluate(argument, file, seen);
    }
    return undefined;
  };

  const sqlNames = (file: string): Set<string> => {
    const names = new Set<string>();
    for (const statement of getFile(file)?.program.body ?? []) {
      if (
        statement.type !== "ImportDeclaration" ||
        statement.source.value !== "drizzle-orm"
      ) {
        continue;
      }
      for (const entry of statement.specifiers) {
        if (
          entry.type === "ImportSpecifier" &&
          moduleExportName(entry.imported) === "sql"
        ) {
          names.add(entry.local.name);
        }
      }
    }
    return names;
  };
  return { resolve: (node, file) => evaluate(node, file, new Set()), sqlNames };
};

const templateText = (
  template: TemplateLiteral,
  file: string,
  resolver: Resolver,
): string => {
  let result = template.quasis.at(0)?.value.cooked ?? "";
  for (const [index, part] of template.expressions.entries()) {
    const literal = template.quasis.at(index + 1)?.value.cooked ?? "";
    const value = resolver.resolve(part, file);
    const alreadyQuoted = result.endsWith("'") && literal.startsWith("'");
    let rendered = UNKNOWN;
    if (value !== undefined) {
      rendered =
        isRawCall(part) || alreadyQuoted
          ? value
          : `'${value.replaceAll("'", "''")}'`;
    }
    result += rendered + literal;
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
  const record = (node: Node, setting: string): void => {
    findings.push({
      file: DEDICATED_OWNER,
      line: parsed.locate(node.start).line,
      setting,
    });
  };
  const recordImport = (node: Node, specifier: Node | undefined) => {
    const text = specifier?.type === "Literal" ? specifier.value : undefined;
    if (typeof text !== "string") {
      record(node, "dynamic import");
      return;
    }
    const target = modulePath(DEDICATED_OWNER, text);
    if (target !== undefined && SHARED_HANDLE_MODULES.has(target)) {
      record(node, `shared-pool import ${text}`);
    }
  };
  walk(parsed.program, (node) => {
    if (node.type === "ImportDeclaration") {
      const target = modulePath(DEDICATED_OWNER, node.source.value);
      if (target !== undefined && SHARED_HANDLE_MODULES.has(target)) {
        record(node, `shared-pool import ${node.source.value}`);
      }
      for (const entry of node.specifiers) {
        if (entry.type !== "ImportSpecifier") {
          continue;
        }
        const importedName =
          moduleExportName(entry.imported) ?? entry.local.name;
        if (
          SHARED_HANDLE_EXPORTS.has(importedName) ||
          isSharedSetterName(importedName)
        ) {
          setterAliases.add(entry.local.name);
          record(entry, `shared-pool binding ${entry.local.name}`);
        }
      }
    } else if (node.type === "ImportExpression") {
      recordImport(node, node.source);
    } else if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      recordImport(node, node.arguments.at(0));
    } else if (node.type === "CallExpression") {
      const { callee } = node;
      const name = memberName(callee);
      if (
        (callee.type === "Identifier" &&
          (setterAliases.has(callee.name) ||
            isSharedSetterName(callee.name))) ||
        (name !== undefined && isSharedSetterName(name))
      ) {
        record(
          node,
          `shared-pool call ${source.slice(callee.start, callee.end)}`,
        );
      }
    }
  });
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
  const record = (node: Node, sql: string): void => {
    const { line } = parsed.locate(node.start);
    for (const setting of inspectSql(sql)) {
      const key = `${line}:${setting}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      findings.push({ file, line, setting });
    }
  };
  walk(parsed.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    const tagged = parent?.type === "TaggedTemplateExpression";
    if (node.type === "TaggedTemplateExpression") {
      if (node.tag.type === "Identifier" && sqlNames.has(node.tag.name)) {
        record(node, templateText(node.quasi, file, resolver));
      }
      return;
    }
    if (
      isRawCall(node) &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      sqlNames.has(node.callee.object.name) &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments.at(0);
      const value =
        argument === undefined ? undefined : resolver.resolve(argument, file);
      if (value !== undefined) {
        record(node, value);
      }
      return;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      if (parent?.type !== "BinaryExpression" || parent.operator !== "+") {
        const value = resolver.resolve(node, file);
        if (value !== undefined) {
          record(node, value);
        }
      }
      return;
    }
    const text = stringText(node);
    if (text !== undefined && !tagged) {
      record(node, text);
    } else if (node.type === "TemplateLiteral" && !tagged) {
      record(node, templateText(node, file, resolver));
    }
  });
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
