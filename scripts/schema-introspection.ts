import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

import {
  isDatabaseHandleName,
  isDatabaseOperationMethod,
} from "../.oxlint-plugins/database-access.ts";
import { canonicalModuleId } from "../.oxlint-plugins/module-id.ts";
import type { AllowedFile } from "./ownership.ts";

const DYNAMIC_CALL = "dynamic-call";
const FULL_SCHEMA = "apps/api/src/db/schema";
const DATABASE_DRIVERS =
  /^(?:postgres|pg|pg-pool|mysql2|better-sqlite3|sqlite3|bun:sqlite|@electric-sql\/pglite|drizzle-orm\/(?!pg-core(?:\/|$))[^/]+)(?:\/|$)/u;
const RESOLUTION_OPTIONS = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
} satisfies ts.CompilerOptions;

const hasRuntimeBindings = (clause: ts.ImportClause | undefined): boolean => {
  if (clause === undefined) {
    return true;
  }
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return false;
  }
  if (clause.name !== undefined) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    (ts.isNamespaceImport(bindings) ||
      bindings.elements.some((element) => !element.isTypeOnly))
  );
};

const memberName = (node: ts.Node): string | undefined => {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
};

// Bind only this source to distinguish a collection/hash method from a
// database operation without loading the application's type graph.
const sourceProgram = (source: ts.SourceFile) => {
  const options = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file) =>
    file === source.fileName ? source : undefined;
  return ts.createProgram([source.fileName], options, host);
};

const nonDatabaseMethodReceiver = (source: ts.SourceFile) => {
  const checker = sourceProgram(source).getTypeChecker();
  const importedCryptoHash = (node: ts.Node): boolean => {
    const declarations = checker.getSymbolAtLocation(node)?.declarations;
    const declaration =
      declarations?.length === 1 ? declarations.at(0) : undefined;
    if (
      declaration === undefined ||
      !ts.isImportSpecifier(declaration) ||
      !ts.isImportDeclaration(declaration.parent.parent.parent) ||
      !ts.isStringLiteralLike(declaration.parent.parent.parent.moduleSpecifier)
    ) {
      return false;
    }
    const name = (declaration.propertyName ?? declaration.name).text;
    const specifier = declaration.parent.parent.parent.moduleSpecifier.text;
    return (
      (name === "createHash" && specifier === "node:crypto") ||
      (name === "createSha256" &&
        ["@stll/sha256/bun", "@stll/sha256/node"].includes(specifier))
    );
  };
  const typedCollection = (
    declaration: ts.Declaration,
    method: string,
  ): boolean => {
    const typedDeclaration =
      ts.isBindingElement(declaration) &&
      ts.isObjectBindingPattern(declaration.parent)
        ? checker
            .getTypeAtLocation(declaration.parent)
            .getProperty(
              (declaration.propertyName ?? declaration.name).getText(source),
            )
            ?.declarations?.at(0)
        : declaration;
    return (
      method === "delete" &&
      typedDeclaration !== undefined &&
      (ts.isParameter(typedDeclaration) ||
        ts.isPropertySignature(typedDeclaration)) &&
      typedDeclaration.type !== undefined &&
      ts.isTypeReferenceNode(typedDeclaration.type) &&
      ts.isIdentifier(typedDeclaration.type.typeName) &&
      ["Map", "Set", "ReadonlyMap", "ReadonlySet"].includes(
        typedDeclaration.type.typeName.text,
      ) &&
      checker.getSymbolAtLocation(typedDeclaration.type.typeName)
        ?.declarations === undefined
    );
  };
  type KnownReceiverOptions = {
    node: ts.Expression;
    method: string;
    seen?: Set<ts.Node>;
  };
  const known = ({
    node,
    method,
    seen = new Set<ts.Node>(),
  }: KnownReceiverOptions): boolean => {
    if (seen.has(node)) {
      return false;
    }
    seen.add(node);
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      return known({ node: node.expression, method, seen });
    }
    if (method === DYNAMIC_CALL && ts.isObjectLiteralExpression(node)) {
      return node.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          (ts.isArrowFunction(property.initializer) ||
            ts.isFunctionExpression(property.initializer)),
      );
    }
    const member = checker.getTypeAtLocation(node).getProperty(method);
    if (member !== undefined) {
      const type = checker.getTypeOfSymbolAtLocation(member, node);
      if (type.isStringLiteral() || type.isNumberLiteral()) {
        return true;
      }
    }
    if (ts.isNewExpression(node)) {
      return (
        (method === "delete" &&
          ts.isIdentifier(node.expression) &&
          ["Map", "Set"].includes(node.expression.text) &&
          checker.getSymbolAtLocation(node.expression) === undefined) ||
        (method === "update" &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.getText(source) === "Bun.CryptoHasher")
      );
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      return method === "update" && hashFactoryReceiver(node.expression, seen);
    }
    const symbolNode = ts.isPropertyAccessExpression(node) ? node.name : node;
    const declarations = checker.getSymbolAtLocation(symbolNode)?.declarations;
    const declaration =
      declarations?.length === 1 ? declarations.at(0) : undefined;
    if (declaration === undefined) {
      return false;
    }
    if (
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration)
    ) {
      return (
        declaration.initializer !== undefined &&
        known({ node: declaration.initializer, method, seen })
      );
    }
    return typedCollection(declaration, method);
  };
  const hashFactoryReceiver = (node: ts.Identifier, seen: Set<ts.Node>) => {
    if (importedCryptoHash(node)) {
      return true;
    }
    const factory = checker.getSymbolAtLocation(node)?.declarations;
    const declaration = factory?.length === 1 ? factory.at(0) : undefined;
    return (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      ts.isArrowFunction(declaration.initializer) &&
      !ts.isBlock(declaration.initializer.body) &&
      known({ node: declaration.initializer.body, method: "update", seen })
    );
  };
  return known;
};

type InspectImportOptions = {
  node: ts.Node;
  source: ts.SourceFile;
  file: string;
  dependency: (specifier: string, full: boolean) => void;
  report: (message: string) => void;
};

const inspectImport = ({
  node,
  source,
  file,
  dependency,
  report,
}: InspectImportOptions): void => {
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteralLike(node.moduleSpecifier) &&
    hasRuntimeBindings(node.importClause)
  ) {
    const bindings = node.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (
          !binding.isTypeOnly &&
          isDatabaseHandleName((binding.propertyName ?? binding.name).text)
        ) {
          report(
            `database handle binding in ${file}: ${binding.getText(source)}`,
          );
        }
      }
    }
    dependency(
      node.moduleSpecifier.text,
      bindings !== undefined && ts.isNamespaceImport(bindings),
    );
  }
  if (
    ts.isExportDeclaration(node) &&
    !node.isTypeOnly &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier) &&
    (node.exportClause === undefined ||
      !ts.isNamedExports(node.exportClause) ||
      node.exportClause.elements.some((element) => !element.isTypeOnly))
  ) {
    dependency(node.moduleSpecifier.text, node.exportClause === undefined);
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    !node.isTypeOnly &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    const expression = node.moduleReference.expression;
    if (ts.isStringLiteralLike(expression)) {
      dependency(expression.text, true);
    } else {
      report(`unresolved runtime import in ${file}`);
    }
  }
};

type ValidateSchemaIntrospectionOptions = {
  entries: readonly AllowedFile[];
  repoRoot: string;
};

// Runtime imports and re-exports are followed, including aliases and workspace
// packages. Type-only imports carry no database capability. Third-party code
// is a trust boundary; driver imports are refused rather than traversed.
export const validateSchemaIntrospection = ({
  entries,
  repoRoot,
}: ValidateSchemaIntrospectionOptions): string[] => {
  const problems: string[] = [];
  const sources = new Map<string, ts.SourceFile>();
  const declared = new Set<string>();
  for (const entry of entries) {
    const report = (message: string): void => {
      problems.push(`${entry.path}: ${message}`);
    };
    if (entry.reason.trim().length === 0) {
      report("schema introspection needs a reason");
    }
    if (declared.has(entry.path)) {
      report("duplicate schema introspection entry");
    }
    declared.add(entry.path);
    if (
      entry.path.endsWith("/") ||
      !existsSync(path.join(repoRoot, entry.path))
    ) {
      report("schema introspection must name an existing file");
      continue;
    }
    const visited = new Set<string>();
    const fullSchemaImports = new Set<string>();
    const walk = (file: string): void => {
      if (visited.has(file)) {
        return;
      }
      visited.add(file);
      const absolute = path.join(repoRoot, file);
      let source = sources.get(file);
      if (source === undefined) {
        source = ts.createSourceFile(
          file,
          readFileSync(absolute, "utf-8"),
          ts.ScriptTarget.Latest,
          true,
        );
        sources.set(file, source);
      }
      if (sourceProgram(source).getSyntacticDiagnostics(source).length > 0) {
        report(`cannot parse runtime dependency: ${file}`);
        return;
      }
      let knownNonDatabaseReceiver:
        | ReturnType<typeof nonDatabaseMethodReceiver>
        | undefined;
      const dependency = (specifier: string, full: boolean): void => {
        const module = canonicalModuleId(specifier, file);
        if (
          file === entry.path &&
          full &&
          (module === FULL_SCHEMA ||
            (file === `${FULL_SCHEMA}.ts` &&
              module.startsWith(`${FULL_SCHEMA}/`)))
        ) {
          fullSchemaImports.add(module);
        }
        if (
          DATABASE_DRIVERS.test(module) ||
          module === "apps/api/src/db" ||
          /\/db\/(?:root|scoped|system|index)$/u.test(module)
        ) {
          report(`database handle import in ${file}: ${specifier}`);
          return;
        }
        const local =
          module.startsWith("apps/") ||
          module.startsWith("packages/") ||
          module.startsWith("scripts/") ||
          specifier.startsWith(".") ||
          specifier.startsWith("@/");
        if (local) {
          const target = [
            `${module}.ts`,
            `${module}.tsx`,
            `${module}/index.ts`,
          ].find((candidate) => existsSync(path.join(repoRoot, candidate)));
          if (target === undefined) {
            report(`unresolved runtime import in ${file}: ${specifier}`);
            return;
          }
          walk(target);
          return;
        }
        if (specifier.startsWith("@stll/")) {
          const resolved = ts.resolveModuleName(
            specifier,
            absolute,
            RESOLUTION_OPTIONS,
            ts.sys,
          ).resolvedModule;
          if (
            resolved === undefined ||
            resolved.resolvedFileName.endsWith(".d.ts")
          ) {
            report(
              `unresolved workspace runtime import in ${file}: ${specifier}`,
            );
            return;
          }
          walk(repoRelativePath(repoRoot, resolved.resolvedFileName));
        }
      };
      const inspectMember = (node: ts.Node): void => {
        if (
          !ts.isPropertyAccessExpression(node) &&
          !ts.isElementAccessExpression(node)
        ) {
          return;
        }
        const name = memberName(node);
        if (
          name === undefined &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node
        ) {
          knownNonDatabaseReceiver ??= nonDatabaseMethodReceiver(source);
          if (
            !knownNonDatabaseReceiver({
              node: node.expression,
              method: DYNAMIC_CALL,
            })
          ) {
            report(`unresolved runtime call in ${file}`);
          }
          return;
        }
        if (name === undefined || !isDatabaseOperationMethod(name)) {
          return;
        }
        knownNonDatabaseReceiver ??= nonDatabaseMethodReceiver(source);
        if (
          !knownNonDatabaseReceiver({ node: node.expression, method: name })
        ) {
          report(`database operation in ${file}: ${name}`);
        }
      };
      const inspectCall = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const name = memberName(node.expression);
          if (
            ts.isIdentifier(node.expression) &&
            isDatabaseOperationMethod(node.expression.text)
          ) {
            report(`database operation in ${file}: ${node.expression.text}`);
          }
          if (
            node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            name === "require"
          ) {
            const specifier = node.arguments.at(0);
            if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
              dependency(specifier.text, true);
            } else {
              report(`unresolved runtime import in ${file}`);
            }
          }
        }
      };
      const visit = (node: ts.Node): void => {
        inspectImport({ node, source, file, dependency, report });
        inspectCall(node);
        inspectMember(node);
        if (
          ts.isBindingElement(node) &&
          node.propertyName !== undefined &&
          ts.isObjectBindingPattern(node.parent)
        ) {
          const name = memberName(node.propertyName ?? node.name);
          if (name !== undefined && isDatabaseOperationMethod(name)) {
            report(`database operation in ${file}: ${name}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    };
    walk(entry.path);
    if (fullSchemaImports.size === 0) {
      report(
        "stale schema introspection entry: no full-schema import or re-export",
      );
    }
  }
  return [...new Set(problems)];
};

// Measure path membership rather than list length: removing one entry cannot
// fund a different entry. The initial comparison reads the existing schema
// owners' exceptions from the base tree, without evaluating either registry.
export const schemaIntrospectionPaths = (content: string): string[] => {
  const source = ts.createSourceFile(
    "ownership.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const paths = new Set<string>();
  const property = (object: ts.ObjectLiteralExpression, name: string) =>
    object.properties.find(
      (node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) && memberName(node.name) === name,
    )?.initializer;
  const collectPaths = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const value = property(node, "path");
      if (
        value !== undefined &&
        ts.isStringLiteralLike(value) &&
        !value.text.endsWith("/")
      ) {
        paths.add(value.text);
      }
    }
    ts.forEachChild(node, collectPaths);
  };
  let shared: ts.Expression | undefined;
  const findShared = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "SCHEMA_INTROSPECTION"
    ) {
      shared = node.initializer;
    }
    ts.forEachChild(node, findShared);
  };
  findShared(source);
  if (shared !== undefined) {
    while (
      ts.isAsExpression(shared) ||
      ts.isSatisfiesExpression(shared) ||
      ts.isParenthesizedExpression(shared)
    ) {
      shared = shared.expression;
    }
    if (!ts.isArrayLiteralExpression(shared)) {
      panic(
        "SCHEMA_INTROSPECTION must be a literal array for membership measurement",
      );
    }
    for (const item of shared.elements) {
      if (!ts.isObjectLiteralExpression(item)) {
        panic("SCHEMA_INTROSPECTION entries must be literal objects");
      }
      const value = property(item, "path");
      if (value === undefined || !ts.isStringLiteralLike(value)) {
        panic("SCHEMA_INTROSPECTION paths must be literal strings");
      }
      paths.add(value.text);
    }
    return [...paths];
  }
  const legacy = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const kind = property(node, "kind");
      const specifiers = property(node, "specifiers");
      const allowed = property(node, "allowed");
      if (
        kind !== undefined &&
        ts.isStringLiteralLike(kind) &&
        kind.text === "import" &&
        specifiers !== undefined &&
        ts.isArrayLiteralExpression(specifiers) &&
        specifiers.elements.some(
          (specifier) =>
            ts.isStringLiteralLike(specifier) &&
            (canonicalModuleId(specifier.text, `${FULL_SCHEMA}.ts`) ===
              FULL_SCHEMA ||
              canonicalModuleId(specifier.text, `${FULL_SCHEMA}.ts`).startsWith(
                `${FULL_SCHEMA}/`,
              )),
        ) &&
        allowed !== undefined
      ) {
        collectPaths(allowed);
      }
    }
    ts.forEachChild(node, legacy);
  };
  legacy(source);
  return [...paths];
};
