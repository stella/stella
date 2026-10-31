import path from "node:path";

import {
  type CallExpression,
  type ImportDeclaration,
  isObjectLiteralProperty,
  type Node,
  parseSource,
  type VariableDeclarator,
  walk,
} from "@stll/scripts/src/syntax-tree";

/**
 * Census of the modules that decide matter (workspace) access outside the
 * workspace row policies. Every authorized-workspace set those paths use comes
 * from one owner module that reads the same view the policies consult, so a
 * change to that view reaches them too. A module is a member of the census
 * when its code (comments excluded) shows one of these signals:
 *
 * - `reads-authorization-view`: it names the authorization view
 *   (`stellaAuthorizedWorkspaces`, `WORKSPACE_ACCESS_VIEW_NAME`, or the view's
 *   SQL name). Only the owner module may.
 * - `derives-matter-access`: it combines matter membership
 *   (`workspaceMembers` / `workspace_members`) with an organization-role rule
 *   (`CLIENT_MATTER_ADMIN_ROLES`, `WORKSPACE_ACCESS_BY_ROLE`, or a member
 *   role together with a client id),
 *   i.e. it computes the view's rule a second time. No module may.
 * - `owner-connection-workspace-set`: it imports the owner connection
 *   (`rootDb`, which row policies do not filter) as a value and filters by a
 *   matter-id set: `inArray(<table>.workspaceId | workspaces.id, …)` under any
 *   local or namespaced name, SQL `workspace_id = ANY(` / `IN` (literal or
 *   with an interpolated matter column), or an `accessibleWorkspaceIds` /
 *   `activeWorkspaceIds` binding. Its sites also pin every use of the owner
 *   connection per symbol (`<symbol>#rootDb`), so a reviewed reader that
 *   starts using `rootDb` in a symbol needs its entry updated.
 * - `names-matter-role-rule`: it names the organization-role reach of the
 *   rule (`CLIENT_MATTER_ADMIN_ROLES`, `WORKSPACE_ACCESS_BY_ROLE`). The rule
 *   belongs in the database (`stella_workspace_access`); every app copy is
 *   enumerated.
 *
 * Names resolve through renamed imports and plain local aliases
 * (`const matters = workspaces`), so renaming a table, the connection or a
 * rule keeps the site in the census. A matter column also counts when wrapped
 * (sql`${column}`) or handed to a function the module declares itself.
 *
 * Scope: the census reads one module's syntax; references that cross modules
 * (a re-export, a dynamic import, computed property names) are left to
 * review and to the database rule.
 *
 * Deny by default: no module meets a signal on its own except the owner module
 * for `reads-authorization-view`. Matter reads belong in a row-policy-scoped
 * transaction, where the policies, not the caller, decide the set. Every other
 * member needs an allowlist entry with a reason, and the entry pins the
 * member's SITES: the enclosing symbol of each occurrence (function, method,
 * variable or property name path) and how many occur there. A new site, or an
 * existing one moved into another symbol, fails the census even when the
 * module's total stays the same; a site that disappears makes the entry stale,
 * so entries only shrink.
 */

export const AUTHORIZED_WORKSPACE_OWNER_MODULE =
  "@/api/lib/workspaces/authorized-workspace-ids";
export const AUTHORIZED_WORKSPACE_OWNER_FILE =
  "apps/api/src/lib/workspaces/authorized-workspace-ids.ts";

const MATTER_ACCESS_SIGNALS = [
  "reads-authorization-view",
  "derives-matter-access",
  "owner-connection-workspace-set",
  "names-matter-role-rule",
] as const;

type MatterAccessSignal = (typeof MATTER_ACCESS_SIGNALS)[number];

/** Occurrences of a signal per enclosing symbol path (`<module>` at top). */
type MatterAccessSites = Record<string, number>;

export type MatterAccessFinding = {
  file: string;
  signal: MatterAccessSignal;
  /** Whether the module meets the rule for this signal on its own. */
  screened: boolean;
  sites: MatterAccessSites;
};

const VIEW_IDENTIFIERS = new Set([
  "stellaAuthorizedWorkspaces",
  "WORKSPACE_ACCESS_VIEW_NAME",
]);
const VIEW_SQL_NAME = /stella_authorized_workspaces/gu;
const ROLE_RULE_IDENTIFIERS = new Set([
  "CLIENT_MATTER_ADMIN_ROLES",
  "WORKSPACE_ACCESS_BY_ROLE",
]);
const WORKSPACE_SET_IDENTIFIERS = new Set([
  "accessibleWorkspaceIds",
  "activeWorkspaceIds",
]);
const SQL_MEMBERSHIP = /\bworkspace_members\b/gu;
const SQL_MEMBER_ROLE = /\b[a-z_]+\.role\b/u;
const SQL_CLIENT_ID = /\bclient_id\b/u;
const SQL_WORKSPACE_SET = /\bworkspace_id\s*(?:=\s*any\s*\(|in\b)/giu;
/**
 * The literal right after an interpolated column opens a set predicate; `IN`
 * needs no parenthesis because an interpolated array expands to a list.
 */
const SQL_SET_AFTER_COLUMN = /^\s*(?:=\s*any\s*\(|in\b)/iu;

/** Local name -> original name, for renamed imports and local aliases. */
type Aliases = Map<string, string>;

const resolveName = (name: string, aliases: Aliases) =>
  aliases.get(name) ?? name;

/** `a?.b` reads like `a.b`. */
const unchain = (node: Node): Node =>
  node.type === "ChainExpression" ? node.expression : node;

/** The name a `receiver.name` access reads, `#name` for a private one. */
const accessedName = (node: Node): string | undefined => {
  if (node.type !== "MemberExpression" || node.computed) {
    return undefined;
  }
  return node.property.type === "PrivateIdentifier"
    ? `#${node.property.name}`
    : node.property.name;
};

/** The name an alias initializer stands for: `x`, `ns.x`, `(x as T)`. */
const aliasTarget = (
  expression: Node,
  aliases: Aliases,
): string | undefined => {
  const node = unchain(expression);
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression"
  ) {
    return aliasTarget(node.expression, aliases);
  }
  if (node.type === "Identifier") {
    return resolveName(node.name, aliases);
  }
  return accessedName(node);
};

/** The table an expression names: `workspaces`, an alias, or `schema.x`. */
const tableName = (expression: Node, aliases: Aliases) => {
  const node = unchain(expression);
  if (node.type === "Identifier") {
    return resolveName(node.name, aliases);
  }
  return accessedName(node);
};

/** Alias target recorded for a local that holds a matter-id column. */
const MATTER_ID_COLUMN = "<matter-id column>";

/**
 * A column that holds a matter id: any `<table>.workspaceId`, the matters
 * table's own `workspaces.id` under any name, or a local holding either.
 */
const isMatterIdColumn = (expression: Node, aliases: Aliases): boolean => {
  const column = unchain(expression);
  if (column.type === "Identifier") {
    return resolveName(column.name, aliases) === MATTER_ID_COLUMN;
  }
  const name = accessedName(column);
  return (
    column.type === "MemberExpression" &&
    (name === "workspaceId" ||
      (name === "id" && tableName(column.object, aliases) === "workspaces"))
  );
};

/** A matter-id column, also when wrapped: `(c)`, `c as T`, sql`${c}`. */
const holdsMatterIdColumn = (node: Node, aliases: Aliases): boolean => {
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression"
  ) {
    return holdsMatterIdColumn(node.expression, aliases);
  }
  if (node.type === "TaggedTemplateExpression") {
    return node.quasi.expressions.some((expression) =>
      holdsMatterIdColumn(expression, aliases),
    );
  }
  return isMatterIdColumn(node, aliases);
};

const OWNER_CONNECTION_MODULE = "apps/api/src/db/root";

/** Whether an import specifier, alias or relative, names the root module. */
const resolveSpecifier = (specifier: string, file: string) => {
  if (specifier.startsWith("@/api/")) {
    return `apps/api/src/${specifier.slice("@/api/".length)}`;
  }
  if (specifier.startsWith(".")) {
    return path.posix.join(path.posix.dirname(file), specifier);
  }
  return specifier;
};

const isOwnerConnectionModule = (specifier: string, file: string) => {
  const resolved = resolveSpecifier(specifier, file);
  return (
    resolved.replace(/(?:\/index)?(?:\.ts)?$/u, "") === OWNER_CONNECTION_MODULE
  );
};

const literalText = (node: Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateElement") {
    return node.value.cooked ?? node.value.raw;
  }
  return undefined;
};

const namedKey = (key: Node, computed: boolean) => {
  if (computed) {
    return undefined;
  }
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : undefined;
};

const declarationName = (
  node: Node,
  parent: Node | undefined,
): string | undefined => {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "TSDeclareFunction" ||
    node.type === "ClassDeclaration"
  ) {
    return node.id?.name;
  }
  if (node.type === "VariableDeclarator") {
    return node.id.type === "Identifier" ? node.id.name : undefined;
  }
  if (
    node.type === "MethodDefinition" ||
    node.type === "TSAbstractMethodDefinition"
  ) {
    return node.kind === "method"
      ? namedKey(node.key, node.computed)
      : undefined;
  }
  if (
    node.type === "PropertyDefinition" ||
    node.type === "TSAbstractPropertyDefinition" ||
    node.type === "AccessorProperty" ||
    node.type === "TSAbstractAccessorProperty"
  ) {
    return namedKey(node.key, node.computed);
  }
  // An object literal entry `name: value` or method `name() {}`.
  return isObjectLiteralProperty(node, parent) &&
    node.kind === "init" &&
    !node.shorthand
    ? namedKey(node.key, node.computed)
    : undefined;
};

/** `outer.inner` names of the declarations enclosing a node. */
const enclosingSymbol = (ancestors: readonly Node[]): string => {
  const names: string[] = [];
  for (const [index, ancestor] of ancestors.entries()) {
    const name = declarationName(ancestor, ancestors[index - 1]);
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names.length === 0 ? "<module>" : names.join(".");
};

type SiteCounter = {
  /** Counts a site under the declarations among its `ancestors`. */
  add: (ancestors: readonly Node[], count?: number) => void;
  sites: MatterAccessSites;
};

const siteCounter = (): SiteCounter => {
  const sites: MatterAccessSites = {};
  return {
    sites,
    add: (ancestors, count = 1) => {
      if (count > 0) {
        const symbol = enclosingSymbol(ancestors);
        sites[symbol] = (sites[symbol] ?? 0) + count;
      }
    },
  };
};

const matchCount = (pattern: RegExp, text: string) =>
  [...text.matchAll(pattern)].length;

type Facts = {
  importsRootDbValue: boolean;
  namesRoleRule: boolean;
  namesMemberRole: boolean;
  namesClientId: boolean;
  view: SiteCounter;
  membership: SiteCounter;
  workspaceSet: SiteCounter;
  rootDbUse: SiteCounter;
  roleRule: SiteCounter;
};

const importedName = (specifier: ImportDeclaration["specifiers"][number]) => {
  if (specifier.type !== "ImportSpecifier") {
    return undefined;
  }
  return specifier.imported.type === "Literal"
    ? specifier.imported.value
    : specifier.imported.name;
};

const recordImport = (
  node: ImportDeclaration,
  facts: Facts,
  aliases: Aliases,
  file: string,
) => {
  if (node.importKind === "type") {
    return;
  }
  const fromOwnerConnection = isOwnerConnectionModule(node.source.value, file);
  const bindings = node.specifiers.filter(
    (specifier) => specifier.type !== "ImportDefaultSpecifier",
  );
  if (bindings.length === 0) {
    return;
  }
  if (
    bindings.some((specifier) => specifier.type === "ImportNamespaceSpecifier")
  ) {
    // `root.rootDb` reaches the owner connection without naming it here.
    if (fromOwnerConnection) {
      facts.importsRootDbValue = true;
    }
    return;
  }
  for (const element of bindings) {
    const imported = importedName(element);
    if (
      element.type === "ImportSpecifier" &&
      element.importKind !== "type" &&
      imported !== undefined &&
      element.imported.start !== element.local.start
    ) {
      aliases.set(element.local.name, imported);
    }
  }
  if (
    fromOwnerConnection &&
    bindings.some(
      (element) =>
        element.type === "ImportSpecifier" &&
        element.importKind !== "type" &&
        importedName(element) === "rootDb",
    )
  ) {
    facts.importsRootDbValue = true;
  }
};

/**
 * A call whose callee resolves to `inArray`: the import under any name, a
 * local alias of it, or `<anything>.inArray`. Over-matching a same-named
 * helper only adds a finding.
 */
const isInArrayCall = (node: CallExpression, aliases: Aliases): boolean =>
  aliasTarget(node.callee, aliases) === "inArray";

/** Names of the functions a module declares itself (hoisting included). */
const localFunctionNames = (program: Node) => {
  const names = new Set<string>();
  walk(program, (node) => {
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "TSDeclareFunction") &&
      node.id !== null
    ) {
      names.add(node.id.name);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      (node.init?.type === "ArrowFunctionExpression" ||
        node.init?.type === "FunctionExpression")
    ) {
      names.add(node.id.name);
    }
  });
  return names;
};

/**
 * A set predicate on a matter-id column: `inArray` under any name, or a
 * function the module declares itself that receives the column (a local
 * predicate helper takes the column as a parameter). Over-matching a local
 * helper only adds a finding.
 */
const isMatterSetPredicate = (
  node: Node,
  aliases: Aliases,
  localFunctions: ReadonlySet<string>,
) =>
  node.type === "CallExpression" &&
  (isInArrayCall(node, aliases) ||
    (node.callee.type === "Identifier" &&
      localFunctions.has(node.callee.name))) &&
  node.arguments.some((argument) => holdsMatterIdColumn(argument, aliases));

const recordIdentifier = (
  name: string,
  ancestors: readonly Node[],
  facts: Facts,
  aliases: Aliases,
) => {
  // A renamed import or local alias is a use of the original name.
  const original = resolveName(name, aliases);
  if (VIEW_IDENTIFIERS.has(original)) {
    facts.view.add(ancestors);
  }
  if (original === "workspaceMembers") {
    facts.membership.add(ancestors);
  }
  if (ROLE_RULE_IDENTIFIERS.has(original)) {
    facts.namesRoleRule = true;
    facts.roleRule.add(ancestors);
  }
  if (original === "rootDb") {
    facts.rootDbUse.add(ancestors);
  }
  if (original === "clientId") {
    facts.namesClientId = true;
  }
  if (WORKSPACE_SET_IDENTIFIERS.has(original)) {
    facts.workspaceSet.add(ancestors);
  }
};

const recordLiteral = (
  ancestors: readonly Node[],
  text: string,
  facts: Facts,
) => {
  facts.view.add(ancestors, matchCount(VIEW_SQL_NAME, text));
  facts.membership.add(ancestors, matchCount(SQL_MEMBERSHIP, text));
  facts.workspaceSet.add(ancestors, matchCount(SQL_WORKSPACE_SET, text));
  if (SQL_MEMBER_ROLE.test(text)) {
    facts.namesMemberRole = true;
  }
  if (SQL_CLIENT_ID.test(text)) {
    facts.namesClientId = true;
  }
};

/**
 * Local aliases: `const matters = workspaces`, `const owner = root.rootDb`,
 * `const { rootDb: owner } = root`, `const within = d.inArray`. Later uses of
 * the alias mean the original name; the declared name itself is not a use.
 */
const isAliasDeclaration = (
  node: Node | undefined,
): node is VariableDeclarator & { init: Node } =>
  node?.type === "VariableDeclarator" &&
  node.init !== null &&
  (node.id.type === "ObjectPattern" ||
    aliasTarget(node.init, new Map()) !== undefined);

/**
 * The name an object pattern entry binds: `{ a }`, `{ a: b }`, `{ a = x }`,
 * `{ ...rest }`.
 */
const boundName = (entry: Node) => {
  let target = entry;
  if (entry.type === "Property") {
    target =
      entry.value.type === "AssignmentPattern" ? entry.value.left : entry.value;
  }
  if (target.type === "Identifier") {
    return target;
  }
  return target.type === "RestElement" && target.argument.type === "Identifier"
    ? target.argument
    : undefined;
};

/**
 * Whether an identifier declares an alias (`const owner = rootDb`) or belongs
 * to an entry of an alias pattern (`const { rootDb: owner = fallback } = root`).
 */
const isLocalAliasName = (node: Node, ancestors: readonly Node[]) => {
  const parent = ancestors.at(-1);
  if (isAliasDeclaration(parent)) {
    return parent.id === node;
  }
  const depth = parent?.type === "AssignmentPattern" ? 2 : 1;
  const entry = ancestors.at(-depth);
  const pattern = ancestors.at(-depth - 1);
  const declaration = ancestors.at(-depth - 2);
  if (
    pattern?.type !== "ObjectPattern" ||
    !isAliasDeclaration(declaration) ||
    declaration.id !== pattern
  ) {
    return false;
  }
  return (
    entry?.type === "RestElement" ||
    (entry?.type === "Property" && !(entry.computed && entry.key === node))
  );
};

const recordLocalAlias = (node: Node, aliases: Aliases) => {
  if (!isAliasDeclaration(node)) {
    return;
  }
  if (node.id.type === "Identifier") {
    const target = isMatterIdColumn(node.init, aliases)
      ? MATTER_ID_COLUMN
      : aliasTarget(node.init, aliases);
    if (target !== undefined) {
      aliases.set(node.id.name, target);
    }
    return;
  }
  if (node.id.type !== "ObjectPattern") {
    return;
  }
  const table = tableName(node.init, aliases);
  for (const element of node.id.properties) {
    const name = boundName(element);
    let key: Node | undefined = name;
    if (element.type === "Property") {
      key = element.computed ? undefined : element.key;
    }
    if (name !== undefined && key?.type === "Identifier") {
      // `const { workspaceId } = entities`, `const { id } = workspaces`.
      const holdsMatterId =
        key.name === "workspaceId" ||
        (key.name === "id" && table === "workspaces");
      aliases.set(
        name.name,
        holdsMatterId ? MATTER_ID_COLUMN : resolveName(key.name, aliases),
      );
    }
  }
};

/** A name the source spells once although oxc holds it twice. */
const isRepeatedName = (node: Node, parent: Node | undefined) =>
  (parent?.type === "Property" && parent.shorthand && parent.key === node) ||
  (parent?.type === "ExportSpecifier" &&
    parent.exported === node &&
    parent.local.start === node.start);

const readFacts = (file: string, source: string): Facts => {
  const { program } = parseSource(file, source);
  const facts: Facts = {
    importsRootDbValue: false,
    namesRoleRule: false,
    namesMemberRole: false,
    namesClientId: false,
    view: siteCounter(),
    membership: siteCounter(),
    workspaceSet: siteCounter(),
    rootDbUse: siteCounter(),
    roleRule: siteCounter(),
  };
  const aliases: Aliases = new Map();
  const localFunctions = localFunctionNames(program);
  walk(program, (node, ancestors) => {
    if (node.type === "ImportDeclaration") {
      // Import specifiers name the imported symbols; they are not uses.
      recordImport(node, facts, aliases, file);
      return "skip-children";
    }
    recordLocalAlias(node, aliases);
    if (
      (node.type === "Identifier" || node.type === "JSXIdentifier") &&
      !isRepeatedName(node, ancestors.at(-1)) &&
      !isLocalAliasName(node, ancestors)
    ) {
      recordIdentifier(node.name, ancestors, facts, aliases);
    }
    if (
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      node.object.name === "member" &&
      accessedName(node) === "role"
    ) {
      facts.namesMemberRole = true;
    }
    if (isMatterSetPredicate(node, aliases, localFunctions)) {
      facts.workspaceSet.add(ancestors);
    }
    // sql`${entities.workspaceId} = ANY(${ids})`: an interpolated matter
    // column opening a set predicate.
    if (node.type === "TemplateLiteral") {
      for (const [index, expression] of node.expressions.entries()) {
        const literal = node.quasis[index + 1];
        if (
          literal !== undefined &&
          isMatterIdColumn(expression, aliases) &&
          SQL_SET_AFTER_COLUMN.test(literal.value.cooked ?? literal.value.raw)
        ) {
          facts.workspaceSet.add(ancestors);
        }
      }
    }
    const text = literalText(node);
    if (text !== undefined) {
      recordLiteral(ancestors, text, facts);
    }
    return undefined;
  });
  return facts;
};

// Cheap prefilter so only candidate files are parsed.
const CANDIDATE =
  /stellaAuthorizedWorkspaces|WORKSPACE_ACCESS_VIEW_NAME|stella_authorized_workspaces|workspaceMembers|workspace_members|rootDb|db\/root\b|CLIENT_MATTER_ADMIN_ROLES|WORKSPACE_ACCESS_BY_ROLE/u;

const hasSites = (sites: MatterAccessSites) => Object.keys(sites).length > 0;

/** Classify one module. `file` is the repository-relative path. */
export const classifyMatterAccessModule = (
  file: string,
  source: string,
): MatterAccessFinding[] => {
  if (!CANDIDATE.test(source)) {
    return [];
  }
  const facts = readFacts(file, source);
  const findings: MatterAccessFinding[] = [];
  if (hasSites(facts.view.sites)) {
    findings.push({
      file,
      signal: "reads-authorization-view",
      screened: file === AUTHORIZED_WORKSPACE_OWNER_FILE,
      sites: facts.view.sites,
    });
  }
  if (
    hasSites(facts.membership.sites) &&
    (facts.namesRoleRule || (facts.namesMemberRole && facts.namesClientId))
  ) {
    findings.push({
      file,
      signal: "derives-matter-access",
      screened: false,
      sites: facts.membership.sites,
    });
  }
  if (facts.importsRootDbValue && hasSites(facts.workspaceSet.sites)) {
    const connectionSites = Object.entries(facts.rootDbUse.sites).map(
      ([symbol, count]) => [`${symbol}#rootDb`, count] as const,
    );
    findings.push({
      file,
      signal: "owner-connection-workspace-set",
      screened: false,
      sites: {
        ...facts.workspaceSet.sites,
        ...Object.fromEntries(connectionSites),
      },
    });
  }
  if (hasSites(facts.roleRule.sites)) {
    findings.push({
      file,
      signal: "names-matter-role-rule",
      screened: false,
      sites: facts.roleRule.sites,
    });
  }
  return findings;
};

const allowlistKey = ({
  file,
  signal,
}: Pick<MatterAccessFinding, "file" | "signal">) => `${file}::${signal}`;

export type MatterAccessAllowlistEntry = {
  reason: string;
  sites: MatterAccessSites;
};

const siteMessage = (
  key: string,
  symbol: string,
  found: number,
  allowed: number,
) => `${key} @ ${symbol}: ${String(found)} sites, allowed ${String(allowed)}`;

/**
 * The unscreened findings no allowlist entry covers (or that exceed an
 * entry's pinned sites), and the entries that no longer match (a finding or a
 * pinned site gone), so the allowlist only shrinks. Messages carry measured
 * counts so an entry can be corrected.
 */
export const evaluateMatterAccessCensus = (
  findings: readonly MatterAccessFinding[],
  allowlist: Readonly<Record<string, MatterAccessAllowlistEntry>>,
) => {
  const unscreened = new Map(
    findings
      .filter((finding) => !finding.screened)
      .map((finding) => [allowlistKey(finding), finding.sites] as const),
  );
  const violations: string[] = [];
  for (const [key, sites] of unscreened) {
    const entry = allowlist[key];
    if (entry === undefined) {
      violations.push(key);
      continue;
    }
    for (const [symbol, found] of Object.entries(sites)) {
      const allowed = entry.sites[symbol] ?? 0;
      if (found > allowed) {
        violations.push(siteMessage(key, symbol, found, allowed));
      }
    }
  }
  const stale: string[] = [];
  for (const [key, entry] of Object.entries(allowlist)) {
    const sites = unscreened.get(key);
    if (sites === undefined) {
      stale.push(key);
      continue;
    }
    for (const [symbol, allowed] of Object.entries(entry.sites)) {
      const found = sites[symbol] ?? 0;
      if (found < allowed) {
        stale.push(siteMessage(key, symbol, found, allowed));
      }
    }
  }
  return { violations: violations.toSorted(), stale: stale.toSorted() };
};
