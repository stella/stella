import {
  type CallExpression,
  type ImportDeclaration,
  type Node,
  parseSource,
  staticPropertyName,
  walk,
} from "@stll/scripts/src/syntax-tree";

import {
  enclosingSymbol,
  importedName,
  isRepeatedName,
  literalText,
  type MatterAccessSites,
  resolveSpecifier,
} from "./matter-access-census";

/**
 * Census of the code that reads or writes `contacts`, built on the matter
 * access census's syntax walk, site pinning and allowlist evaluation.
 *
 * `contacts` forces row security on its owner: the owner connection reaches
 * the contacts of the one organization its transaction names. The owner
 * module (`withOwnerOrganizationScope`) is the one place owner-connection
 * code names that organization. Every other contacts read or write runs on an
 * organization-scoped application handle, whose row policies admit the
 * organization the handle was built for.
 *
 * A module is a member of the census when its code (comments excluded) shows
 * one of these sites:
 *
 * - the schema's `contacts` binding, under any imported or local name, or
 *   `schema.contacts` through a namespace import;
 * - the relational query `<handle>.query.contacts`, or a relation followed
 *   into contacts from another table (`with: { client: … }`, by the relation
 *   names the schema declares on contacts);
 * - SQL text that reads, writes or locks the table (`FROM`, `JOIN`, `UPDATE`,
 *   `INTO`, `USING`, `TRUNCATE`, `LOCK`, `COPY`, with or without `ONLY` and
 *   `public.`), the bare table name `"contacts"` handed to code that builds
 *   the statement, and a template that interpolates a constant holding it;
 * - a call of `withOwnerOrganizationScope`, pinned with the source of the
 *   organization id it names (`<symbol>#withOwnerOrganizationScope(<id>)`),
 *   so a new caller, or a caller that names a different organization, fails
 *   the census until it is reviewed.
 *
 * Screened, so never a finding: a site in a `withOwnerOrganizationScope`
 * callback that runs on the callback's own transaction parameter (an owner
 * handle used inside the callback is still a finding), the owner module
 * itself, and the schema that declares the table and its policies, which the
 * committed migrations apply (migrations are SQL files and outside the
 * census).
 *
 * Deny by default: every other module needs an allowlist entry whose reason
 * says which organization-scoped handle its sites run on, or where an owner
 * scope takes its organization from. The entry pins the module's sites per
 * enclosing symbol, so a new site, or one moved into another symbol, fails the
 * census until it is reviewed, and a site that disappears makes the entry
 * stale, so entries only shrink.
 *
 * Scope: one module's syntax. A table name carried through a list into a
 * statement builder is counted where the list names it; a re-export or a
 * dynamic import is left to review and to the row policies, which enforce the
 * organization either way.
 */

export const CONTACTS_OWNER_SCOPE_FILE =
  "apps/api/src/lib/db/owner-organization-scope.ts";
const OWNER_SCOPE_FUNCTION = "withOwnerOrganizationScope";
const SCHEMA_DIRECTORY = "apps/api/src/db/schema";
export const CONTACTS_SIGNAL = "names-contacts-table";

const CONTACTS_SQL =
  /\b(?:from|join|update|into|using|truncate(?:\s+table)?|lock(?:\s+table)?|copy)\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?contacts\b(?![\w$-])/giu;
/** A statement keyword right before an interpolated table name. */
const SQL_BEFORE_TABLE =
  /\b(?:from|join|update|into|using|truncate(?:\s+table)?|lock(?:\s+table)?|copy)\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?$/iu;
const CONTACTS_TABLE_NAME = "contacts";
const CONTACTS_RELATION = /\b(\w+)\s*:\s*r\.(?:one|many)\.contacts\s*\(/gu;

export type ContactsAccessFinding = {
  file: string;
  signal: typeof CONTACTS_SIGNAL;
  screened: boolean;
  sites: MatterAccessSites;
};

/** Relation names the schema declares into contacts (`client`, `person`, …). */
export const contactRelationNames = (relationsSource: string) =>
  new Set(
    [...relationsSource.matchAll(CONTACTS_RELATION)].flatMap(([, name]) =>
      name === undefined ? [] : [name],
    ),
  );

const isSchemaModule = (specifier: string, file: string) => {
  const resolved = resolveSpecifier(specifier, file).replace(
    /(?:\/index)?(?:\.ts)?$/u,
    "",
  );
  return (
    resolved === SCHEMA_DIRECTORY || resolved === `${SCHEMA_DIRECTORY}/contacts`
  );
};

type Bindings = {
  /** Local names bound to the schema's `contacts` table. */
  tables: Set<string>;
  /** Local names of namespace imports of the schema. */
  namespaces: Set<string>;
  /** Local names bound to the owner scope function. */
  ownerScope: Set<string>;
  /** Local constants holding the table name `"contacts"`. */
  tableNames: Set<string>;
};

const recordImport = (
  node: ImportDeclaration,
  bindings: Bindings,
  file: string,
) => {
  if (node.importKind === "type") {
    return;
  }
  const fromSchema = isSchemaModule(node.source.value, file);
  const fromOwner =
    resolveSpecifier(node.source.value, file).replace(/(?:\.ts)?$/u, "") ===
    CONTACTS_OWNER_SCOPE_FILE.replace(/\.ts$/u, "");
  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier" && fromSchema) {
      bindings.namespaces.add(specifier.local.name);
    }
    if (
      specifier.type !== "ImportSpecifier" ||
      specifier.importKind === "type"
    ) {
      continue;
    }
    const imported = importedName(specifier);
    if (fromSchema && imported === CONTACTS_TABLE_NAME) {
      bindings.tables.add(specifier.local.name);
    }
    if (fromOwner && imported === OWNER_SCOPE_FUNCTION) {
      bindings.ownerScope.add(specifier.local.name);
    }
  }
};

/**
 * `const people = contacts` makes `people` the table too, and
 * `const TABLE = "contacts"` makes `TABLE` its name.
 */
const recordLocalAlias = (node: Node, bindings: Bindings) => {
  if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") {
    return;
  }
  if (node.init?.type === "Identifier" && bindings.tables.has(node.init.name)) {
    bindings.tables.add(node.id.name);
  }
  // `const scoped = withOwnerOrganizationScope` calls the owner scope too.
  if (
    node.init?.type === "Identifier" &&
    bindings.ownerScope.has(node.init.name)
  ) {
    bindings.ownerScope.add(node.id.name);
  }
  if (
    node.init?.type === "Literal" &&
    node.init.value === CONTACTS_TABLE_NAME
  ) {
    bindings.tableNames.add(node.id.name);
  }
};

const memberName = (node: Node) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier"
    ? node.property.name
    : undefined;

/** `<handle>.query.contacts` or `schema.contacts` (namespace import). */
const namesTableMember = (node: Node, bindings: Bindings) => {
  if (node.type !== "MemberExpression" || memberName(node) !== "contacts") {
    return false;
  }
  const object = node.object;
  return (
    memberName(object) === "query" ||
    (object.type === "Identifier" && bindings.namespaces.has(object.name))
  );
};

const isOwnerScopeCall = (
  node: Node,
  bindings: Bindings,
): node is CallExpression =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  bindings.ownerScope.has(node.callee.name);

const CHAIN_NODE_TYPES = [
  "Identifier",
  "MemberExpression",
  "CallExpression",
  "AwaitExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "ChainExpression",
] as const;

/** The nodes a receiver chain passes through on the way to its root. */
type ChainNode = Extract<Node, { type: (typeof CHAIN_NODE_TYPES)[number] }>;

const CHAIN_NODE_TYPE_SET: ReadonlySet<string> = new Set(CHAIN_NODE_TYPES);

const isChainNode = (node: Node): node is ChainNode =>
  CHAIN_NODE_TYPE_SET.has(node.type);

/** The identifier a receiver chain starts from: `tx` in `tx.a().b`. */
const chainRoot = (node: Node): string | undefined => {
  if (!isChainNode(node)) {
    return undefined;
  }
  switch (node.type) {
    case "Identifier":
      return node.name;
    case "MemberExpression":
      return chainRoot(node.object);
    case "CallExpression":
      return chainRoot(node.callee);
    case "AwaitExpression":
      return chainRoot(node.argument);
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "ChainExpression":
      return chainRoot(node.expression);
    default:
      return node satisfies never;
  }
};

/**
 * Whether a function body declares `name` again (a variable or a nested
 * parameter): a chain rooted at that spelling may not be the scope's own
 * transaction, so the callback is not screened.
 */
const redeclares = (body: Node, name: string) => {
  let found = false;
  walk(body, (node) => {
    if (
      (node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.id.name === name) ||
      ((node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression" ||
        node.type === "FunctionDeclaration") &&
        node.params.some(
          (parameter) =>
            parameter.type === "Identifier" && parameter.name === name,
        ))
    ) {
      found = true;
      return "skip-children";
    }
    return undefined;
  });
  return found;
};

/**
 * Whether a site runs on the transaction an owner scope hands its callback:
 * it lies in the callback, and a call between it and the callback runs on
 * the callback's first parameter (`tx.select().from(contacts)`,
 * `tx.execute(sql\`… contacts …\`)`, `tx.query.contacts`).
 */
const onOwnerScopeTransaction = (
  node: Node,
  ancestors: readonly Node[],
  bindings: Bindings,
) => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    const callback = ancestors[index + 1];
    if (
      ancestor === undefined ||
      callback === undefined ||
      !isOwnerScopeCall(ancestor, bindings) ||
      ancestor.arguments.at(2) !== callback ||
      (callback.type !== "ArrowFunctionExpression" &&
        callback.type !== "FunctionExpression")
    ) {
      continue;
    }
    const parameter = callback.params.at(0);
    if (
      parameter?.type !== "Identifier" ||
      redeclares(callback.body, parameter.name)
    ) {
      return false;
    }
    // The nearest statement chain around the site decides; `sql` fragments
    // are built for the chain around them, and a nested function is a
    // different handle's scope.
    const inner = [...ancestors.slice(index + 2), node].toReversed();
    for (const candidate of inner) {
      if (
        candidate.type === "ArrowFunctionExpression" ||
        candidate.type === "FunctionExpression"
      ) {
        return false;
      }
      if (
        candidate.type !== "CallExpression" &&
        candidate.type !== "MemberExpression"
      ) {
        continue;
      }
      const root = chainRoot(candidate);
      if (root === undefined || root === "sql") {
        continue;
      }
      return root === parameter.name;
    }
    return false;
  }
  return false;
};

/**
 * Not a use of the table itself: a declared name (`const contacts = …`), an
 * object key, a member name (`x.contacts`), or the table read for one of its
 * columns (`contacts.id`); the statement the column belongs to names the
 * table where it reads or writes it.
 */
const isNotTableUse = (node: Node, parent: Node | undefined) =>
  (parent?.type === "VariableDeclarator" && parent.id === node) ||
  (parent?.type === "Property" && parent.key === node && !parent.computed) ||
  (parent?.type === "MemberExpression" &&
    (parent.object === node || (parent.property === node && !parent.computed)));

/**
 * `with: { client: true }`: the relation entries of a relational query, under
 * identifier or quoted keys.
 */
const relationEntries = (node: Node) => {
  if (
    node.type !== "Property" ||
    staticPropertyName(node) !== "with" ||
    node.value.type !== "ObjectExpression"
  ) {
    return [];
  }
  return node.value.properties.flatMap((entry) => {
    if (
      entry.type !== "Property" ||
      (entry.value.type === "Literal" && entry.value.value === false)
    ) {
      return [];
    }
    const name = staticPropertyName(entry);
    return name === undefined ? [] : [{ name, entry }];
  });
};

/** Interpolations of a contacts-name constant right after a SQL keyword. */
const interpolatedTableNames = (node: Node, bindings: Bindings) => {
  if (node.type !== "TemplateLiteral") {
    return 0;
  }
  return node.expressions.filter((expression, index) => {
    const before = node.quasis[index];
    return (
      expression.type === "Identifier" &&
      bindings.tableNames.has(expression.name) &&
      before !== undefined &&
      SQL_BEFORE_TABLE.test(before.value.cooked ?? before.value.raw)
    );
  }).length;
};

const TYPE_WRAPPED_EXPRESSIONS = new Set([
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

// Cheap prefilter so only candidate files are parsed: the table, the owner
// scope, or a relation into contacts named in a module that follows `with`.
const CANDIDATE = /\bcontacts\b|withOwnerOrganizationScope/u;
const RELATION_CANDIDATE = /\bwith["'`]?\s*:/u;

const isCandidate = (source: string, contactRelations: ReadonlySet<string>) =>
  CANDIDATE.test(source) ||
  (RELATION_CANDIDATE.test(source) &&
    [...contactRelations].some((name) =>
      new RegExp(`["'\`]?\\b${name}\\b["'\`]?\\s*:`, "u").test(source),
    ));

const sourceText = (source: string, node: Node) =>
  source.slice(node.start, node.end).replaceAll(/\s+/gu, " ");

type ClassifyOptions = {
  /** Relation names the schema declares into contacts. */
  contactRelations: ReadonlySet<string>;
};

/** Classify one module. `file` is the repository-relative path. */
export const classifyContactsAccessModule = (
  file: string,
  source: string,
  { contactRelations }: ClassifyOptions,
): ContactsAccessFinding[] => {
  if (
    !isCandidate(source, contactRelations) ||
    file.startsWith(`${SCHEMA_DIRECTORY}/`)
  ) {
    return [];
  }
  const { program } = parseSource(file, source);
  const bindings: Bindings = {
    tables: new Set(),
    namespaces: new Set(),
    ownerScope: new Set(),
    tableNames: new Set(),
  };
  const sites: MatterAccessSites = {};
  const pin = (key: string, count = 1) => {
    if (count > 0) {
      sites[key] = (sites[key] ?? 0) + count;
    }
  };
  const add = (node: Node, ancestors: readonly Node[], count = 1) => {
    if (count > 0 && !onOwnerScopeTransaction(node, ancestors, bindings)) {
      pin(enclosingSymbol(ancestors), count);
    }
  };
  walk(program, (node, ancestors) => {
    if (node.type === "ImportDeclaration") {
      recordImport(node, bindings, file);
      return "skip-children";
    }
    // Types (`typeof contacts.$inferSelect`, `"contacts"` in a union) read
    // and write nothing; an expression wrapper's operand still counts.
    if (
      node.type.startsWith("TS") &&
      !TYPE_WRAPPED_EXPRESSIONS.has(node.type)
    ) {
      return "skip-children";
    }
    recordLocalAlias(node, bindings);
    if (isOwnerScopeCall(node, bindings)) {
      const organization = node.arguments.at(1);
      pin(
        `${enclosingSymbol(ancestors)}#${OWNER_SCOPE_FUNCTION}(${
          organization === undefined ? "" : sourceText(source, organization)
        })`,
      );
    }
    const parent = ancestors.at(-1);
    if (
      node.type === "Identifier" &&
      bindings.tables.has(node.name) &&
      !isRepeatedName(node, parent) &&
      !isNotTableUse(node, parent)
    ) {
      add(node, ancestors);
    }
    if (namesTableMember(node, bindings)) {
      add(node, ancestors);
      // `query.contacts` is one site, not also a use of its object.
      return "skip-children";
    }
    for (const { name, entry } of relationEntries(node)) {
      if (contactRelations.has(name)) {
        add(entry, [...ancestors, node]);
      }
    }
    add(node, ancestors, interpolatedTableNames(node, bindings));
    const text = literalText(node);
    if (text !== undefined) {
      add(
        node,
        ancestors,
        text === CONTACTS_TABLE_NAME
          ? 1
          : [...text.matchAll(CONTACTS_SQL)].length,
      );
    }
    return undefined;
  });
  if (Object.keys(sites).length === 0) {
    return [];
  }
  return [
    {
      file,
      signal: CONTACTS_SIGNAL,
      screened: file === CONTACTS_OWNER_SCOPE_FILE,
      sites,
    },
  ];
};
