import ts from "typescript";

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
 *   (`CLIENT_MATTER_ADMIN_ROLES`, `canWriteWorkspaceEntities`,
 *   `WORKSPACE_ACCESS_BY_ROLE`, or a member role together with a client id),
 *   i.e. it computes the view's rule a second time. No module may.
 * - `owner-connection-workspace-set`: it imports the owner connection
 *   (`rootDb`, which row policies do not filter) as a value and filters by a
 *   matter-id set: `inArray(<table>.workspaceId | workspaces.id, …)` under any
 *   local or namespaced name, SQL `workspace_id = ANY(` / `IN` (literal or
 *   with an interpolated matter column), or an `accessibleWorkspaceIds` /
 *   `activeWorkspaceIds` binding.
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

export const MATTER_ACCESS_SIGNALS = [
  "reads-authorization-view",
  "derives-matter-access",
  "owner-connection-workspace-set",
] as const;

export type MatterAccessSignal = (typeof MATTER_ACCESS_SIGNALS)[number];

/** Occurrences of a signal per enclosing symbol path (`<module>` at top). */
export type MatterAccessSites = Record<string, number>;

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
  "canWriteWorkspaceEntities",
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

/**
 * A column that holds a matter id: any `<table>.workspaceId`, or the
 * matters table's own `workspaces.id`.
 */
const isMatterIdColumn = (column: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(column) &&
  (column.name.text === "workspaceId" ||
    (column.name.text === "id" &&
      ts.isIdentifier(column.expression) &&
      column.expression.text === "workspaces"));

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
  for (let current = node.parent; current !== undefined;) {
    const name = declarationName(current);
    if (name !== undefined) {
      names.unshift(name);
    }
    current = current.parent;
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
};

/** Local names that refer to drizzle's `inArray`, direct or namespaced. */
type InArrayNames = { direct: Set<string>; namespaces: Set<string> };

/** Local name -> imported name for every renamed value import. */
type ImportedNames = Map<string, string>;

const recordImport = (
  node: ts.ImportDeclaration,
  facts: Facts,
  inArray: InArrayNames,
  imported: ImportedNames,
) => {
  if (
    !ts.isStringLiteral(node.moduleSpecifier) ||
    node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
  ) {
    return;
  }
  const specifier = node.moduleSpecifier.text;
  const bindings = node.importClause?.namedBindings;
  if (bindings === undefined) {
    return;
  }
  if (ts.isNamespaceImport(bindings)) {
    // `root.rootDb` reaches the owner connection without naming it here.
    if (specifier === "@/api/db/root") {
      facts.importsRootDbValue = true;
    }
  } else {
    for (const element of bindings.elements) {
      if (!element.isTypeOnly && element.propertyName !== undefined) {
        imported.set(element.name.text, element.propertyName.text);
      }
    }
  }
  if (specifier === "drizzle-orm") {
    if (ts.isNamespaceImport(bindings)) {
      inArray.namespaces.add(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        if (
          !element.isTypeOnly &&
          (element.propertyName ?? element.name).text === "inArray"
        ) {
          inArray.direct.add(element.name.text);
        }
      }
    }
  }
  if (
    specifier === "@/api/db/root" &&
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

const isInArrayCall = (
  node: ts.Node,
  inArray: InArrayNames,
): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) &&
    inArray.direct.has(node.expression.text)) ||
    (ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      inArray.namespaces.has(node.expression.expression.text) &&
      node.expression.name.text === "inArray"));

const recordIdentifier = (
  node: ts.Identifier,
  facts: Facts,
  imported: ImportedNames,
) => {
  // A renamed import is a use of the original name.
  const name = imported.get(node.text) ?? node.text;
  if (VIEW_IDENTIFIERS.has(name)) {
    facts.view.add(node);
  }
  if (name === "workspaceMembers") {
    facts.membership.add(node);
  }
  if (ROLE_RULE_IDENTIFIERS.has(name)) {
    facts.namesRoleRule = true;
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
  };
  const inArray: InArrayNames = { direct: new Set(), namespaces: new Set() };
  const imported: ImportedNames = new Map();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Import specifiers name the imported symbols; they are not uses.
      recordImport(node, facts, inArray, imported);
      return;
    }
    if (ts.isIdentifier(node)) {
      recordIdentifier(node, facts, imported);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "member" &&
      node.name.text === "role"
    ) {
      facts.namesMemberRole = true;
    }
    if (isInArrayCall(node, inArray)) {
      const [column] = node.arguments;
      if (column !== undefined && isMatterIdColumn(column)) {
        facts.workspaceSet.add(node);
      }
    }
    // sql`${entities.workspaceId} = ANY(${ids})`: an interpolated matter
    // column opening a set predicate.
    if (
      ts.isTemplateSpan(node) &&
      isMatterIdColumn(node.expression) &&
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
  /stellaAuthorizedWorkspaces|WORKSPACE_ACCESS_VIEW_NAME|stella_authorized_workspaces|workspaceMembers|workspace_members|rootDb|@\/api\/db\/root/u;

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
    findings.push({
      file,
      signal: "owner-connection-workspace-set",
      screened: false,
      sites: facts.workspaceSet.sites,
    });
  }
  return findings;
};

export const allowlistKey = ({
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
