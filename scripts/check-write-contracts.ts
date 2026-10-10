/** Checks the route graph without importing or initializing the API stack. */
import { panic } from "better-result";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { SAFE_HANDLER_FACTORIES } from "../apps/api/src/lib/safe-handler-factories";
import { writeContractRouteKey } from "../apps/api/src/lib/write-contract";
import { BASELINE_PATHS } from "./baseline-paths";
import { enumerateAggregateMutations } from "./check-aggregate-mutations";
import type { MutationRegistration } from "./check-aggregate-mutations";

const ROOT = path.resolve(import.meta.dir, "..");
const OWNER = "apps/api/src/lib/write-contract.ts";
const BASELINE = BASELINE_PATHS.writeContracts;
export const writeContractBaselineSchema = v.array(
  v.strictObject({
    key: v.string(),
    count: v.pipe(v.number(), v.integer(), v.minValue(1)),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1)),
    baselineId: v.pipe(v.string(), v.minLength(1)),
  }),
);
export type WriteContractBaseline = v.InferOutput<
  typeof writeContractBaselineSchema
>;
type SourceLoader = (file: string) => string | undefined;
type LocatedExpression = { file: string; node: ts.Expression };
export type WriteRegistration = MutationRegistration & {
  contract: string | undefined;
  precondition: string | undefined;
  baselineId: string | undefined;
  description: string | undefined;
  violations: string[];
};

const unwrap = (node: ts.Expression): ts.Expression => {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node;
};
const modulePath = (file: string, specifier: string) => {
  let target: string | undefined;
  if (specifier.startsWith("@/api/")) {
    target = `apps/api/src/${specifier.slice(6)}`;
  } else if (specifier.startsWith(".")) {
    target = path.posix.join(path.posix.dirname(file), specifier);
  }
  return target === undefined
    ? undefined
    : `${target.replace(/\.ts$/u, "")}.ts`;
};

type BindingReference = { file: string; name: string };
type BindingReferenceOptions = BindingReference & { statement: ts.Statement };
type BindingOptions = { file: string; name: string; visited?: Set<string> };
type FactoryBindingOptions = {
  file: string;
  expression: ts.Expression;
  seen?: Set<string>;
};

class WriteSourceResolver {
  private readonly load: SourceLoader;
  constructor(load: SourceLoader) {
    this.load = load;
  }
  private readonly sources = new Map<string, ts.SourceFile>();
  source = (file: string) => {
    const cached = this.sources.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const content = this.load(file);
    if (content === undefined) {
      return undefined;
    }
    const parsed = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    this.sources.set(file, parsed);
    return parsed;
  };
  binding = ({
    file,
    name,
    visited = new Set<string>(),
  }: BindingOptions): LocatedExpression | undefined => {
    const key = `${file}#${name}`;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const parsed = this.source(file);
    if (parsed === undefined) {
      return undefined;
    }
    for (const statement of parsed.statements) {
      if (name === "default" && ts.isExportAssignment(statement)) {
        return this.resolve({ file, node: statement.expression }, visited);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer !== undefined
          ) {
            return this.resolve(
              { file, node: declaration.initializer },
              visited,
            );
          }
        }
      }
      const reference = this.reference({ file, name, statement });
      if (reference !== undefined) {
        return this.binding({ ...reference, visited });
      }
    }
    return undefined;
  };
  reference = ({
    file,
    name,
    statement,
  }: BindingReferenceOptions): BindingReference | undefined => {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.importClause;
      const target = modulePath(file, statement.moduleSpecifier.text);
      if (target === undefined || clause === undefined) {
        return undefined;
      }
      if (clause.name?.text === name) {
        return { file: target, name: "default" };
      }
      if (
        clause.namedBindings === undefined ||
        !ts.isNamedImports(clause.namedBindings)
      ) {
        return undefined;
      }
      const found = clause.namedBindings.elements.find(
        (item) => item.name.text === name,
      );
      return found === undefined
        ? undefined
        : { file: target, name: found.propertyName?.text ?? found.name.text };
    }
    if (
      !ts.isExportDeclaration(statement) ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      return undefined;
    }
    const found = statement.exportClause.elements.find(
      (item) => item.name.text === name,
    );
    if (found === undefined) {
      return undefined;
    }
    const target =
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
        ? modulePath(file, statement.moduleSpecifier.text)
        : file;
    return target === undefined
      ? undefined
      : { file: target, name: found.propertyName?.text ?? found.name.text };
  };
  resolve = (
    { file, node }: LocatedExpression,
    visited = new Set<string>(),
  ): LocatedExpression | undefined => {
    const value = unwrap(node);
    if (ts.isIdentifier(value)) {
      return this.binding({ file, name: value.text, visited });
    }
    if (ts.isPropertyAccessExpression(value)) {
      const property = this.fields({ file, node: value.expression }).get(
        value.name.text,
      );
      return property === undefined
        ? undefined
        : this.resolve(property, visited);
    }
    return { file, node: value };
  };
  fields = (
    value: LocatedExpression,
    visited = new Set<string>(),
  ): Map<string, LocatedExpression> => {
    const resolved = this.resolve(value);
    const result = new Map<string, LocatedExpression>();
    if (
      resolved === undefined ||
      !ts.isObjectLiteralExpression(resolved.node)
    ) {
      return result;
    }
    const identity = `${resolved.file}:${resolved.node.pos}`;
    if (visited.has(identity)) {
      return result;
    }
    visited.add(identity);
    for (const property of resolved.node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = this.resolve({
          file: resolved.file,
          node: property.expression,
        });
        if (
          spread === undefined ||
          !ts.isObjectLiteralExpression(spread.node)
        ) {
          // An opaque later spread may overwrite every preceding declaration.
          result.clear();
          continue;
        }
        for (const [name, item] of this.fields(spread, new Set(visited))) {
          result.set(name, item);
        }
      } else if (ts.isPropertyAssignment(property)) {
        const name =
          ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
            ? property.name.text
            : undefined;
        if (name === undefined) {
          result.clear();
        } else {
          result.set(name, { file: resolved.file, node: property.initializer });
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        result.set(property.name.text, {
          file: resolved.file,
          node: property.name,
        });
      }
    }
    return result;
  };
  text = (value: LocatedExpression | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const resolved = this.resolve(value);
    if (resolved === undefined) {
      return undefined;
    }
    if (
      ts.isStringLiteral(resolved.node) ||
      ts.isNoSubstitutionTemplateLiteral(resolved.node)
    ) {
      return resolved.node.text;
    }
    if (
      ts.isBinaryExpression(resolved.node) &&
      resolved.node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = this.text({ file: resolved.file, node: resolved.node.left });
      const right = this.text({
        file: resolved.file,
        node: resolved.node.right,
      });
      if (left !== undefined && right !== undefined) {
        return left + right;
      }
    }
    return undefined;
  };
  factoryBinding = ({
    file,
    expression,
    seen = new Set<string>(),
  }: FactoryBindingOptions):
    | { module: string; imported: string }
    | undefined => {
    const node = unwrap(expression);
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) {
      return undefined;
    }
    let name: string | undefined;
    if (ts.isIdentifier(node)) {
      name = node.text;
    } else if (ts.isIdentifier(node.expression)) {
      name = node.expression.text;
    }
    if (name === undefined || seen.has(`${file}#${name}`)) {
      return undefined;
    }
    seen.add(`${file}#${name}`);
    for (const statement of this.source(file)?.statements ?? []) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const target = modulePath(file, statement.moduleSpecifier.text);
        const imports = statement.importClause?.namedBindings;
        if (
          target === undefined ||
          imports === undefined ||
          statement.importClause?.isTypeOnly
        ) {
          continue;
        }
        if (ts.isNamedImports(imports) && ts.isIdentifier(node)) {
          const found = imports.elements.find(
            (item) => item.name.text === name && !item.isTypeOnly,
          );
          if (found !== undefined) {
            return {
              module: target,
              imported: found.propertyName?.text ?? found.name.text,
            };
          }
        }
        if (
          ts.isNamespaceImport(imports) &&
          imports.name.text === name &&
          ts.isPropertyAccessExpression(node)
        ) {
          return { module: target, imported: node.name.text };
        }
      }
      if (ts.isVariableStatement(statement) && ts.isIdentifier(node)) {
        const found = statement.declarationList.declarations.find(
          (item) => ts.isIdentifier(item.name) && item.name.text === name,
        );
        if (found?.initializer !== undefined) {
          return this.factoryBinding({
            file,
            expression: found.initializer,
            seen,
          });
        }
      }
    }
    return undefined;
  };
  private readonly safeBoundaries = new Set<string>();
  config = (handler: string): Map<string, LocatedExpression> => {
    const match = /^(.*\.ts)(?:#(.*))?\.handler$/u.exec(handler);
    if (match === null || match[1] === undefined) {
      return new Map();
    }
    const exported = this.binding({
      file: match[1],
      name: match[2] ?? "default",
    });
    if (exported === undefined || !ts.isCallExpression(exported.node)) {
      return new Map();
    }
    const imported = this.factoryBinding({
      file: exported.file,
      expression: exported.node.expression,
    });
    const factory = Object.entries(SAFE_HANDLER_FACTORIES).find(
      ([name, definition]) =>
        imported !== undefined &&
        name === imported.imported &&
        modulePath(exported.file, definition.module) === imported.module,
    );
    if (factory === undefined) {
      return new Map();
    }
    this.safeBoundaries.add(handler);
    const argument = exported.node.arguments.at(0);
    if (argument === undefined) {
      return new Map();
    }
    const options = this.fields({ file: exported.file, node: argument });
    if (factory[1].configArgument === "options") {
      const nested = options.get("config");
      return nested === undefined ? new Map() : this.fields(nested);
    }
    return options;
  };
  strings = (value: LocatedExpression | undefined): string[] | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const resolved = this.resolve(value);
    if (resolved === undefined || !ts.isArrayLiteralExpression(resolved.node)) {
      return undefined;
    }
    const result: string[] = [];
    for (const element of resolved.node.elements) {
      const literal = this.text({ file: resolved.file, node: element });
      if (literal === undefined) {
        return undefined;
      }
      result.push(literal);
    }
    return result;
  };
  isSafe = (handler: string) => this.safeBoundaries.has(handler);
}

const preconditionFields = (type: string | undefined): string[] => {
  switch (type) {
    case "updatedAt":
      return ["type", "field"];
    case "revision":
      return ["type", "fields"];
    case "deferred":
      return ["type", "baselineId"];
    default:
      return [];
  }
};

export const enumerateWriteContracts = (
  load: SourceLoader,
): WriteRegistration[] => {
  const resolver = new WriteSourceResolver(load);
  const rawDeclaration = resolver.binding({
    file: OWNER,
    name: "RAW_WRITE_CONTRACTS",
  });
  const raw =
    rawDeclaration === undefined
      ? new Map<string, LocatedExpression>()
      : resolver.fields(rawDeclaration);
  const routes = enumerateAggregateMutations(load).filter(
    (route) => route.method !== "GENERIC" && route.method !== "INTERCEPT",
  );
  const stableKeys = new Set(
    routes.map((route) => writeContractRouteKey(route.key)),
  );
  for (const key of raw.keys()) {
    if (!stableKeys.has(key)) {
      panic(`Stale raw write contract: ${key}`);
    }
  }
  const revisionRegistry = resolver.binding({
    file: OWNER,
    name: "REVISION_PRECONDITIONS",
  });
  const revisions =
    revisionRegistry === undefined
      ? []
      : [...resolver.fields(revisionRegistry).values()].map(resolver.strings);
  return routes.map((route) => {
    const stableKey = writeContractRouteKey(route.key);
    const rawValue = raw.get(stableKey);
    const canonical = resolver.config(route.handler);
    if (rawValue !== undefined && resolver.isSafe(route.handler)) {
      panic(`Raw write contract cannot override a safe handler: ${route.key}`);
    }
    const config =
      rawValue === undefined ? canonical : resolver.fields(rawValue);
    const preconditionValue = config.get("precondition");
    const precondition =
      preconditionValue === undefined
        ? new Map<string, LocatedExpression>()
        : resolver.fields(preconditionValue);
    const violations: string[] = [];
    const type = resolver.text(precondition.get("type"));
    const allowedFields = preconditionFields(type);
    if (
      [...precondition.keys()].some((field) => !allowedFields.includes(field))
    ) {
      violations.push("Precondition fields must match the declared protocol");
    }
    if (
      type === "updatedAt" &&
      resolver.text(precondition.get("field")) !== "expectedUpdatedAt"
    ) {
      violations.push(
        "Timestamp precondition requires field expectedUpdatedAt",
      );
    }
    if (type === "revision") {
      const values = resolver.strings(precondition.get("fields"));
      if (
        values === undefined ||
        values.length === 0 ||
        !revisions.some(
          (revision) =>
            revision !== undefined &&
            JSON.stringify(revision) === JSON.stringify(values),
        )
      ) {
        violations.push("Revision precondition requires registered fields");
      }
    }
    if (
      resolver.text(config.get("contract")) === "patch" &&
      preconditionValue !== undefined
    ) {
      violations.push("Patch contract cannot declare a precondition");
    }
    return {
      ...route,
      violations,
      contract: resolver.text(config.get("contract")),
      precondition: resolver.text(precondition.get("type")),
      baselineId: resolver.text(precondition.get("baselineId")),
      description: resolver.text(config.get("description")),
    };
  });
};

export const readWriteContractDebtIds = (load: SourceLoader): string[] => {
  const resolver = new WriteSourceResolver(load);
  const declaration = resolver.binding({
    file: OWNER,
    name: "REPLACE_CONTRACT_DEBT_IDS",
  });
  if (
    declaration === undefined ||
    !ts.isArrayLiteralExpression(declaration.node)
  ) {
    panic("Write contract debt IDs require a literal array");
  }
  return declaration.node.elements.map((element) => {
    const value = resolver.text({ file: declaration.file, node: element });
    if (value === undefined) {
      panic("Write contract debt IDs require literal strings");
    }
    return value;
  });
};

type CheckWriteContractsOptions = {
  registrations: readonly WriteRegistration[];
  baseline: WriteContractBaseline;
  previous: WriteContractBaseline | undefined;
  previousRegistrations: readonly MutationRegistration[];
  debtIds?: readonly string[];
};
const writeRouteErrors = (route: WriteRegistration): string[] => {
  const errors = route.violations.map(
    (violation) => `${violation}: ${route.key}`,
  );
  if (route.contract !== "patch" && route.contract !== "replace") {
    errors.push(`Missing write contract: ${route.key}`);
  }
  if (
    /^Replace\b/iu.test(route.description?.trimStart() ?? "") &&
    route.contract !== "replace"
  ) {
    errors.push(`Replace description requires replace contract: ${route.key}`);
  }
  if (route.contract !== "replace") {
    return errors;
  }
  if (
    !["updatedAt", "revision", "deferred"].includes(route.precondition ?? "")
  ) {
    errors.push(`Replace route requires precondition: ${route.key}`);
  }
  if (route.precondition !== "deferred") {
    return errors;
  }
  const expectedId = route.handler.endsWith(".handler")
    ? route.handler.slice(0, -8)
    : writeContractRouteKey(route.key);
  if (route.baselineId !== expectedId) {
    errors.push(`Misbound deferred baseline ID: ${route.key}`);
  }
  return errors;
};

type WriteDebtOptions = Pick<
  CheckWriteContractsOptions,
  "baseline" | "debtIds"
>;
const writeDebtErrors = ({ baseline, debtIds }: WriteDebtOptions): string[] => {
  const errors: string[] = [];
  if (debtIds === undefined) {
    return errors;
  }
  const expectedIds = new Set(baseline.map((row) => row.baselineId));
  const declaredIds = new Set(debtIds);
  if (declaredIds.size !== debtIds.length) {
    errors.push("Duplicate write contract debt ID");
  }
  for (const id of declaredIds) {
    if (!expectedIds.has(id)) {
      errors.push(`Orphan write contract debt ID: ${id}`);
    }
  }
  for (const id of expectedIds) {
    if (!declaredIds.has(id)) {
      errors.push(`Missing write contract debt ID: ${id}`);
    }
  }
  return errors;
};

const collectDeferredRegistrations = (
  registrations: readonly WriteRegistration[],
) => {
  const counts = new Map<string, number>();
  const deferred = new Map<string, WriteRegistration>();
  for (const route of registrations) {
    if (route.contract !== "replace" || route.precondition !== "deferred") {
      continue;
    }
    counts.set(route.key, (counts.get(route.key) ?? 0) + 1);
    deferred.set(route.key, route);
  }
  return { counts, deferred };
};

type WriteBaselineOptions = Pick<
  CheckWriteContractsOptions,
  "baseline" | "previous" | "previousRegistrations"
> &
  ReturnType<typeof collectDeferredRegistrations>;
const writeBaselineErrors = ({
  baseline,
  previous,
  previousRegistrations,
  counts,
  deferred,
}: WriteBaselineOptions): string[] => {
  const errors: string[] = [];
  const oldCounts = new Map<string, number>();
  for (const route of previousRegistrations) {
    oldCounts.set(route.key, (oldCounts.get(route.key) ?? 0) + 1);
  }
  const previousRows = new Map(previous?.map((row) => [row.key, row]));
  const seen = new Set<string>();
  for (const row of baseline) {
    if (seen.has(row.key)) {
      errors.push(`Duplicate write baseline key: ${row.key}`);
    }
    seen.add(row.key);
    if (row.reason.trim() === "") {
      errors.push(`Missing write baseline reason: ${row.key}`);
    }
    if (row.count !== counts.get(row.key)) {
      errors.push(`Stale write baseline count: ${row.key}`);
    }
    if (row.baselineId !== deferred.get(row.key)?.baselineId) {
      errors.push(`Misbound write baseline ID: ${row.key}`);
    }
    if (previous === undefined) {
      if (row.count > (oldCounts.get(row.key) ?? 0)) {
        errors.push(`New route cannot be deferred: ${row.key}`);
      }
      continue;
    }
    const old = previousRows.get(row.key);
    if (
      old === undefined ||
      row.count > old.count ||
      row.reason !== old.reason ||
      row.baselineId !== old.baselineId
    ) {
      errors.push(`Write baseline may only shrink: ${row.key}`);
    }
  }
  for (const key of deferred.keys()) {
    if (!seen.has(key)) {
      errors.push(`Unbaselined deferred replace route: ${key}`);
    }
  }
  return errors;
};

export const checkWriteContracts = ({
  registrations,
  baseline,
  previous,
  previousRegistrations,
  debtIds,
}: CheckWriteContractsOptions): string[] => {
  const errors = registrations.flatMap(writeRouteErrors);
  const { counts, deferred } = collectDeferredRegistrations(registrations);
  errors.push(...writeDebtErrors({ baseline, debtIds }));
  errors.push(
    ...writeBaselineErrors({
      baseline,
      previous,
      previousRegistrations,
      counts,
      deferred,
    }),
  );
  return errors;
};

if (import.meta.main) {
  const requested =
    process.env["BASE_SHA"] ?? process.env["BASE_REF"] ?? "origin/main";
  const reference = spawnSync(
    "git",
    ["rev-parse", "--verify", `${requested}^{commit}`],
    { cwd: ROOT, encoding: "utf-8" },
  );
  if (reference.status !== 0) {
    panic(`Write contract comparison ref unavailable: ${requested}`);
  }
  const comparison =
    process.env["BASE_SHA"] !== undefined
      ? reference
      : spawnSync("git", ["merge-base", "HEAD", reference.stdout.trim()], {
          cwd: ROOT,
          encoding: "utf-8",
        });
  if (comparison.status !== 0) {
    panic("Write contract merge-base unavailable");
  }
  const commit = comparison.stdout.trim();
  const load: SourceLoader = (file) =>
    existsSync(path.join(ROOT, file))
      ? readFileSync(path.join(ROOT, file), "utf-8")
      : undefined;
  const previousLoad: SourceLoader = (file) => {
    const result = spawnSync("git", ["show", `${commit}:${file}`], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    return result.status === 0 ? result.stdout : undefined;
  };
  const previousSource = previousLoad(BASELINE);
  const baseline = v.parse(
    writeContractBaselineSchema,
    JSON.parse(readFileSync(path.join(ROOT, BASELINE), "utf-8")),
  );
  const previous =
    previousSource === undefined
      ? undefined
      : v.parse(writeContractBaselineSchema, JSON.parse(previousSource));
  const registrations = enumerateWriteContracts(load);
  const errors = checkWriteContracts({
    registrations,
    baseline,
    previous,
    previousRegistrations:
      previous === undefined ? enumerateAggregateMutations(previousLoad) : [],
    debtIds: readWriteContractDebtIds(load),
  });
  for (const error of errors) {
    process.stderr.write(`${error}\n`);
  }
  process.stdout.write(
    `Write contracts: ${registrations.length} surfaces, ${baseline.length} deferred entries\n`,
  );
  if (errors.length !== 0) {
    process.exitCode = 1;
  }
}
