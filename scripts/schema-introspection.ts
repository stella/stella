import { panic, Result } from "better-result";
import { existsSync } from "node:fs";
import path from "node:path";
import * as ts from "tsrs/unstable/ast";
import {
  API,
  type Checker,
  ModuleKind,
  ModuleResolutionKind,
  type Symbol as CompilerSymbol,
} from "tsrs/unstable/async";
import { serverFS } from "tsrs/unstable/fs";

import { repoRelativePath } from "@stll/portable-path";

import {
  isDatabaseHandleName,
  isDatabaseOperationMethod,
} from "../.oxlint-plugins/database-access.ts";
import { canonicalModuleId } from "../.oxlint-plugins/module-id.ts";
import {
  type Node,
  type ObjectExpression,
  parseSource,
  walk as walkSyntax,
} from "../packages/scripts/src/syntax-tree";
import type { AllowedFile } from "./ownership.ts";

const DYNAMIC_CALL = "dynamic-call";
const FULL_SCHEMA = "apps/api/src/db/schema";
const DATABASE_DRIVERS =
  /^(?:postgres|pg|pg-pool|mysql2|better-sqlite3|sqlite3|bun:sqlite|@electric-sql\/pglite|drizzle-orm\/(?!pg-core(?:\/|$))[^/]+)(?:\/|$)/u;
const RESOLUTION_OPTIONS = {
  module: ModuleKind.ESNext,
  moduleResolution: ModuleResolutionKind.Bundler,
};

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
    ts.isStringLiteralLikeNode(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
};

const isDrizzleViewDefinitionSelect = async (
  node: ts.Node,
  source: ts.SourceFile,
): Promise<boolean> => {
  let callback: ts.Node | undefined;
  for (let current: ts.Node = node; ; current = current.parent) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      callback = current;
      break;
    }
    if (current === source) {
      break;
    }
  }
  if (
    callback === undefined ||
    !ts.isArrowFunction(callback) ||
    (!ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)) ||
    !ts.isCallExpression(callback.parent) ||
    !ts.isPropertyAccessExpression(callback.parent.expression) ||
    callback.parent.expression.name.text !== "as" ||
    !callback.parent.arguments.includes(callback)
  ) {
    return false;
  }
  const builderParameter = callback.parameters.at(0)?.name;
  if (
    builderParameter === undefined ||
    !ts.isIdentifier(builderParameter) ||
    (!ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)) ||
    !ts.isIdentifier(node.expression)
  ) {
    return false;
  }
  const checker = sourceChecker(source);
  if (
    (await checker.getSymbolAtLocation(builderParameter)) !==
    (await checker.getSymbolAtLocation(node.expression))
  ) {
    return false;
  }
  let receiver: ts.Expression = callback.parent.expression.expression;
  while (ts.isCallExpression(receiver)) {
    if (
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === "pgView"
    ) {
      return true;
    }
    receiver = ts.isPropertyAccessExpression(receiver.expression)
      ? receiver.expression.expression
      : receiver.expression;
  }
  return false;
};

const transparentExpression = (node: ts.Expression): ts.Expression => {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isNonNullExpression(node)
  ) {
    return transparentExpression(node.expression);
  }
  return node;
};

const transparentExpressionParent = (node: ts.Expression): ts.Node => {
  let current = node;
  while (
    (ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent) ||
      ts.isTypeAssertion(current.parent) ||
      ts.isNonNullExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current.parent;
};

const assignedIdentifier = (
  expression: ts.Expression,
): ts.Identifier | undefined => {
  const parent = transparentExpressionParent(expression);
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    transparentExpression(parent.initializer) === expression &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    transparentExpression(parent.right) === expression
  ) {
    const target = transparentExpression(parent.left);
    if (ts.isIdentifier(target)) {
      return target;
    }
  }
  return undefined;
};

// Bind only this source to distinguish a collection/hash method from a
// database operation without loading the application's type graph.
const declarationsOf = async (
  symbol: CompilerSymbol | undefined,
): Promise<ts.Declaration[] | undefined> => {
  if (symbol === undefined) {
    return undefined;
  }
  const declarations: ts.Declaration[] = [];
  for (const handle of symbol.declarations) {
    const declaration = await handle.resolve();
    if (declaration === undefined) {
      panic("Missing symbol declaration");
    }
    declarations.push(declaration);
  }
  return declarations;
};

const someAsync = async <T>(
  values: readonly T[],
  predicate: (value: T) => boolean | Promise<boolean>,
): Promise<boolean> => {
  for (const value of values) {
    if (await predicate(value)) {
      return true;
    }
  }
  return false;
};

const childrenAsync = async <T>(
  node: ts.Node,
  visit: (child: ts.Node) => Promise<T>,
): Promise<T | undefined> => {
  const children: ts.Node[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  for (const child of children) {
    const value = await visit(child);
    if (value) {
      return value;
    }
  }
  return undefined;
};

const sourceCheckers = new WeakMap<ts.SourceFile, Checker>();
const sourceChecker = (source: ts.SourceFile): Checker =>
  sourceCheckers.get(source) ?? panic("Missing schema introspection checker");

const isCalledAlias = async (
  source: ts.SourceFile,
  member: ts.Expression,
): Promise<boolean> => {
  const checker = sourceChecker(source);
  const expression = transparentExpression(member);
  const parent = transparentExpressionParent(member);
  if (
    ts.isCallExpression(parent) &&
    transparentExpression(parent.expression) === expression
  ) {
    return true;
  }
  const aliasName = assignedIdentifier(expression);
  const symbol =
    aliasName === undefined
      ? undefined
      : await checker.getSymbolAtLocation(aliasName);
  if (symbol === undefined) {
    return false;
  }
  const reachesCall = async (
    current: CompilerSymbol,
    seen: Set<CompilerSymbol>,
  ): Promise<boolean> => {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    let invoked = false;
    const visit = async (node: ts.Node): Promise<void> => {
      if (
        ts.isIdentifier(node) &&
        (await checker.getSymbolAtLocation(node)) === current
      ) {
        const useParent = transparentExpressionParent(node);
        if (
          ts.isCallExpression(useParent) &&
          transparentExpression(useParent.expression) === node
        ) {
          invoked = true;
          return;
        }
        const nextAliasName = assignedIdentifier(node);
        const alias =
          nextAliasName === undefined
            ? undefined
            : await checker.getSymbolAtLocation(nextAliasName);
        if (alias !== undefined && (await reachesCall(alias, seen))) {
          invoked = true;
          return;
        }
      }
      if (!invoked) {
        await childrenAsync(node, visit);
      }
    };
    await someAsync(source.statements, async (statement) => {
      await visit(statement);
      return invoked;
    });
    return invoked;
  };
  return await reachesCall(symbol, new Set());
};

type GlobalConsoleDispatchOptions = {
  node: ts.Expression;
  method: string;
  checker: Checker;
};

const isGlobalConsoleDispatch = async ({
  node,
  method,
  checker,
}: GlobalConsoleDispatchOptions): Promise<boolean> =>
  method === DYNAMIC_CALL &&
  ts.isIdentifier(node) &&
  node.text === "console" &&
  (await checker.getSymbolAtLocation(node)) === undefined;

const nonDatabaseMethodReceiver = (source: ts.SourceFile) => {
  const checker = sourceChecker(source);
  const importedCryptoHash = async (node: ts.Node): Promise<boolean> => {
    const declarations = await declarationsOf(
      await checker.getSymbolAtLocation(node),
    );
    const declaration =
      declarations?.length === 1 ? declarations.at(0) : undefined;
    if (
      declaration === undefined ||
      !ts.isImportSpecifier(declaration) ||
      !ts.isImportDeclaration(declaration.parent.parent.parent) ||
      !ts.isStringLiteralLikeNode(
        declaration.parent.parent.parent.moduleSpecifier,
      )
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
  const typedCollection = async (
    declaration: ts.Declaration,
    method: string,
  ): Promise<boolean> => {
    const typedDeclaration =
      ts.isBindingElement(declaration) &&
      ts.isObjectBindingPattern(declaration.parent)
        ? (
            await declarationsOf(
              await (
                await checker.getTypeAtLocation(declaration.parent)
              ).getProperty(
                (declaration.propertyName ?? declaration.name).getText(source),
              ),
            )
          )?.at(0)
        : declaration;
    return (
      method === "delete" &&
      typedDeclaration !== undefined &&
      (ts.isParameterDeclaration(typedDeclaration) ||
        ts.isPropertySignatureDeclaration(typedDeclaration)) &&
      typedDeclaration.type !== undefined &&
      ts.isTypeReferenceNode(typedDeclaration.type) &&
      ts.isIdentifier(typedDeclaration.type.typeName) &&
      ["Map", "Set", "ReadonlyMap", "ReadonlySet"].includes(
        typedDeclaration.type.typeName.text,
      ) &&
      (await declarationsOf(
        await checker.getSymbolAtLocation(typedDeclaration.type.typeName),
      )) === undefined
    );
  };
  type KnownReceiverOptions = {
    node: ts.Expression;
    method: string;
    seen?: Set<ts.Node>;
  };
  const known = async ({
    node,
    method,
    seen = new Set<ts.Node>(),
  }: KnownReceiverOptions): Promise<boolean> => {
    if (seen.has(node)) {
      return false;
    }
    seen.add(node);
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      return await known({ node: node.expression, method, seen });
    }
    if (method === DYNAMIC_CALL && ts.isObjectLiteralExpression(node)) {
      return node.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          (ts.isArrowFunction(property.initializer) ||
            ts.isFunctionExpression(property.initializer)),
      );
    }
    if (await isGlobalConsoleDispatch({ node, method, checker })) {
      return true;
    }
    const member = await (
      await checker.getTypeAtLocation(node)
    ).getProperty(method);
    if (member !== undefined) {
      const type = await checker.getTypeOfSymbolAtLocation(member, node);
      if (type.isStringLiteralType() || type.isNumberLiteralType()) {
        return true;
      }
    }
    if (ts.isNewExpression(node)) {
      return (
        (method === "delete" &&
          ts.isIdentifier(node.expression) &&
          ["Map", "Set"].includes(node.expression.text) &&
          (await checker.getSymbolAtLocation(node.expression)) === undefined) ||
        (method === "update" &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.getText(source) === "Bun.CryptoHasher")
      );
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      return (
        method === "update" &&
        (await hashFactoryReceiver(node.expression, seen))
      );
    }
    const symbolNode = ts.isPropertyAccessExpression(node) ? node.name : node;
    const declarations = await declarationsOf(
      await checker.getSymbolAtLocation(symbolNode),
    );
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
        (await known({ node: declaration.initializer, method, seen }))
      );
    }
    return await typedCollection(declaration, method);
  };
  const hashFactoryReceiver = async (
    node: ts.Identifier,
    seen: Set<ts.Node>,
  ) => {
    if (await importedCryptoHash(node)) {
      return true;
    }
    const factory = await declarationsOf(
      await checker.getSymbolAtLocation(node),
    );
    const declaration = factory?.length === 1 ? factory.at(0) : undefined;
    return (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      ts.isArrowFunction(declaration.initializer) &&
      !ts.isBlock(declaration.initializer.body) &&
      (await known({
        node: declaration.initializer.body,
        method: "update",
        seen,
      }))
    );
  };
  return known;
};

type InspectImportOptions = {
  node: ts.Node;
  source: ts.SourceFile;
  file: string;
  dependency: (specifier: string, full: boolean) => Promise<void>;
  report: (message: string) => void;
};

const inspectImport = async ({
  node,
  source,
  file,
  dependency,
  report,
}: InspectImportOptions): Promise<void> => {
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteralLikeNode(node.moduleSpecifier) &&
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
    await dependency(
      node.moduleSpecifier.text,
      bindings !== undefined && ts.isNamespaceImport(bindings),
    );
  }
  if (
    ts.isExportDeclaration(node) &&
    !node.isTypeOnly &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLikeNode(node.moduleSpecifier) &&
    (node.exportClause === undefined ||
      !ts.isNamedExports(node.exportClause) ||
      node.exportClause.elements.some((element) => !element.isTypeOnly))
  ) {
    await dependency(
      node.moduleSpecifier.text,
      node.exportClause === undefined,
    );
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    !node.isTypeOnly &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    const expression = node.moduleReference.expression;
    if (ts.isStringLiteralLikeNode(expression)) {
      await dependency(expression.text, true);
    } else {
      report(`unresolved runtime import in ${file}`);
    }
  }
};

const inspectCall = async ({
  node,
  file,
  dependency,
  report,
}: Omit<InspectImportOptions, "source">): Promise<void> => {
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
      if (specifier !== undefined && ts.isStringLiteralLikeNode(specifier)) {
        await dependency(specifier.text, true);
      } else {
        report(`unresolved runtime import in ${file}`);
      }
    }
  }
};

const openIntrospectionCompiler = async (repoRoot: string) => {
  const sources = new Map<string, ts.SourceFile | undefined>();
  const configs = new Map<string, string>();
  const api = new API({
    cwd: repoRoot,
    fs: {
      readFile: (file) => configs.get(file) ?? serverFS.useOS,
      fileExists: (file) => (configs.has(file) ? true : serverFS.useOS),
      directoryExists: serverFS.useOS,
      getAccessibleEntries: serverFS.useOS,
      realpath: (file) =>
        configs.has(file) ? serverFS.identity : serverFS.useOS,
      stat: serverFS.useOS,
      writeFile: serverFS.error,
      removeFile: serverFS.error,
    },
  });
  const resolving = await Result.tryPromise(
    async () => await api.createModuleResolver(RESOLUTION_OPTIONS),
  );
  if (resolving.isErr()) {
    await api.close();
    return panic(
      "Could not open schema introspection resolver",
      resolving.error,
    );
  }
  return {
    resolver: resolving.value,
    sourceOf: async (file: string) => {
      if (sources.has(file)) {
        return sources.get(file);
      }
      const absolute = path.join(repoRoot, file);
      const configPath = path.join(
        repoRoot,
        `tsconfig.__schema-introspection-${sources.size}__.json`,
      );
      configs.set(
        configPath,
        JSON.stringify({
          files: [absolute],
          compilerOptions: { noLib: true, noResolve: true, types: [] },
        }),
      );
      const snapshot = await api.createSnapshot({ openProjects: [configPath] });
      const project =
        snapshot.getConfiguredProject(configPath) ??
        panic("Missing schema introspection project");
      const source =
        (await project.program.getSourceFile(absolute)) ??
        panic(`Missing schema introspection source: ${file}`);
      if (
        (await project.program.getSyntacticDiagnostics([absolute])).length > 0
      ) {
        sources.set(file, undefined);
        return undefined;
      }
      sourceCheckers.set(source, project.checker);
      sources.set(file, source);
      return source;
    },
    close: async () => {
      await api.close();
    },
  };
};

type ValidateSchemaIntrospectionOptions = {
  entries: readonly AllowedFile[];
  repoRoot: string;
};

// Runtime imports and re-exports are followed, including aliases and workspace
// packages. Type-only imports carry no database capability. Third-party code
// is a trust boundary; driver imports are refused rather than traversed.
export const validateSchemaIntrospection = async ({
  entries,
  repoRoot,
}: ValidateSchemaIntrospectionOptions): Promise<string[]> => {
  const problems: string[] = [];
  const compiler = await openIntrospectionCompiler(repoRoot);
  const { resolver } = compiler;
  try {
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
      const walk = async (file: string): Promise<void> => {
        if (visited.has(file)) {
          return;
        }
        visited.add(file);
        const absolute = path.join(repoRoot, file);
        const source = await compiler.sourceOf(file);
        if (source === undefined) {
          report(`cannot parse runtime dependency: ${file}`);
          return;
        }
        let knownNonDatabaseReceiver:
          ReturnType<typeof nonDatabaseMethodReceiver> | undefined;
        const dependency = async (
          specifier: string,
          full: boolean,
        ): Promise<void> => {
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
            await walk(target);
            return;
          }
          if (specifier.startsWith("@stll/")) {
            const resolved = (
              await resolver.resolveModuleName(
                specifier,
                path.dirname(absolute),
                undefined,
                {},
              )
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
            await walk(repoRelativePath(repoRoot, resolved.resolvedFileName));
          }
        };
        const inspectMember = async (node: ts.Node): Promise<void> => {
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
              !(await knownNonDatabaseReceiver({
                node: node.expression,
                method: DYNAMIC_CALL,
              }))
            ) {
              report(`unresolved runtime call in ${file}`);
            }
            return;
          }
          if (name === undefined || !isDatabaseOperationMethod(name)) {
            return;
          }
          if (name === "query" && !(await isCalledAlias(source, node))) {
            return;
          }
          if (
            name === "select" &&
            file.startsWith("apps/api/src/db/schema/") &&
            (await isDrizzleViewDefinitionSelect(node, source))
          ) {
            return;
          }
          knownNonDatabaseReceiver ??= nonDatabaseMethodReceiver(source);
          if (
            !(await knownNonDatabaseReceiver({
              node: node.expression,
              method: name,
            }))
          ) {
            report(`database operation in ${file}: ${name}`);
          }
        };
        const visit = async (node: ts.Node): Promise<void> => {
          await inspectImport({ node, source, file, dependency, report });
          await inspectCall({ node, file, dependency, report });
          await inspectMember(node);
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
          await childrenAsync(node, visit);
        };
        await visit(source);
      };
      await walk(entry.path);
      if (fullSchemaImports.size === 0) {
        report(
          "stale schema introspection entry: no full-schema import or re-export",
        );
      }
    }
    return [...new Set(problems)];
  } finally {
    await compiler.close();
  }
};

// Measure path membership rather than list length: removing one entry cannot
// fund a different entry. The initial comparison reads the existing schema
// owners' exceptions from the base tree, without evaluating either registry.
export const schemaIntrospectionPaths = (content: string): string[] => {
  const parsed = parseSource("ownership.ts", content);
  const paths = new Set<string>();
  const property = (object: ObjectExpression, name: string) =>
    object.properties.find(
      (node) =>
        node.type === "Property" &&
        node.key.type === "Identifier" &&
        node.key.name === name,
    );
  const valueOf = (object: ObjectExpression, name: string) => {
    const entry = property(object, name);
    return entry?.type === "Property" ? entry.value : undefined;
  };
  const literalString = (node: Node | undefined): string | undefined => {
    if (node?.type === "Literal" && typeof node.value === "string") {
      return node.value;
    }
    if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
      return node.quasis.at(0)?.value.cooked ?? undefined;
    }
    return undefined;
  };
  const collectPaths = (node: Node): void => {
    walkSyntax(node, (child) => {
      if (child.type !== "ObjectExpression") {
        return;
      }
      const value = literalString(valueOf(child, "path"));
      if (value !== undefined && !value.endsWith("/")) {
        paths.add(value);
      }
    });
  };
  let shared: Node | undefined;
  walkSyntax(parsed.program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "SCHEMA_INTROSPECTION"
    ) {
      shared = node.init ?? undefined;
    }
  });
  if (shared !== undefined) {
    while (
      shared.type === "TSAsExpression" ||
      shared.type === "TSSatisfiesExpression" ||
      shared.type === "ParenthesizedExpression"
    ) {
      shared = shared.expression;
    }
    if (shared.type !== "ArrayExpression") {
      panic(
        "SCHEMA_INTROSPECTION must be a literal array for membership measurement",
      );
    }
    for (const item of shared.elements) {
      if (item?.type !== "ObjectExpression") {
        panic("SCHEMA_INTROSPECTION entries must be literal objects");
      }
      const value = literalString(valueOf(item, "path"));
      if (value === undefined) {
        panic("SCHEMA_INTROSPECTION paths must be literal strings");
      }
      paths.add(value);
    }
    return [...paths];
  }
  walkSyntax(parsed.program, (node) => {
    if (node.type !== "ObjectExpression") {
      return;
    }
    const specifiers = valueOf(node, "specifiers");
    const allowed = valueOf(node, "allowed");
    if (
      literalString(valueOf(node, "kind")) !== "import" ||
      specifiers?.type !== "ArrayExpression" ||
      allowed === undefined
    ) {
      return;
    }
    if (
      specifiers.elements.some((specifier) => {
        const value = literalString(specifier ?? undefined);
        if (value === undefined) {
          return false;
        }
        const module = canonicalModuleId(value, `${FULL_SCHEMA}.ts`);
        return module === FULL_SCHEMA || module.startsWith(`${FULL_SCHEMA}/`);
      })
    ) {
      collectPaths(allowed);
    }
  });
  return [...paths];
};
