import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { positiveSqlConjunctInterpolations } from "./case-law-publication-conjuncts";
import {
  CASE_LAW_DECISION_TABLE,
  createDecisionTableResolver,
} from "./case-law-publication-tables";

const lastSqlToken = (text: string, pattern: RegExp): number =>
  Math.max(-1, ...[...text.matchAll(pattern)].map((match) => match.index));

const SQL_RELATION_BOUNDARIES = new Set([
  "WHERE",
  "JOIN",
  "ON",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "INNER",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "GROUP",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "FOR",
  "HAVING",
  "WINDOW",
  "RETURNING",
]);

const rawDecisionAliases = (query: string): string[] =>
  [
    ...query.matchAll(
      /\b(?:from|join)\s+case_law_decisions\b(?:\s+(?:as\s+)?("[^"]+"|[a-z_][\w$]*))?/giu,
    ),
  ].map((match) => {
    const alias = match.at(1);
    if (
      alias === undefined ||
      SQL_RELATION_BOUNDARIES.has(alias.toUpperCase())
    ) {
      return CASE_LAW_DECISION_TABLE;
    }
    return alias.startsWith('"') ? alias.slice(1, -1) : alias.toLowerCase();
  });

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
      let current = node;
      while (!ts.isSourceFile(current)) {
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
        (isOwnerConjunct({
          node: node.initializer,
          names: localOwners,
          andNames: drizzleOperatorNames(tree, "and"),
          sqlNames: drizzleOperatorNames(tree, "sql"),
        }) ||
          (ts.isTaggedTemplateExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.tag) &&
            drizzleOperatorNames(tree, "sql").has(node.initializer.tag.text) &&
            ts.isTemplateExpression(node.initializer.template) &&
            positiveSqlConjunctInterpolations(node.initializer.template).some(
              (expression) =>
                isOwnerConjunct({
                  node: expression,
                  names: localOwners,
                  andNames: drizzleOperatorNames(tree, "and"),
                  sqlNames: drizzleOperatorNames(tree, "sql"),
                }),
            )))
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

type OwnerConjunctOptions = {
  node: ts.Node;
  names: ReadonlySet<string>;
  andNames: ReadonlySet<string>;
  sqlNames: ReadonlySet<string>;
  resolveName?: (node: ts.Identifier) => ts.Node | undefined;
  alias?: string;
  table?: string;
  tableOf?: (node: ts.Node) => string | undefined;
  constantTables?: ReadonlyMap<string, string>;
};

const isOwnerConjunct = ({
  node,
  names,
  andNames,
  sqlNames,
  resolveName,
  alias,
  table,
  tableOf,
  constantTables,
}: OwnerConjunctOptions): boolean => {
  const visited = new Set<ts.Node>();
  const matchesOwnerCall = (current: ts.CallExpression): boolean => {
    if (table !== undefined) {
      const target = current.arguments.at(0);
      return target !== undefined && tableOf?.(target) === table;
    }
    return (
      alias === undefined ||
      current.arguments.some(
        (argument) => ts.isStringLiteral(argument) && argument.text === alias,
      )
    );
  };
  const visit = (current: ts.Node): boolean => {
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    if (ts.isParenthesizedExpression(current)) {
      return visit(current.expression);
    }
    if (ts.isIdentifier(current)) {
      if (names.has(current.text)) {
        return (
          alias === undefined &&
          (table === undefined || constantTables?.get(current.text) === table)
        );
      }
      const initializer = resolveName?.(current);
      return initializer !== undefined && visit(initializer);
    }
    if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression)) {
        if (names.has(current.expression.text)) {
          return matchesOwnerCall(current);
        }
        return (
          andNames.has(current.expression.text) && current.arguments.some(visit)
        );
      }
      return (
        ts.isPropertyAccessExpression(current.expression) &&
        ts.isIdentifier(current.expression.expression) &&
        sqlNames.has(current.expression.expression.text) &&
        current.expression.name.text === "raw" &&
        current.arguments.length === 1 &&
        current.arguments.some(visit)
      );
    }
    if (
      !ts.isTaggedTemplateExpression(current) ||
      !ts.isIdentifier(current.tag) ||
      !sqlNames.has(current.tag.text) ||
      !ts.isTemplateExpression(current.template)
    ) {
      return false;
    }
    const spans = current.template.templateSpans;
    if (!/^\s*$/u.test(current.template.head.text)) {
      return false;
    }
    for (const [index, span] of spans.entries()) {
      if (
        index === spans.length - 1
          ? !/^\s*$/u.test(span.literal.text)
          : !/^\s*AND\s*$/iu.test(span.literal.text)
      ) {
        return false;
      }
    }
    return spans.some((span) => visit(span.expression));
  };
  return visit(node);
};

const drizzleOperatorNames = (
  tree: ts.SourceFile,
  imported: string,
): ReadonlySet<string> =>
  new Set(
    [...importNames(tree, "drizzle-orm")]
      .filter(([, name]) => name === imported)
      .map(([local]) => local),
  );

type SourceInput = { file: string; source: string };
type PublicationCensus = { reads: string[]; errors: string[] };
type ReadSite = {
  node: ts.Node;
  line: number;
  text: string;
} & (
  | {
      kind: "builder";
      target: ts.Expression;
      joinCondition: ts.Expression | undefined;
    }
  | { kind: "relational" | "raw" }
);

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
  let root = node;
  while (
    !ts.isSourceFile(root) &&
    ((ts.isCallExpression(root.parent) && root.parent.expression === root) ||
      ts.isPropertyAccessExpression(root.parent) ||
      ts.isAwaitExpression(root.parent) ||
      ts.isParenthesizedExpression(root.parent))
  ) {
    root = root.parent;
  }
  return root;
};

const builderCalls = (node: ts.Node): ts.CallExpression[] => {
  const calls: ts.CallExpression[] = [];
  let current = node;
  while (true) {
    if (
      ts.isAwaitExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (
      !ts.isCallExpression(current) ||
      !ts.isPropertyAccessExpression(current.expression)
    ) {
      return calls;
    }
    calls.push(current);
    current = current.expression.expression;
  }
};

type OwnerResolver = {
  usesOwner: (node: ts.Node) => boolean;
  hasOwnerAlias: (node: ts.Node, alias: string) => boolean;
  hasOwnerTable: (node: ts.Node, table: string) => boolean;
  hasOwnerProjection: (node: ts.Node, table?: string) => boolean;
  hasRelationalWhereOwner: (node: ts.Node) => boolean;
  rawFilterOwners: (node: ts.Node) => ts.Node[];
};

type OwnerResolverOptions = {
  file: string;
  tree: ts.SourceFile;
  predicateLocals: ReadonlySet<string>;
  tableOf: (node: ts.Node) => string | undefined;
};

const createOwnerResolver = ({
  file,
  tree,
  predicateLocals,
  tableOf,
}: OwnerResolverOptions): OwnerResolver => {
  const initializers = new Map<ts.Node, Map<string, ts.Node>>();
  const scopeOf = (node: ts.Node): ts.Node => {
    let current = node;
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
    let scope = scopeOf(node);
    while (true) {
      scopes.push(scope);
      if (ts.isSourceFile(scope)) {
        return scopes;
      }
      scope = scopeOf(scope.parent);
    }
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
  const resolveName = (identifier: ts.Identifier): ts.Node | undefined => {
    for (const scope of scopesOf(identifier)) {
      const initializer = initializers.get(scope)?.get(identifier.text);
      if (initializer) {
        return initializer;
      }
    }
    return undefined;
  };
  const andNames = drizzleOperatorNames(tree, "and");
  const sqlNames = drizzleOperatorNames(tree, "sql");
  const usesOwner = (node: ts.Node): boolean =>
    isOwnerConjunct({
      node,
      names: predicateLocals,
      andNames,
      sqlNames,
      resolveName,
    });
  const hasOwnerAlias = (node: ts.Node, alias: string): boolean =>
    isOwnerConjunct({
      node,
      names: predicateLocals,
      andNames,
      sqlNames,
      resolveName,
      alias,
    });
  const constantTables = new Map<string, string>();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isOwnerModule(file, statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if (
          (item.propertyName ?? item.name).text === "publishedCaseLawDecision"
        ) {
          constantTables.set(item.name.text, CASE_LAW_DECISION_TABLE);
        }
      }
    }
  }
  const hasOwnerTable = (node: ts.Node, table: string): boolean =>
    isOwnerConjunct({
      node,
      names: predicateLocals,
      andNames,
      sqlNames,
      resolveName,
      table,
      tableOf,
      constantTables,
    });

  const hasOwnerEvidence = (node: ts.Node): boolean =>
    resolves(
      node,
      (current) =>
        ts.isIdentifier(current) && predicateLocals.has(current.text),
    );
  const hasFilteredQuery = (node: ts.Node, table?: string): boolean => {
    const visited = new Set<ts.Node>();
    const visit = (current: ts.Node): boolean => {
      if (visited.has(current)) {
        return false;
      }
      visited.add(current);
      if (ts.isIdentifier(current)) {
        const initializer = resolveName(current);
        return initializer !== undefined && visit(initializer);
      }
      if (
        ts.isParenthesizedExpression(current) ||
        ts.isAwaitExpression(current)
      ) {
        return visit(current.expression);
      }
      if (
        !ts.isCallExpression(current) ||
        !ts.isPropertyAccessExpression(current.expression)
      ) {
        return false;
      }
      if (current.expression.name.text === "where") {
        return current.arguments.some((argument) =>
          table === undefined
            ? usesOwner(argument)
            : hasOwnerTable(argument, table),
        );
      }
      return visit(current.expression.expression);
    };
    return visit(node);
  };

  return {
    usesOwner,
    hasOwnerAlias,
    hasOwnerTable,
    ...createOwnerQueryChecks({
      file,
      tree,
      usesOwner,
      hasOwnerEvidence,
      hasFilteredQuery,
      hasOwnerTable,
      tableOf,
    }),
  };
};

type OwnerQueryChecksOptions = {
  file: string;
  tree: ts.SourceFile;
  usesOwner: (node: ts.Node) => boolean;
  hasOwnerEvidence: (node: ts.Node) => boolean;
  hasFilteredQuery: (node: ts.Node, table?: string) => boolean;
  hasOwnerTable: (node: ts.Node, table: string) => boolean;
  tableOf: (node: ts.Node) => string | undefined;
};

const createOwnerQueryChecks = ({
  file,
  tree,
  usesOwner,
  hasOwnerEvidence,
  hasFilteredQuery,
  hasOwnerTable,
  tableOf,
}: OwnerQueryChecksOptions) => {
  const hasOwnerProjection = (node: ts.Node, table?: string): boolean => {
    const permitted = SELECT_VISIBILITY_PROJECTIONS.get(file)?.properties;
    if (!permitted) {
      return false;
    }
    if (permitted.has("row")) {
      return hasEligibleRehydration({
        tree,
        node,
        hasFilteredQuery,
        hasOwnerTable,
        tableOf,
        table,
      });
    }
    return builderCalls(node).some((current) => {
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === "select"
      ) {
        const argument = current.arguments.at(0);
        if (argument && ts.isObjectLiteralExpression(argument)) {
          return argument.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              permitted.has(
                property.name.getText(tree).replaceAll(/["']/gu, ""),
              ) &&
              (table === undefined
                ? hasOwnerEvidence(property.initializer)
                : hasOwnerTable(property.initializer, table)),
          );
        }
      }
      return false;
    });
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
        const filter = current.initializer;
        found = usesOwner(filter);
        if (ts.isObjectLiteralExpression(filter)) {
          found = filter.properties.some((property) => {
            if (
              !ts.isPropertyAssignment(property) ||
              property.name.getText(tree) !== "RAW"
            ) {
              return false;
            }
            const callback = property.initializer;
            return (
              ts.isArrowFunction(callback) &&
              !ts.isBlock(callback.body) &&
              usesOwner(callback.body)
            );
          });
        }
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
        ts.isIdentifier(current.tag) &&
        drizzleOperatorNames(tree, "sql").has(current.tag.text) &&
        ts.isTemplateExpression(current.template)
      ) {
        owners.push(
          ...positiveSqlConjunctInterpolations(current.template).filter(
            usesOwner,
          ),
        );
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return owners;
  };

  return { hasOwnerProjection, hasRelationalWhereOwner, rawFilterOwners };
};

type EligibleRehydrationOptions = Pick<
  OwnerQueryChecksOptions,
  "tree" | "hasFilteredQuery" | "hasOwnerTable" | "tableOf"
> & { node: ts.Node; table: string | undefined };

const hasEligibleRehydration = ({
  tree,
  node,
  hasFilteredQuery,
  hasOwnerTable,
  tableOf,
  table,
}: EligibleRehydrationOptions): boolean => {
  const selectCalls: ts.CallExpression[] = [];
  const joins: { name: string; condition: ts.Expression }[] = [];
  for (const current of builderCalls(node)) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression)
    ) {
      if (current.expression.name.text === "select") {
        selectCalls.push(current);
      }
      const target = current.arguments.at(0);
      const condition = current.arguments.at(1);
      if (
        current.expression.name.text === "leftJoin" &&
        target !== undefined &&
        ts.isIdentifier(target) &&
        condition !== undefined
      ) {
        joins.push({ name: target.text, condition });
      }
    }
  }
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
    const id = properties.find(
      (property) =>
        property.name.getText(tree).replaceAll(/["']/gu, "") === "id",
    )?.initializer;
    if (
      table === undefined ||
      id === undefined ||
      !ts.isPropertyAccessExpression(id) ||
      id.name.text !== "id" ||
      tableOf(id.expression) !== table
    ) {
      return false;
    }
    return (
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === "getColumns" &&
      initializer.arguments.some(
        (argument) =>
          ts.isIdentifier(argument) &&
          joins.some(
            (join) =>
              join.name === argument.text &&
              hasOwnerTable(join.condition, table),
          ) &&
          hasFilteredQuery(argument, table),
      )
    );
  });
};

const discoverDecisionReadSites = (
  tree: ts.SourceFile,
  tableOf: (node: ts.Node) => string | undefined,
): ReadSite[] => {
  const sites: ReadSite[] = [];
  const seen = new Set<ts.Node>();
  const addSite = (
    node: ts.Node,
    details:
      | {
          kind: "builder";
          target: ts.Expression;
          joinCondition: ts.Expression | undefined;
        }
      | { kind: "relational" | "raw" },
  ): void => {
    const start =
      details.kind === "builder"
        ? details.target.getStart(tree)
        : node.getStart(tree);
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    const expression = readExpression(node);
    sites.push({
      node: expression,
      ...details,
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
      const target = node.arguments.at(0);
      if (
        (method === "from" || method.endsWith("Join")) &&
        target !== undefined &&
        tableOf(target) !== undefined
      ) {
        addSite(node, {
          kind: "builder",
          target,
          joinCondition: method === "from" ? undefined : node.arguments.at(1),
        });
      }
      if (
        (method === "findFirst" || method === "findMany") &&
        node.expression.getText(tree).includes("caseLawDecisions")
      ) {
        addSite(node, { kind: "relational" });
      }
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      /\b(?:from|join)\s+case_law_decisions\b/iu.test(
        node.template.getText(tree),
      )
    ) {
      addSite(node, { kind: "raw" });
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
};

const createFileCensusContext = (
  file: string,
  tree: ts.SourceFile,
  ownerExports: ReadonlyMap<string, ReadonlySet<string>>,
  ownerJoinAliases: ReadonlyMap<string, string>,
): FileCensusContext | null => {
  const subjectImports = importNames(tree, SUBJECT);
  const dbImports = importNames(tree, PUBLIC_DB);
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
      const joinAlias =
        resolved === null
          ? undefined
          : ownerJoinAliases.get(`${modulePath(resolved)}:${imported}`);
      if (ownerNames.has(imported) && joinAlias === undefined) {
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
    predicateLocals.size > 0 ||
    importedJoinAliases.size > 0;
  if (!publicReadModule) {
    return null;
  }
  return {
    file,
    tree,
    predicateLocals,
    importedJoinAliases,
  };
};

const inspectFileReads = (
  context: FileCensusContext,
  tableOf: (node: ts.Node) => string | undefined,
): PublicationCensus => {
  const { file, tree, predicateLocals, importedJoinAliases } = context;
  const resolver = createOwnerResolver({
    file,
    tree,
    predicateLocals,
    tableOf,
  });
  const sites = discoverDecisionReadSites(tree, tableOf);
  const reads: string[] = [];
  const errors: string[] = [];
  for (const site of sites) {
    const whereNodes =
      site.kind === "builder"
        ? builderCalls(site.node).filter(
            (call) =>
              ts.isPropertyAccessExpression(call.expression) &&
              call.expression.name.text === "where",
          )
        : [];

    const rawQuery = site.node.getText(tree);
    const rawFilters =
      site.kind === "raw" ? resolver.rawFilterOwners(site.node) : [];
    const joinedAliases: string[] = [];
    const visitJoins = (node: ts.Node): void => {
      if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isTemplateExpression(node.template)
      ) {
        let prefix = node.template.head.text;
        for (const span of node.template.templateSpans) {
          if (ts.isIdentifier(span.expression)) {
            const alias = importedJoinAliases.get(span.expression.text);
            const suffix = span.literal.text.trimStart();
            if (
              alias !== undefined &&
              /\bFROM\b/iu.test(prefix) &&
              !/\b(?:WHERE|CASE|OR|NOT)\b/iu.test(
                prefix.slice(lastSqlToken(prefix, /\bFROM\b/giu)),
              ) &&
              (suffix.length === 0 ||
                /^(?:WHERE|JOIN|LEFT|RIGHT|INNER|CROSS|GROUP|ORDER|LIMIT)\b/iu.test(
                  suffix,
                ))
            ) {
              joinedAliases.push(alias);
            }
          }
          prefix += span.literal.text;
        }
      }
      ts.forEachChild(node, visitJoins);
    };
    if (site.kind === "raw") {
      visitJoins(site.node);
    }
    const aliases = site.kind === "raw" ? rawDecisionAliases(rawQuery) : [];
    const label = `${file}:${site.line}`;
    reads.push(label);
    if (new Set(aliases).size !== aliases.length) {
      errors.push(`${label}: give each decision table its own alias`);
      continue;
    }
    const maintenanceWrite =
      MAINTENANCE_WRITE_SQL.has(file) &&
      rawQuery.includes(
        `INSERT INTO ${MAINTENANCE_WRITE_SQL.get(file)?.table ?? ""}`,
      );
    const hasOwner =
      whereNodes.some((where) =>
        resolver.usesOwner(where.arguments.at(0) ?? where),
      ) ||
      (site.kind === "relational" &&
        resolver.hasRelationalWhereOwner(site.node)) ||
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
    const target = site.kind === "builder" ? tableOf(site.target) : undefined;
    const builderOwned =
      site.kind !== "builder" ||
      (target !== undefined &&
        (whereNodes.some((where) =>
          resolver.hasOwnerTable(where.arguments.at(0) ?? where, target),
        ) ||
          (site.joinCondition !== undefined &&
            resolver.hasOwnerTable(site.joinCondition, target)) ||
          resolver.hasOwnerProjection(site.node, target)));
    if (
      !maintenanceWrite &&
      (!builderOwned ||
        (site.kind !== "builder" && (!hasOwner || !everyAliasOwned)))
    ) {
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
  const ownerJoinAliases = findOwnerJoinAliases({ files, ownerExports, trees });
  const tableOf = createDecisionTableResolver(trees);
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
    const report = inspectFileReads(context, tableOf);
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

type FindOwnerJoinAliasesOptions = {
  files: readonly SourceInput[];
  ownerExports: ReadonlyMap<string, ReadonlySet<string>>;
  trees: ReadonlyMap<string, ts.SourceFile>;
};

const findOwnerJoinAliases = ({
  files,
  ownerExports,
  trees,
}: FindOwnerJoinAliasesOptions): Map<string, string> => {
  const aliases = new Map<string, string>();
  for (const { file } of files) {
    const tree = trees.get(file);
    if (!tree) {
      continue;
    }
    const localOwners = new Set<string>();
    for (const statement of tree.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !isOwnerModule(file, statement.moduleSpecifier.text)
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        continue;
      }
      for (const item of bindings.elements) {
        if (
          (item.propertyName ?? item.name).text ===
          "publishedCaseLawDecisionSqlFor"
        ) {
          localOwners.add(item.name.text);
        }
      }
    }
    const exportedNames = ownerExports.get(modulePath(file));
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        exportedNames?.has(node.name.text) &&
        node.initializer
      ) {
        const binding = node.name.text;
        const inspect = (child: ts.Node): void => {
          if (
            ts.isCallExpression(child) &&
            ts.isIdentifier(child.expression) &&
            localOwners.has(child.expression.text)
          ) {
            const alias = child.arguments.at(0);
            if (alias && ts.isStringLiteral(alias)) {
              aliases.set(`${modulePath(file)}:${binding}`, alias.text);
            }
          }
          ts.forEachChild(child, inspect);
        };
        inspect(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
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
