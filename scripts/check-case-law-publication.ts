import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const lastSqlToken = (text: string, pattern: RegExp): number =>
  Math.max(
    -1,
    ...[...text.matchAll(pattern)].map((match) => match.index ?? -1),
  );

const hasIdentifier = (node: ts.Node, name: string): boolean => {
  if (ts.isIdentifier(node) && node.text === name) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found) {
      found = hasIdentifier(child, name);
    }
  });
  return found;
};

const ROOT = path.resolve(import.meta.dir, "..");
const OWNER_MODULES = new Set([
  "@/api/lib/case-law/published-decisions",
  "@/api/lib/case-law/published-decisions-sql",
]);
const SUBJECT = "@/api/lib/case-law/public-subject";
const PUBLIC_DB = "@/api/lib/case-law-public-read-db";
const PREDICATES = new Set([
  "publishedCaseLawDecision",
  "publishedCaseLawDecisionFor",
  "publishedCaseLawDecisionSqlFor",
]);
const READ_CONNECTION_TYPES = new Set([
  "CaseLawPublicReadDb",
  "CaseLawPublicReadTransaction",
]);
export const SELECT_VISIBILITY_PROJECTIONS = new Map([
  [
    "apps/api/src/handlers/case-law/decisions/citation-graph.ts",
    {
      properties: new Set(["visible", "count"]),
      reason:
        "Citation graph rows and timeline counts project visibility gates for each related decision.",
    },
  ],
  [
    "apps/api/src/handlers/case-law/decisions/citations.ts",
    {
      properties: new Set(["visible"]),
      reason:
        "The citation page projects target visibility before shaping the public page.",
    },
  ],
  [
    "apps/api/src/handlers/case-law/decisions/search.ts",
    {
      properties: new Set(["row"]),
      reason:
        "The rehydration query returns a nullable row from the separately filtered eligible relation alongside requested ids.",
    },
  ],
  [
    "apps/api/src/lib/case-law/public-subject.ts",
    {
      properties: new Set(["published"]),
      reason:
        "The subject lookup projects publication eligibility so its caller can decide whether to expose that row.",
    },
  ],
  [
    "apps/api/src/lib/legal-search/corpus-index-provider.ts",
    {
      properties: new Set(["row"]),
      reason:
        "The rehydration query returns a nullable row from the separately filtered eligible relation alongside requested ids.",
    },
  ],
]);
const MAINTENANCE_WRITE_SQL = new Map([
  [
    "apps/api/src/lib/legal-search/case-law-search-index.ts",
    {
      table: "case_law_search_backfill_failures",
      reason:
        "Retry ledger statements record maintenance state without returning public decision content.",
    },
  ],
]);
const MAINTENANCE_TARGET_ENUMERATION = new Map([
  [
    "apps/api/src/handlers/case-law/citation-authority.ts",
    new Map([
      [
        "d",
        "The batch enumerates all rows whose derived citation counters must be reset; publication applies to the citing side only.",
      ],
    ]),
  ],
]);

const moduleId = (file: string, specifier: string): string | null => {
  if (specifier.startsWith("@/api/")) {
    return `apps/api/src/${specifier.slice("@/api/".length)}`;
  }
  if (specifier.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(file), specifier),
    );
  }
  return null;
};

const modulePath = (module: string): string =>
  module.startsWith("apps/api/src/") ? module.replace(/\.ts$/u, "") : module;

const isOwnerModule = (file: string, specifier: string): boolean => {
  const resolved = moduleId(file, specifier);
  return (
    resolved !== null &&
    OWNER_MODULES.has(
      `@/api/${modulePath(resolved).replace("apps/api/src/", "")}`,
    )
  );
};

const exportedOwnerBindings = (
  files: readonly SourceInput[],
  trees: ReadonlyMap<string, ts.SourceFile>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const exportsByModule = new Map<string, Set<string>>();
  for (const { file } of files) {
    const tree = trees.get(file);
    if (!tree) {
      continue;
    }
    const localOwners = new Set<string>();
    for (const statement of tree.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      if (!isOwnerModule(file, statement.moduleSpecifier.text)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) {
          if (PREDICATES.has((item.propertyName ?? item.name).text)) {
            localOwners.add(item.name.text);
          }
        }
      }
    }
    const exposed = new Set<string>();
    const exported = (node: ts.Node): boolean => {
      let current: ts.Node | undefined = node;
      while (current && !ts.isSourceFile(current)) {
        if (
          ts.canHaveModifiers(current) &&
          ts
            .getModifiers(current)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        exported(node.parent.parent) &&
        isGuaranteedOwnerExpression(node.initializer, localOwners)
      ) {
        exposed.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    if (localOwners.size > 0) {
      visit(tree);
    }
    for (const statement of tree.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        isOwnerModule(file, statement.moduleSpecifier.text) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const item of statement.exportClause.elements) {
          if (PREDICATES.has((item.propertyName ?? item.name).text)) {
            exposed.add(item.name.text);
          }
        }
      }
    }
    exportsByModule.set(modulePath(file), exposed);
  }
  return exportsByModule;
};

const isGuaranteedOwnerExpression = (
  node: ts.Node,
  names: ReadonlySet<string>,
): boolean => {
  if (ts.isIdentifier(node)) {
    return names.has(node.text);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    let name = "";
    if (ts.isIdentifier(callee)) {
      name = callee.text;
    } else if (ts.isPropertyAccessExpression(callee)) {
      name = callee.name.text;
    }
    if (names.has(name)) {
      return true;
    }
    if (name === "or" || name === "raw") {
      return (
        node.arguments.length > 0 &&
        node.arguments.every((argument) =>
          isGuaranteedOwnerExpression(argument, names),
        )
      );
    }
    return (
      (name === "sql" || name === "and") &&
      node.arguments.some((argument) =>
        isGuaranteedOwnerExpression(argument, names),
      )
    );
  }
  if (ts.isTaggedTemplateExpression(node)) {
    if (node.template.kind !== ts.SyntaxKind.TemplateExpression) {
      return false;
    }
    let prefix = node.template.head.text;
    let guaranteed = false;
    for (const span of node.template.templateSpans) {
      if (isGuaranteedOwnerExpression(span.expression, names)) {
        const filter = lastSqlToken(prefix, /\b(?:where|on|and)\b/giu);
        const clause = lastSqlToken(prefix, /\b(?:select|from)\b/giu);
        guaranteed =
          filter > clause &&
          !/\bor\b/iu.test(
            span.literal.text
              .split(/\b(?:select|from|where|group|order|returning)\b/iu)
              .at(0) ?? "",
          );
      }
      prefix += span.literal.text;
    }
    return guaranteed;
  }
  return false;
};

type SourceInput = { file: string; source: string };
type PublicationCensus = { reads: string[]; errors: string[] };
type ReadSite = { node: ts.Node; line: number; text: string };

const importNames = (
  tree: ts.SourceFile,
  module: string,
): Map<string, string> => {
  const names = new Map<string, string>();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const item of statement.importClause.namedBindings.elements) {
      names.set(item.name.text, (item.propertyName ?? item.name).text);
    }
  }
  return names;
};

const readExpression = (node: ts.Node): ts.Node => {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "where"
    ) {
      return current;
    }
    current = current.parent;
  }
  let root = node;
  while (
    root.parent !== undefined &&
    (ts.isCallExpression(root.parent) ||
      ts.isPropertyAccessExpression(root.parent) ||
      ts.isAwaitExpression(root.parent) ||
      ts.isParenthesizedExpression(root.parent))
  ) {
    root = root.parent;
  }
  return root;
};

type OwnerResolver = {
  usesOwner: (node: ts.Node) => boolean;
  hasOwnerAlias: (node: ts.Node, alias: string) => boolean;
  hasOwnerProjection: (node: ts.Node) => boolean;
  hasRelationalWhereOwner: (node: ts.Node) => boolean;
  rawFilterOwners: (node: ts.Node) => ts.Node[];
};

const createOwnerResolver = (
  file: string,
  tree: ts.SourceFile,
  predicateLocals: ReadonlySet<string>,
): OwnerResolver => {
  const initializers = new Map<ts.Node, Map<string, ts.Node>>();
  const scopeOf = (node: ts.Node): ts.Node => {
    let current: ts.Node = node;
    while (!ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
      current = current.parent;
    }
    return current;
  };
  const collectInitializers = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const scope = scopeOf(node);
      const values = initializers.get(scope) ?? new Map<string, ts.Node>();
      values.set(node.name.text, node.initializer);
      initializers.set(scope, values);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      let scope: ts.Node = node.parent;
      while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) {
        scope = scope.parent;
      }
      const values = initializers.get(scope) ?? new Map<string, ts.Node>();
      values.set(node.name.text, node.body);
      initializers.set(scope, values);
    }
    ts.forEachChild(node, collectInitializers);
  };
  collectInitializers(tree);
  const scopesOf = (node: ts.Node): ts.Node[] => {
    const scopes: ts.Node[] = [];
    let scope: ts.Node | undefined = scopeOf(node);
    while (scope !== undefined) {
      scopes.push(scope);
      let parent: ts.Node | undefined = scope.parent;
      while (
        parent !== undefined &&
        !ts.isSourceFile(parent) &&
        !ts.isFunctionLike(parent)
      ) {
        parent = parent.parent;
      }
      scope = parent;
    }
    return scopes;
  };
  const resolves = (
    node: ts.Node,
    matches: (current: ts.Node) => boolean,
  ): boolean => {
    const visited = new Set<string>();
    const visit = (current: ts.Node): boolean => {
      if (matches(current)) {
        return true;
      }
      if (ts.isIdentifier(current)) {
        for (const scope of scopesOf(current)) {
          const key = `${scope.pos}:${current.text}`;
          if (visited.has(key)) {
            continue;
          }
          visited.add(key);
          const initializer = initializers.get(scope)?.get(current.text);
          if (initializer && visit(initializer)) {
            return true;
          }
        }
      }
      let found = false;
      ts.forEachChild(current, (child) => {
        if (!found) {
          found = visit(child);
        }
      });
      return found;
    };
    return visit(node);
  };
  const usesOwner = (node: ts.Node): boolean => {
    const visited = new Set<string>();
    const visit = (current: ts.Node): boolean => {
      if (ts.isConditionalExpression(current)) {
        return visit(current.whenTrue) && visit(current.whenFalse);
      }
      if (
        ts.isPrefixUnaryExpression(current) &&
        current.operator === ts.SyntaxKind.ExclamationToken
      ) {
        return false;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        current.expression.text === "or"
      ) {
        return current.arguments.length > 0 && current.arguments.every(visit);
      }
      if (ts.isIdentifier(current) && predicateLocals.has(current.text)) {
        return true;
      }
      if (ts.isIdentifier(current)) {
        for (const scope of scopesOf(current)) {
          const key = `${scope.pos}:${current.text}`;
          if (visited.has(key)) {
            continue;
          }
          visited.add(key);
          const initializer = initializers.get(scope)?.get(current.text);
          if (initializer && visit(initializer)) {
            return true;
          }
        }
      }
      let found = false;
      ts.forEachChild(current, (child) => {
        if (!found) {
          found = visit(child);
        }
      });
      return found;
    };
    return visit(node);
  };
  const hasOwnerAlias = (node: ts.Node, alias: string): boolean =>
    resolves(
      node,
      (current) =>
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        predicateLocals.has(current.expression.text) &&
        current.arguments.some(
          (argument) => ts.isStringLiteral(argument) && argument.text === alias,
        ),
    );
  return {
    usesOwner,
    hasOwnerAlias,
    ...createOwnerQueryChecks({ file, tree, predicateLocals, usesOwner }),
  };
};

type OwnerQueryChecksOptions = {
  file: string;
  tree: ts.SourceFile;
  predicateLocals: ReadonlySet<string>;
  usesOwner: (node: ts.Node) => boolean;
};

const createOwnerQueryChecks = ({
  file,
  tree,
  predicateLocals,
  usesOwner,
}: OwnerQueryChecksOptions) => {
  const hasOwnerProjection = (node: ts.Node): boolean => {
    const permitted = SELECT_VISIBILITY_PROJECTIONS.get(file)?.properties;
    if (!permitted) {
      return false;
    }
    if (permitted.has("row")) {
      return hasEligibleRehydration(tree, node, usesOwner);
    }
    let found = false;
    const visit = (current: ts.Node): void => {
      if (found) {
        return;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === "select"
      ) {
        const argument = current.arguments[0];
        if (argument && ts.isObjectLiteralExpression(argument)) {
          found = argument.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name &&
              permitted.has(
                property.name.getText(tree).replaceAll(/["']/gu, ""),
              ) &&
              usesOwner(property.initializer),
          );
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  };
  const hasRelationalWhereOwner = (node: ts.Node): boolean => {
    let found = false;
    const visit = (current: ts.Node): void => {
      if (found) {
        return;
      }
      if (
        ts.isPropertyAssignment(current) &&
        current.name.getText(tree).replaceAll(/["']/gu, "") === "where"
      ) {
        found = usesOwner(current.initializer);
      }
      if (!found) {
        ts.forEachChild(current, visit);
      }
    };
    visit(node);
    return found;
  };
  const rawFilterOwners = (node: ts.Node): ts.Node[] => {
    const owners: ts.Node[] = [];
    const visit = (current: ts.Node): void => {
      if (
        ts.isTaggedTemplateExpression(current) &&
        ts.isTemplateExpression(current.template)
      ) {
        let prefix = current.template.head.text;
        for (const span of current.template.templateSpans) {
          const filterAt = lastSqlToken(prefix, /\b(?:where|on|and)\b/giu);
          const clauseAt = lastSqlToken(prefix, /\b(?:select|from)\b/giu);
          const ownerContext =
            filterAt > clauseAt &&
            lastSqlToken(prefix.slice(clauseAt + 1), /\bor\b/giu) < 0 &&
            !/\bnot\s*\(?\s*$/iu.test(prefix) &&
            !/\bor\b/iu.test(
              span.literal.text
                .split(/\b(?:select|from|where|group|order|returning)\b/iu)
                .at(0) ?? "",
            );
          const joined =
            ts.isIdentifier(span.expression) &&
            predicateLocals.has(span.expression.text) &&
            span.expression.text.toLowerCase().includes("join");
          if (usesOwner(span.expression) && (ownerContext || joined)) {
            owners.push(span.expression);
          }
          prefix += span.literal.text;
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return owners;
  };
  return { hasOwnerProjection, hasRelationalWhereOwner, rawFilterOwners };
};

const hasEligibleRehydration = (
  tree: ts.SourceFile,
  node: ts.Node,
  usesOwner: (node: ts.Node) => boolean,
): boolean => {
  const selectCalls: ts.CallExpression[] = [];
  const joins: string[] = [];
  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression)
    ) {
      if (current.expression.name.text === "select") {
        selectCalls.push(current);
      }
      if (
        current.expression.name.text === "leftJoin" &&
        current.arguments[0] &&
        ts.isIdentifier(current.arguments[0])
      ) {
        joins.push(current.arguments[0].text);
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return selectCalls.some((call) => {
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      return false;
    }
    const properties = arg.properties.filter(ts.isPropertyAssignment);
    const row = properties.find(
      (property) =>
        property.name.getText(tree).replaceAll(/["']/gu, "") === "row",
    );
    if (
      !row ||
      properties.length !== 2 ||
      !properties.some(
        (property) =>
          property.name.getText(tree).replaceAll(/["']/gu, "") === "id",
      )
    ) {
      return false;
    }
    const initializer = row.initializer;
    return (
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === "getColumns" &&
      initializer.arguments.some(
        (argument) =>
          ts.isIdentifier(argument) &&
          joins.includes(argument.text) &&
          usesOwner(argument),
      )
    );
  });
};

const discoverDecisionReadSites = (
  tree: ts.SourceFile,
  decisionTables: ReadonlySet<string>,
  hasNamespacedDecision: (node: ts.Node) => boolean,
): ReadSite[] => {
  const sites: ReadSite[] = [];
  const seen = new Set<number>();
  const addSite = (node: ts.Node): void => {
    const start = node.getStart(tree);
    if (seen.has(start)) {
      return;
    }
    seen.add(start);
    const expression = readExpression(node);
    sites.push({
      node: expression,
      line: tree.getLineAndCharacterOfPosition(start).line + 1,
      text: expression.getText(tree),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let method = "";
      if (ts.isPropertyAccessExpression(node.expression)) {
        method = node.expression.name.text;
      }
      if (
        (method === "from" || method.endsWith("Join")) &&
        node.arguments.some(
          (argument) =>
            (ts.isIdentifier(argument) && decisionTables.has(argument.text)) ||
            hasNamespacedDecision(argument),
        )
      ) {
        addSite(node);
      }
      if (
        (method === "findFirst" || method === "findMany") &&
        node.expression.getText(tree).includes("caseLawDecisions")
      ) {
        addSite(node);
      }
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      /\b(?:from|join)\s+case_law_decisions\b/iu.test(
        node.template.getText(tree),
      )
    ) {
      addSite(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return sites;
};

type FileCensusContext = {
  file: string;
  tree: ts.SourceFile;
  predicateLocals: Set<string>;
  importedJoinAliases: Map<string, string>;
  decisionTables: Set<string>;
  hasNamespacedDecision: (node: ts.Node) => boolean;
};

const createFileCensusContext = (
  file: string,
  tree: ts.SourceFile,
  ownerExports: ReadonlyMap<string, ReadonlySet<string>>,
  ownerJoinAliases: ReadonlyMap<string, string>,
): FileCensusContext | null => {
  const subjectImports = importNames(tree, SUBJECT);
  const dbImports = importNames(tree, PUBLIC_DB);
  const schemaImports = importNames(tree, "@/api/db/schema");
  const decisionTables = new Set(
    [...schemaImports]
      .filter(([, imported]) => imported === "caseLawDecisions")
      .map(([local]) => local),
  );
  const schemaNamespaces = new Set(
    tree.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/api/db/schema" &&
      statement.importClause?.namedBindings &&
      ts.isNamespaceImport(statement.importClause.namedBindings)
        ? [statement.importClause.namedBindings.name.text]
        : [],
    ),
  );
  const hasNamespacedDecision = (node: ts.Node): boolean => {
    let found = false;
    const visit = (current: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(current) &&
        current.name.text === "caseLawDecisions" &&
        ts.isIdentifier(current.expression) &&
        schemaNamespaces.has(current.expression.text)
      ) {
        found = true;
      }
      if (!found) {
        ts.forEachChild(current, visit);
      }
    };
    visit(node);
    return found;
  };
  const predicateLocals = new Set<string>();
  const importedJoinAliases = new Map<string, string>();
  for (const statement of tree.statements) {
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
    const resolved = moduleId(file, statement.moduleSpecifier.text);
    let ownerNames: ReadonlySet<string> = new Set<string>();
    if (isOwnerModule(file, statement.moduleSpecifier.text)) {
      ownerNames = PREDICATES;
    } else if (resolved !== null) {
      ownerNames = ownerExports.get(modulePath(resolved)) ?? new Set<string>();
    }
    for (const item of bindings.elements) {
      const imported = (item.propertyName ?? item.name).text;
      if (ownerNames.has(imported)) {
        predicateLocals.add(item.name.text);
      }
      if (resolved !== null) {
        const alias = ownerJoinAliases.get(
          `${modulePath(resolved)}:${imported}`,
        );
        if (alias !== undefined) {
          importedJoinAliases.set(item.name.text, alias);
        }
      }
    }
  }
  const hasSubjectScope = [...subjectImports.values()].some(
    (name) =>
      name.startsWith("with") ||
      name.startsWith("resolve") ||
      name.endsWith("Subject"),
  );
  const publicReadModule =
    [...dbImports.values()].some(
      (name) =>
        READ_CONNECTION_TYPES.has(name) || name === "caseLawPublicReadDb",
    ) ||
    hasSubjectScope ||
    predicateLocals.size > 0;
  if (!publicReadModule) {
    return null;
  }
  const visitAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "alias" &&
      node.initializer.arguments.some(
        (arg) =>
          (ts.isIdentifier(arg) && decisionTables.has(arg.text)) ||
          hasNamespacedDecision(arg),
      )
    ) {
      decisionTables.add(node.name.text);
    }
    ts.forEachChild(node, visitAliases);
  };
  visitAliases(tree);
  return {
    file,
    tree,
    predicateLocals,
    importedJoinAliases,
    decisionTables,
    hasNamespacedDecision,
  };
};

const inspectFileReads = (context: FileCensusContext): PublicationCensus => {
  const {
    file,
    tree,
    predicateLocals,
    importedJoinAliases,
    decisionTables,
    hasNamespacedDecision,
  } = context;
  const resolver = createOwnerResolver(file, tree, predicateLocals);
  const sites = discoverDecisionReadSites(
    tree,
    decisionTables,
    hasNamespacedDecision,
  );
  const reads: string[] = [];
  const errors: string[] = [];
  for (const site of sites) {
    const whereNodes: ts.Node[] = [];
    const visitWhere = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "where"
      ) {
        whereNodes.push(node);
      }
      ts.forEachChild(node, visitWhere);
    };
    visitWhere(site.node);
    const rawQuery = site.node.getText(tree);
    const rawFilters = resolver.rawFilterOwners(site.node);
    const joinedAliases = [...importedJoinAliases]
      .filter(([name]) =>
        rawFilters.some((filter) => hasIdentifier(filter, name)),
      )
      .map(([, alias]) => alias);
    const aliases = [
      ...rawQuery.matchAll(
        /\b(?:from|join)\s+case_law_decisions\s+(?:as\s+)?([a-z_][\w$]*)/giu,
      ),
    ]
      .map((match) => match[1])
      .filter((alias) => alias !== undefined);
    const maintenanceWrite =
      MAINTENANCE_WRITE_SQL.has(file) &&
      rawQuery.includes(
        `INSERT INTO ${MAINTENANCE_WRITE_SQL.get(file)?.table ?? ""}`,
      );
    const hasOwner =
      whereNodes.some((where) =>
        resolver.usesOwner(where.arguments[0] ?? where),
      ) ||
      resolver.hasRelationalWhereOwner(site.node) ||
      rawFilters.length > 0 ||
      joinedAliases.length > 0 ||
      resolver.hasOwnerProjection(site.node);
    const allowedMaintenanceAliases = MAINTENANCE_TARGET_ENUMERATION.get(file);
    const everyAliasOwned = aliases.every(
      (alias) =>
        rawFilters.some((filter) => resolver.hasOwnerAlias(filter, alias)) ||
        joinedAliases.includes(alias) ||
        allowedMaintenanceAliases?.has(alias),
    );
    const label = `${file}:${site.line}`;
    reads.push(label);
    if (!maintenanceWrite && (!hasOwner || !everyAliasOwned)) {
      errors.push(
        `${label}: decision read has no publication owner predicate in its query expression`,
      );
    }
  }
  return { reads, errors };
};

export const inspectCaseLawPublication = (
  files: readonly SourceInput[],
): PublicationCensus => {
  const trees = new Map(
    files.map(({ file, source }) => [
      file,
      ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true),
    ]),
  );
  const ownerExports = exportedOwnerBindings(files, trees);
  const ownerJoinAliases = findOwnerJoinAliases(files, ownerExports);
  const reads: string[] = [];
  const errors: string[] = [];
  for (const { file } of files) {
    if (!isCensusSource(file)) {
      continue;
    }
    const tree = trees.get(file);
    if (!tree) {
      continue;
    }
    const context = createFileCensusContext(
      file,
      tree,
      ownerExports,
      ownerJoinAliases,
    );
    if (!context) {
      continue;
    }
    const report = inspectFileReads(context);
    reads.push(...report.reads);
    errors.push(...report.errors);
  }
  reads.sort();
  errors.sort();
  return { reads, errors };
};

const isCensusSource = (file: string): boolean =>
  file.startsWith("apps/api/src/") &&
  !file.startsWith("apps/api/src/scripts/") &&
  !file.startsWith("apps/api/src/tests/") &&
  !file.endsWith(".test.ts") &&
  !file.endsWith(".db.test.ts");

const findOwnerJoinAliases = (
  files: readonly SourceInput[],
  ownerExports: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, string> => {
  const aliases = new Map<string, string>();
  for (const { file, source } of files) {
    for (const name of ownerExports.get(modulePath(file)) ?? []) {
      const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const match = new RegExp(
        `export\\s+const\\s+${escaped}\\b[\\s\\S]{0,1600}?publishedCaseLawDecisionSqlFor\\s*\\(\\s*["']([^"']+)["']`,
        "u",
      ).exec(source);
      if (match?.[1]) {
        aliases.set(`${modulePath(file)}:${name}`, match[1]);
      }
    }
  }
  return aliases;
};

const EXCEPTION_MAPS = new Set([
  "SELECT_VISIBILITY_PROJECTIONS",
  "MAINTENANCE_WRITE_SQL",
  "MAINTENANCE_TARGET_ENUMERATION",
]);

export const publicationExceptionKeys = (
  source: string,
): ReadonlySet<string> => {
  const tree = ts.createSourceFile(
    "policy.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const keys = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      EXCEPTION_MAPS.has(node.name.text) &&
      node.initializer &&
      ts.isNewExpression(node.initializer)
    ) {
      const entries = node.initializer.arguments?.at(0);
      if (!entries || !ts.isArrayLiteralExpression(entries)) {
        panic("Publication exceptions must be literal map entries");
      }
      for (const entry of entries.elements) {
        if (!ts.isArrayLiteralExpression(entry)) {
          panic("Publication exception must be a literal entry");
        }
        const file = entry.elements.at(0);
        if (!file || !ts.isStringLiteral(file)) {
          panic("Publication exception must name its owning file");
        }
        const collect = (child: ts.Node): void => {
          if (
            ts.isPropertyAssignment(child) &&
            child.name.getText(tree) === "reason"
          ) {
            return;
          }
          if (ts.isStringLiteral(child) && !/\s/u.test(child.text)) {
            keys.add(`${node.name.getText(tree)}:${file.text}:${child.text}`);
          }
          ts.forEachChild(child, collect);
        };
        collect(entry);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return keys;
};

export const publicationExceptionGrowth = (
  current: string,
  previous: string,
): string[] => {
  const before = publicationExceptionKeys(previous);
  return [...publicationExceptionKeys(current)].filter(
    (key) => !before.has(key),
  );
};

export const checkExceptionHistory = (): void => {
  const base = Bun.spawnSync(["git", "merge-base", "HEAD", "origin/main"], {
    cwd: ROOT,
  });
  if (!base.success) {
    panic("Cannot resolve publication exception baseline");
  }
  const policyPath = "scripts/check-case-law-publication.ts";
  const baseRef = base.stdout.toString().trim();
  const present = Bun.spawnSync(
    ["git", "ls-tree", "--name-only", baseRef, "--", policyPath],
    { cwd: ROOT },
  );
  if (!present.success) {
    panic("Cannot inspect publication exception baseline");
  }
  if (present.stdout.toString().trim() === "") {
    return;
  } // The initial guard establishes the reviewed exception baseline.
  const baseline = Bun.spawnSync(["git", "show", `${baseRef}:${policyPath}`], {
    cwd: ROOT,
  });
  if (!baseline.success) {
    panic("Cannot read publication exception baseline");
  }
  const growth = publicationExceptionGrowth(
    readFileSync(path.join(ROOT, policyPath), "utf-8"),
    baseline.stdout.toString(),
  );
  if (growth.length > 0) {
    panic(`Publication exceptions may only shrink: ${growth.join(", ")}`);
  }
};

export const trackedApiSources = (): SourceInput[] => {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--", "apps/api/src"],
    { cwd: ROOT },
  );
  if (!result.success) {
    panic(
      `git ls-files failed; cannot enumerate API sources: ${result.stderr.toString()}`,
    );
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .map((file) => ({
      file,
      source: readFileSync(path.join(ROOT, file), "utf-8"),
    }));
};

if (import.meta.main) {
  checkExceptionHistory();
  const report = inspectCaseLawPublication(trackedApiSources());
  if (report.errors.length > 0) {
    console.error(report.errors.join("\n"));
    process.exit(1);
  }
  console.log(
    `Public case-law publication census: ${report.reads.length} decision-read operations`,
  );
  for (const read of report.reads) {
    console.log(`  ${read}`);
  }
}
