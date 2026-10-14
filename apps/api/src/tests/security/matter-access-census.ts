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
 *   module: it calls a value-imported owner export, and every concrete filter
 *   (`inArray` set or SQL `ANY`/`IN` value) is wholly derived from such a call
 *   (see `derivesFromOwner`: only narrowings, never mixes; a binding derives
 *   only if every assignment does and it is never mutated in place). Values
 *   passed in from callers, shadowed names and values mutated through another
 *   function count as not proven, except the last, a documented blind spot.
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
const SQL_WORKSPACE_SET_BEFORE_VALUE =
  /\bworkspace_id\s*(?:=\s*any|in)\s*\(\s*$/iu;
const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);

const NARROWING_METHODS = new Set(["filter", "slice", "toSorted"]);
const MUTATING_METHODS = new Set([
  "push",
  "unshift",
  "splice",
  "fill",
  "copyWithin",
  "add",
  "set",
]);

/** Every identifier a declaration binds, through destructuring. */
const boundNames = (name: ts.BindingName): string[] => {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : boundNames(element.name),
  );
};

type Facts = {
  /** The owner module is value-imported and one of its exports is called. */
  callsOwner: boolean;
  /**
   * Every concrete workspace-set filter (`inArray(x.workspaceId, set)`, or a
   * SQL `workspace_id = ANY(${set})` / `IN (${set})`) takes a value derived
   * from an owner call. True when the module has no concrete filter.
   */
  filtersDeriveFromOwner: boolean;
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

type ProvenanceInput = {
  ownerBindings: ReadonlySet<string>;
  ownerNamespaces: ReadonlySet<string>;
  derivations: readonly { names: string[]; from: ts.Node | null }[];
  mutatedNames: ReadonlySet<string>;
};

const ownerProvenance = ({
  ownerBindings,
  ownerNamespaces,
  derivations,
  mutatedNames,
}: ProvenanceInput) => {
  // Provenance is conservative. A value derives from the owner only when the
  // WHOLE value is the owner's result or a narrowing of it: the owner call
  // itself (awaited or not), a property read on a derived value, a
  // `filter`/`slice`/`toSorted` of one, a `map` that projects one property of
  // each element, a spread/`Array.from`/`new Set` of exactly one derived
  // value, or a conditional whose branches both derive. Anything that can mix
  // in other values (array literals with other elements, concat, arbitrary
  // calls) does not. A binding derives only when EVERY assignment to it does
  // and it is never mutated in place; parameters never derive. Names are
  // tracked file-wide, so shadowing errs towards "not derived".
  const isOwnerCall = (node: ts.Node) =>
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) &&
      ownerBindings.has(node.expression.text)) ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        ownerNamespaces.has(node.expression.expression.text)));
  const isPropertyProjection = (node: ts.Expression | undefined) => {
    if (node === undefined || !ts.isArrowFunction(node)) {
      return false;
    }
    const [parameter] = node.parameters;
    return (
      node.parameters.length === 1 &&
      parameter !== undefined &&
      ts.isIdentifier(parameter.name) &&
      ts.isPropertyAccessExpression(node.body) &&
      ts.isIdentifier(node.body.expression) &&
      node.body.expression.text === parameter.name.text
    );
  };
  const derived = new Set<string>();
  const derivesFromOwner = (node: ts.Node): boolean => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return derivesFromOwner(node.expression);
    }
    if (isOwnerCall(node)) {
      return true;
    }
    if (ts.isIdentifier(node)) {
      return derived.has(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return derivesFromOwner(node.expression);
    }
    if (ts.isConditionalExpression(node)) {
      return (
        derivesFromOwner(node.whenTrue) && derivesFromOwner(node.whenFalse)
      );
    }
    if (ts.isArrayLiteralExpression(node)) {
      const [only] = node.elements;
      return (
        node.elements.length === 1 &&
        only !== undefined &&
        ts.isSpreadElement(only) &&
        derivesFromOwner(only.expression)
      );
    }
    if (ts.isNewExpression(node)) {
      const [only] = node.arguments ?? [];
      return (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Set" &&
        node.arguments?.length === 1 &&
        only !== undefined &&
        derivesFromOwner(only)
      );
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first] = node.arguments;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Array" &&
        callee.name.text === "from"
      ) {
        return node.arguments.length === 1 && first !== undefined
          ? derivesFromOwner(first)
          : false;
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (NARROWING_METHODS.has(method)) {
          return derivesFromOwner(callee.expression);
        }
        if (method === "map") {
          return (
            node.arguments.length === 1 &&
            isPropertyProjection(first) &&
            derivesFromOwner(callee.expression)
          );
        }
      }
    }
    return false;
  };
  // Least fixpoint: a name joins only once all of its assignments derive.
  const assignmentsByName = new Map<string, (ts.Node | null)[]>();
  for (const { names, from } of derivations) {
    for (const name of names) {
      assignmentsByName.set(name, [
        ...(assignmentsByName.get(name) ?? []),
        from,
      ]);
    }
  }
  // An alias shares its source's object: `const alias = ids` (or
  // `= holder.value`) followed by `alias.push(other)` mutates `ids` /
  // `holder` too. Close the mutated set backwards over every alias edge.
  const aliasRoot = (node: ts.Node | null): string | undefined => {
    if (node === null) {
      return undefined;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      return aliasRoot(node.expression);
    }
    return ts.isIdentifier(node) ? node.text : undefined;
  };
  const mutated = new Set(mutatedNames);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { names, from } of derivations) {
      const root = aliasRoot(from);
      if (
        root !== undefined &&
        !mutated.has(root) &&
        names.some((name) => mutated.has(name))
      ) {
        mutated.add(root);
        grew = true;
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, sources] of assignmentsByName) {
      if (
        !derived.has(name) &&
        !mutated.has(name) &&
        sources.every((from) => from !== null && derivesFromOwner(from))
      ) {
        derived.add(name);
        changed = true;
      }
    }
  }
  return { isOwnerCall, derivesFromOwner };
};

type DataFlow = {
  filterArguments: ts.Expression[];
  derivations: { names: string[]; from: ts.Node | null }[];
  mutatedNames: Set<string>;
};

/** Record filter values, assignments and in-place mutations of one node. */
const recordDataFlow = (
  node: ts.Node,
  { filterArguments, derivations, mutatedNames }: DataFlow,
): void => {
  if (ts.isTemplateExpression(node)) {
    let preceding = node.head.text;
    for (const span of node.templateSpans) {
      if (SQL_WORKSPACE_SET_BEFORE_VALUE.test(preceding)) {
        filterArguments.push(span.expression);
      }
      preceding = span.literal.text;
    }
  }
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
    derivations.push({
      names: boundNames(node.name),
      from: node.initializer,
    });
  }
  if (
    ts.isBinaryExpression(node) &&
    ts.isIdentifier(node.left) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    // `=`, `??=`, `||=` assign the right side; any other compound
    // assignment (`+=`, …) mixes values and never derives.
    derivations.push({
      names: [node.left.text],
      from: ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
        ? node.right
        : null,
    });
  }
  // In-place mutation (`ids.push(other)`, `set.add(other)`, `ids[i] = …`)
  // can mix in any value, so the mutated binding never derives.
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    MUTATING_METHODS.has(node.expression.name.text)
  ) {
    mutatedNames.add(node.expression.expression.text);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    ts.isElementAccessExpression(node.left) &&
    ts.isIdentifier(node.left.expression)
  ) {
    mutatedNames.add(node.left.expression.text);
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
    callsOwner: false,
    filtersDeriveFromOwner: true,
    importsRootDbValue: false,
    namesView: false,
    namesMembership: false,
    namesRoleRule: false,
    namesMemberRole: false,
    namesClientId: false,
    filtersWorkspaceSet: false,
  };
  const ownerBindings = new Set<string>();
  const ownerNamespaces = new Set<string>();
  /** Values handed to concrete workspace-set filters. */
  const filterArguments: ts.Expression[] = [];
  /** `name <- value` edges; `null` marks an assignment that never derives. */
  const derivations: { names: string[]; from: ts.Node | null }[] = [];
  const mutatedNames = new Set<string>();
  const flow: DataFlow = { filterArguments, derivations, mutatedNames };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      // Only value bindings can carry the owner's result; a type-only import
      // (whole clause or one specifier) proves nothing.
      if (
        specifier === AUTHORIZED_WORKSPACE_OWNER_MODULE &&
        node.importClause?.isTypeOnly !== true &&
        bindings !== undefined
      ) {
        if (ts.isNamespaceImport(bindings)) {
          ownerNamespaces.add(bindings.name.text);
        } else {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) {
              ownerBindings.add(element.name.text);
            }
          }
        }
      }
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
      const [, set] = node.arguments;
      if (
        column !== undefined &&
        ts.isPropertyAccessExpression(column) &&
        column.name.text === "workspaceId"
      ) {
        facts.filtersWorkspaceSet = true;
        if (set !== undefined) {
          filterArguments.push(set);
        }
      }
    }
    recordDataFlow(node, flow);
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

  const { isOwnerCall, derivesFromOwner } = ownerProvenance({
    ownerBindings,
    ownerNamespaces,
    derivations,
    mutatedNames,
  });
  const findOwnerCall = (node: ts.Node): boolean =>
    isOwnerCall(node) ||
    (ts.forEachChild(node, (child) => findOwnerCall(child) || undefined) ??
      false);
  facts.callsOwner = findOwnerCall(sourceFile);
  facts.filtersDeriveFromOwner = filterArguments.every(derivesFromOwner);
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
      // An import alone proves nothing: the owner must be called, and every
      // concrete filter must take a value derived from that call.
      screened: facts.callsOwner && facts.filtersDeriveFromOwner,
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
