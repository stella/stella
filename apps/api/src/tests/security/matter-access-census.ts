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
 *   workspace-id set (`inArray(<table>.workspaceId, …)`, `workspace_id = ANY(…)`,
 *   `workspace_id IN (…)`, or an `accessibleWorkspaceIds` /
 *   `activeWorkspaceIds` binding). It must obtain the set from the owner
 *   module.
 *
 * A member that does not meet its signal's rule fails the census unless the
 * allowlist names `<file>::<signal>` with a reason.
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

export type MatterAccessFinding = {
  file: string;
  signal: MatterAccessSignal;
  /** Whether the module meets the rule for this signal on its own. */
  screened: boolean;
};

const VIEW_IDENTIFIERS = new Set([
  "stellaAuthorizedWorkspaces",
  "WORKSPACE_ACCESS_VIEW_NAME",
]);
const VIEW_SQL_NAME = "stella_authorized_workspaces";
const ROLE_RULE_IDENTIFIERS = new Set([
  "CLIENT_MATTER_ADMIN_ROLES",
  "canWriteWorkspaceEntities",
  "WORKSPACE_ACCESS_BY_ROLE",
]);
const WORKSPACE_SET_IDENTIFIERS = new Set([
  "accessibleWorkspaceIds",
  "activeWorkspaceIds",
]);
const SQL_MEMBERSHIP = /\bworkspace_members\b/u;
const SQL_MEMBER_ROLE = /\b[a-z_]+\.role\b/u;
const SQL_CLIENT_ID = /\bclient_id\b/u;
const SQL_WORKSPACE_SET = /\bworkspace_id\s*(?:=\s*any|in)\s*\(/iu;

type Facts = {
  importsOwner: boolean;
  importsRootDbValue: boolean;
  namesView: boolean;
  namesMembership: boolean;
  namesRoleRule: boolean;
  namesMemberRole: boolean;
  namesClientId: boolean;
  filtersWorkspaceSet: boolean;
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

const readFacts = (file: string, source: string): Facts => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const facts: Facts = {
    importsOwner: false,
    importsRootDbValue: false,
    namesView: false,
    namesMembership: false,
    namesRoleRule: false,
    namesMemberRole: false,
    namesClientId: false,
    filtersWorkspaceSet: false,
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (specifier === AUTHORIZED_WORKSPACE_OWNER_MODULE) {
        facts.importsOwner = true;
      }
      const bindings = node.importClause?.namedBindings;
      if (
        specifier === "@/api/db/root" &&
        node.importClause?.isTypeOnly !== true &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          (element) =>
            !element.isTypeOnly &&
            (element.propertyName ?? element.name).text === "rootDb",
        )
      ) {
        facts.importsRootDbValue = true;
      }
      // Import specifiers name the imported symbols; they are not uses.
      return;
    }
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (VIEW_IDENTIFIERS.has(name)) {
        facts.namesView = true;
      }
      if (name === "workspaceMembers") {
        facts.namesMembership = true;
      }
      if (ROLE_RULE_IDENTIFIERS.has(name)) {
        facts.namesRoleRule = true;
      }
      if (name === "clientId") {
        facts.namesClientId = true;
      }
      if (WORKSPACE_SET_IDENTIFIERS.has(name)) {
        facts.filtersWorkspaceSet = true;
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "member" &&
      node.name.text === "role"
    ) {
      facts.namesMemberRole = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "inArray"
    ) {
      const [column] = node.arguments;
      if (
        column !== undefined &&
        ts.isPropertyAccessExpression(column) &&
        column.name.text === "workspaceId"
      ) {
        facts.filtersWorkspaceSet = true;
      }
    }
    const text = literalText(node);
    if (text !== undefined) {
      if (text.includes(VIEW_SQL_NAME)) {
        facts.namesView = true;
      }
      if (SQL_MEMBERSHIP.test(text)) {
        facts.namesMembership = true;
      }
      if (SQL_MEMBER_ROLE.test(text)) {
        facts.namesMemberRole = true;
      }
      if (SQL_CLIENT_ID.test(text)) {
        facts.namesClientId = true;
      }
      if (SQL_WORKSPACE_SET.test(text)) {
        facts.filtersWorkspaceSet = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return facts;
};

// Cheap prefilter so only candidate files are parsed.
const CANDIDATE =
  /stellaAuthorizedWorkspaces|WORKSPACE_ACCESS_VIEW_NAME|stella_authorized_workspaces|workspaceMembers|workspace_members|rootDb/u;

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
  if (facts.namesView) {
    findings.push({
      file,
      signal: "reads-authorization-view",
      screened: file === AUTHORIZED_WORKSPACE_OWNER_FILE,
    });
  }
  if (
    facts.namesMembership &&
    (facts.namesRoleRule || (facts.namesMemberRole && facts.namesClientId))
  ) {
    findings.push({ file, signal: "derives-matter-access", screened: false });
  }
  if (facts.importsRootDbValue && facts.filtersWorkspaceSet) {
    findings.push({
      file,
      signal: "owner-connection-workspace-set",
      screened: facts.importsOwner,
    });
  }
  return findings;
};

export const allowlistKey = ({
  file,
  signal,
}: Pick<MatterAccessFinding, "file" | "signal">) => `${file}::${signal}`;

/**
 * The unscreened findings no allowlist entry covers, and the allowlist entries
 * that no longer match an unscreened finding (stale entries fail too, so the
 * allowlist shrinks as paths move onto the owner module).
 */
export const evaluateMatterAccessCensus = (
  findings: readonly MatterAccessFinding[],
  allowlist: Readonly<Record<string, string>>,
) => {
  const unscreened = new Set(
    findings
      .filter((finding) => !finding.screened)
      .map((finding) => allowlistKey(finding)),
  );
  return {
    violations: [...unscreened].filter((key) => !(key in allowlist)).toSorted(),
    stale: Object.keys(allowlist)
      .filter((key) => !unscreened.has(key))
      .toSorted(),
  };
};
