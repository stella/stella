import path from "node:path";
import ts from "typescript6";

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

/** The name an alias initializer stands for: `x`, `ns.x`, `(x as T)`. */
const aliasTarget = (
  node: ts.Expression,
  aliases: Aliases,
): string | undefined => {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return aliasTarget(node.expression, aliases);
  }
  if (ts.isIdentifier(node)) {
    return resolveName(node.text, aliases);
  }
  return ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
};

/** The table an expression names: `workspaces`, an alias, or `schema.x`. */
const tableName = (node: ts.Expression, aliases: Aliases) => {
  if (ts.isIdentifier(node)) {
    return resolveName(node.text, aliases);
  }
  return ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
};

/** Alias target recorded for a local that holds a matter-id column. */
const MATTER_ID_COLUMN = "<matter-id column>";

/**
 * A column that holds a matter id: any `<table>.workspaceId`, the matters
 * table's own `workspaces.id` under any name, or a local holding either.
 */
const isMatterIdColumn = (column: ts.Expression, aliases: Aliases): boolean =>
  (ts.isIdentifier(column) &&
    resolveName(column.text, aliases) === MATTER_ID_COLUMN) ||
  (ts.isPropertyAccessExpression(column) &&
    (column.name.text === "workspaceId" ||
      (column.name.text === "id" &&
        tableName(column.expression, aliases) === "workspaces")));

/** A matter-id column, also when wrapped: `(c)`, `c as T`, sql`${c}`. */
const holdsMatterIdColumn = (
  node: ts.Expression,
  aliases: Aliases,
): boolean => {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return holdsMatterIdColumn(node.expression, aliases);
  }
  if (ts.isTaggedTemplateExpression(node)) {
    return (
      ts.isTemplateExpression(node.template) &&
      node.template.templateSpans.some((span) =>
        holdsMatterIdColumn(span.expression, aliases),
      )
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

const literalText = (node: ts.Node): string | undefined => {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    return node.text;
  }
  return undefined;
};

const declarationName = (node: ts.Node): string | undefined => {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node)) &&
    node.name !== undefined &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  return undefined;
};

/** `outer.inner` names of the declarations enclosing a node. */
const enclosingSymbol = (node: ts.Node): string => {
  const names: string[] = [];
  // Sites are nodes inside a file, so the walk ends at its source file.
  for (
    let current = node.parent;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    const name = declarationName(current);
    if (name !== undefined) {
      names.unshift(name);
    }
  }
  return names.length === 0 ? "<module>" : names.join(".");
};

type SiteCounter = {
  add: (node: ts.Node, count?: number) => void;
  sites: MatterAccessSites;
};

const siteCounter = (): SiteCounter => {
  const sites: MatterAccessSites = {};
  return {
    sites,
    add: (node, count = 1) => {
      if (count > 0) {
        const symbol = enclosingSymbol(node);
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

const recordImport = (
  node: ts.ImportDeclaration,
  facts: Facts,
  aliases: Aliases,
  file: string,
) => {
  if (
    !ts.isStringLiteral(node.moduleSpecifier) ||
    node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
  ) {
    return;
  }
  const fromOwnerConnection = isOwnerConnectionModule(
    node.moduleSpecifier.text,
    file,
  );
  const bindings = node.importClause?.namedBindings;
  if (bindings === undefined) {
    return;
  }
  if (ts.isNamespaceImport(bindings)) {
    // `root.rootDb` reaches the owner connection without naming it here.
    if (fromOwnerConnection) {
      facts.importsRootDbValue = true;
    }
  } else {
    for (const element of bindings.elements) {
      if (!element.isTypeOnly && element.propertyName !== undefined) {
        aliases.set(element.name.text, element.propertyName.text);
      }
    }
  }
  if (
    fromOwnerConnection &&
    ts.isNamedImports(bindings) &&
    bindings.elements.some(
      (element) =>
        !element.isTypeOnly &&
        (element.propertyName ?? element.name).text === "rootDb",
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
const isInArrayCall = (node: ts.CallExpression, aliases: Aliases): boolean =>
  aliasTarget(node.expression, aliases) === "inArray";

/** Names of the functions a module declares itself (hoisting included). */
const localFunctionNames = (sourceFile: ts.SourceFile) => {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      names.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
};

/**
 * A set predicate on a matter-id column: `inArray` under any name, or a
 * function the module declares itself that receives the column (a local
 * predicate helper takes the column as a parameter). Over-matching a local
 * helper only adds a finding.
 */
const isMatterSetPredicate = (
  node: ts.Node,
  aliases: Aliases,
  localFunctions: ReadonlySet<string>,
) =>
  ts.isCallExpression(node) &&
  (isInArrayCall(node, aliases) ||
    (ts.isIdentifier(node.expression) &&
      localFunctions.has(node.expression.text))) &&
  node.arguments.some((argument) => holdsMatterIdColumn(argument, aliases));

const recordIdentifier = (
  node: ts.Identifier,
  facts: Facts,
  aliases: Aliases,
) => {
  // A renamed import or local alias is a use of the original name.
  const name = resolveName(node.text, aliases);
  if (VIEW_IDENTIFIERS.has(name)) {
    facts.view.add(node);
  }
  if (name === "workspaceMembers") {
    facts.membership.add(node);
  }
  if (ROLE_RULE_IDENTIFIERS.has(name)) {
    facts.namesRoleRule = true;
    facts.roleRule.add(node);
  }
  if (name === "rootDb") {
    facts.rootDbUse.add(node);
  }
  if (name === "clientId") {
    facts.namesClientId = true;
  }
  if (WORKSPACE_SET_IDENTIFIERS.has(name)) {
    facts.workspaceSet.add(node);
  }
};

const recordLiteral = (node: ts.Node, text: string, facts: Facts) => {
  facts.view.add(node, matchCount(VIEW_SQL_NAME, text));
  facts.membership.add(node, matchCount(SQL_MEMBERSHIP, text));
  facts.workspaceSet.add(node, matchCount(SQL_WORKSPACE_SET, text));
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
const isAliasDeclaration = (node: ts.Node): node is ts.VariableDeclaration =>
  ts.isVariableDeclaration(node) &&
  node.initializer !== undefined &&
  (ts.isObjectBindingPattern(node.name) ||
    aliasTarget(node.initializer, new Map()) !== undefined);

const isLocalAliasName = (node: ts.Identifier) =>
  (isAliasDeclaration(node.parent) && node.parent.name === node) ||
  (ts.isBindingElement(node.parent) &&
    ts.isObjectBindingPattern(node.parent.parent) &&
    isAliasDeclaration(node.parent.parent.parent));

const recordLocalAlias = (node: ts.Node, aliases: Aliases) => {
  if (!isAliasDeclaration(node) || node.initializer === undefined) {
    return;
  }
  if (ts.isIdentifier(node.name)) {
    const target = isMatterIdColumn(node.initializer, aliases)
      ? MATTER_ID_COLUMN
      : aliasTarget(node.initializer, aliases);
    if (target !== undefined) {
      aliases.set(node.name.text, target);
    }
    return;
  }
  if (!ts.isObjectBindingPattern(node.name)) {
    return;
  }
  const table = tableName(node.initializer, aliases);
  for (const element of node.name.elements) {
    const key = element.propertyName ?? element.name;
    if (ts.isIdentifier(element.name) && ts.isIdentifier(key)) {
      // `const { workspaceId } = entities`, `const { id } = workspaces`.
      const holdsMatterId =
        key.text === "workspaceId" ||
        (key.text === "id" && table === "workspaces");
      aliases.set(
        element.name.text,
        holdsMatterId ? MATTER_ID_COLUMN : resolveName(key.text, aliases),
      );
    }
  }
};

const readFacts = (file: string, source: string): Facts => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
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
  const localFunctions = localFunctionNames(sourceFile);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Import specifiers name the imported symbols; they are not uses.
      recordImport(node, facts, aliases, file);
      return;
    }
    recordLocalAlias(node, aliases);
    if (ts.isIdentifier(node) && !isLocalAliasName(node)) {
      recordIdentifier(node, facts, aliases);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "member" &&
      node.name.text === "role"
    ) {
      facts.namesMemberRole = true;
    }
    if (isMatterSetPredicate(node, aliases, localFunctions)) {
      facts.workspaceSet.add(node);
    }
    // sql`${entities.workspaceId} = ANY(${ids})`: an interpolated matter
    // column opening a set predicate.
    if (
      ts.isTemplateSpan(node) &&
      isMatterIdColumn(node.expression, aliases) &&
      SQL_SET_AFTER_COLUMN.test(node.literal.text)
    ) {
      facts.workspaceSet.add(node);
    }
    const text = literalText(node);
    if (text !== undefined) {
      recordLiteral(node, text, facts);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
