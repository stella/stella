import {
  type ImportDeclaration,
  type Node,
  parseSource,
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
 * A module is a member of the census when its code (comments excluded) names
 * the contacts table:
 *
 * - the schema's `contacts` binding, under any imported or local name, or
 *   `schema.contacts` through a namespace import;
 * - the relational query `<handle>.query.contacts`;
 * - SQL text that reads or writes the table (`FROM`, `JOIN`, `UPDATE`,
 *   `INTO` before `contacts` or `public.contacts`), or the bare table name
 *   `"contacts"` handed to code that builds the statement.
 *
 * Screened, so never a finding: a site inside a `withOwnerOrganizationScope`
 * call (the owner names the organization), the owner module itself, and the
 * schema that declares the table and its policies, which the committed
 * migrations apply (migrations are SQL files and outside the census).
 *
 * Deny by default: every other module needs an allowlist entry whose reason
 * says which organization-scoped handle its sites run on. The entry pins the
 * module's sites per enclosing symbol, so a new contacts read or write, or one
 * moved into another symbol, fails the census until it is reviewed, and a
 * site that disappears makes the entry stale, so entries only shrink.
 *
 * Scope: one module's syntax. A relation followed from another table
 * (`with: { client: true }`), a re-export or a dynamic import is left to
 * review and to the row policies, which enforce the organization either way.
 */

export const CONTACTS_OWNER_SCOPE_FILE =
  "apps/api/src/lib/db/owner-organization-scope.ts";
const OWNER_SCOPE_FUNCTION = "withOwnerOrganizationScope";
const SCHEMA_DIRECTORY = "apps/api/src/db/schema";
export const CONTACTS_SIGNAL = "names-contacts-table";

const CONTACTS_SQL =
  /\b(?:from|join|update|into)\s+(?:"?public"?\s*\.\s*)?"?contacts\b(?![\w$-])/giu;
const CONTACTS_TABLE_NAME = "contacts";

export type ContactsAccessFinding = {
  file: string;
  signal: typeof CONTACTS_SIGNAL;
  screened: boolean;
  sites: MatterAccessSites;
};

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

/** `const people = contacts` makes `people` the table too. */
const recordLocalAlias = (node: Node, bindings: Bindings) => {
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "Identifier" &&
    node.init?.type === "Identifier" &&
    bindings.tables.has(node.init.name)
  ) {
    bindings.tables.add(node.id.name);
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

/** Whether a node sits inside a call of the owner scope function. */
const insideOwnerScope = (ancestors: readonly Node[], bindings: Bindings) =>
  ancestors.some(
    (ancestor) =>
      ancestor.type === "CallExpression" &&
      ancestor.callee.type === "Identifier" &&
      bindings.ownerScope.has(ancestor.callee.name),
  );

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

const TYPE_WRAPPED_EXPRESSIONS = new Set([
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

// Cheap prefilter so only candidate files are parsed.
const CANDIDATE = /\bcontacts\b/u;

/** Classify one module. `file` is the repository-relative path. */
export const classifyContactsAccessModule = (
  file: string,
  source: string,
): ContactsAccessFinding[] => {
  if (!CANDIDATE.test(source) || file.startsWith(`${SCHEMA_DIRECTORY}/`)) {
    return [];
  }
  const { program } = parseSource(file, source);
  const bindings: Bindings = {
    tables: new Set(),
    namespaces: new Set(),
    ownerScope: new Set(),
  };
  const sites: MatterAccessSites = {};
  const add = (ancestors: readonly Node[], count = 1) => {
    if (count === 0 || insideOwnerScope(ancestors, bindings)) {
      return;
    }
    const symbol = enclosingSymbol(ancestors);
    sites[symbol] = (sites[symbol] ?? 0) + count;
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
    const parent = ancestors.at(-1);
    if (
      node.type === "Identifier" &&
      bindings.tables.has(node.name) &&
      !isRepeatedName(node, parent) &&
      !isNotTableUse(node, parent)
    ) {
      add(ancestors);
    }
    if (namesTableMember(node, bindings)) {
      add(ancestors);
      // `query.contacts` is one site, not also a use of its object.
      return "skip-children";
    }
    const text = literalText(node);
    if (text !== undefined) {
      add(
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
