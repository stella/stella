import { panic } from "better-result";
import { getTableName, is } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgRole } from "drizzle-orm/pg-core";
import type {
  AnyPgColumn,
  PgTable,
  PgPolicy,
  PgPolicyConfig,
} from "drizzle-orm/pg-core";

import { compareCodeUnit } from "@stll/collation";

import { entityReferenceClassification } from "./entity-feature-policies";

const ENTITY_FEATURE_POLICY_NAME = "workspace_entity_feature";
const DIALECT = new PgDialect();

type EntityFeatureGateReference = {
  column: string;
  parent: string;
  hasForeignKey: boolean;
  sameWorkspace: boolean;
  sameOrganization: boolean;
};

export type EntityFeatureGateDescriptor = {
  tableName: string;
  primaryKey: readonly string[];
  /** Minimal parent read, including references needed while backfill is pending. */
  projection: string;
  refs: readonly EntityFeatureGateReference[];
  /** True when the table's own app-role SELECT policy enforces workspace scope. */
  ownWorkspace: boolean;
  /** True when the table's own app-role SELECT policy enforces organization scope. */
  ownOrganization: boolean;
  /** Requires the workspace scope array for a derived parent feature gate. */
  needsWorkspace: boolean;
  /** Requires the organization scope array for a derived parent feature gate. */
  needsOrganization: boolean;
};

type Relation = {
  column: string;
  parent: string;
  hasForeignKey: boolean;
  sameWorkspace: boolean;
  sameOrganization: boolean;
};

const targetsApplicationRole = (to: PgPolicyConfig["to"]): boolean => {
  if (Array.isArray(to)) {
    return to.some(targetsApplicationRole);
  }
  return (
    to === undefined ||
    to === "public" ||
    to === "stella" ||
    (is(to, PgRole) && (to.name === "stella" || to.name === "public"))
  );
};

const policySql = (value: SQL | undefined) =>
  value === undefined ? "" : DIALECT.sqlToQuery(value).sql;

const compactSql = (expression: string) =>
  expression.toLowerCase().replace(/\s+/gu, "");

const WORKSPACE_SCOPE_SQL = compactSql(
  "CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END",
);
const ORGANIZATION_SCOPE_SQL = compactSql(
  "organization_id = (SELECT current_setting('app.organization_id', true))",
);

const hasOuterParentheses = (expression: string) => {
  if (!expression.startsWith("(") || !expression.endsWith(")")) {
    return false;
  }
  let depth = 0;
  let quote = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "'" && expression[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = !quote;
      continue;
    }
    if (quote) {
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0 && index < expression.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
};

const conjunctionTerms = (input: string): string[] => {
  const expression = input.trim();
  if (hasOuterParentheses(expression)) {
    return conjunctionTerms(expression.slice(1, -1));
  }
  const terms: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "'" && expression[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = !quote;
      continue;
    }
    if (quote) {
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (
      depth === 0 &&
      expression.slice(index, index + 2).toLowerCase() === "or" &&
      !/[\w]/u.test(expression[index - 1] ?? "") &&
      !/[\w]/u.test(expression[index + 2] ?? "")
    ) {
      return [compactSql(expression)];
    }
    if (
      depth === 0 &&
      expression.slice(index, index + 3).toLowerCase() === "and" &&
      !/[\w]/u.test(expression[index - 1] ?? "") &&
      !/[\w]/u.test(expression[index + 3] ?? "")
    ) {
      terms.push(...conjunctionTerms(expression.slice(start, index)));
      index += 2;
      start = index + 1;
    }
  }
  const tail = expression.slice(start);
  if (start === 0) {
    return [compactSql(tail)];
  }
  terms.push(...conjunctionTerms(tail));
  return terms;
};

const ownerOnlyExpression = (table: PgTable, expression: SQL | undefined) => {
  const config = getTableConfig(table);
  const owner =
    compactSql(`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = '${config.schema ?? "public"}.${config.name}'::regclass)`);
  return conjunctionTerms(policySql(expression)).includes(owner);
};

const ownerOnlySelect = (table: PgTable, policy: PgPolicy) =>
  // stella is a non-owning application role; these maintenance policies grant
  // only the table owner and therefore add no application SELECT alternative.
  ownerOnlyExpression(table, policy.using);

const assertCacheableParent = (table: PgTable) => {
  const policies = getTableConfig(table).policies.filter(
    (policy) =>
      policy.name !== ENTITY_FEATURE_POLICY_NAME &&
      targetsApplicationRole(policy.to) &&
      (policy.for === undefined ||
        policy.for === "select" ||
        policy.for === "all") &&
      !ownerOnlySelect(table, policy),
  );
  const permissive = policies.filter((policy) => policy.as !== "restrictive");
  const signatures = permissive.map((policy) =>
    conjunctionTerms(policySql(policy.using)).toSorted().join("&"),
  );
  if (
    permissive.length === 0 ||
    new Set(signatures).size !== 1 ||
    policies.some((policy) =>
      conjunctionTerms(policySql(policy.using)).some(
        (term) =>
          term !== WORKSPACE_SCOPE_SQL && term !== ORGANIZATION_SCOPE_SQL,
      ),
    )
  ) {
    panic(
      `Entity feature parent ${getTableName(table)} has SELECT requirements that cannot be stored as tenant scope`,
    );
  }
};

const policyScopesColumn = (
  table: PgTable,
  scope: "workspace" | "organization",
): boolean => {
  const config = getTableConfig(table);
  const column = scope === "workspace" ? "workspace_id" : "organization_id";
  if (!config.columns.some((candidate) => candidate.name === column)) {
    return false;
  }
  const selectPolicies = config.policies.filter(
    (policy) =>
      policy.name !== ENTITY_FEATURE_POLICY_NAME &&
      targetsApplicationRole(policy.to) &&
      (policy.for === undefined ||
        policy.for === "select" ||
        policy.for === "all") &&
      !ownerOnlySelect(table, policy),
  );
  const scopeSql =
    scope === "workspace" ? WORKSPACE_SCOPE_SQL : ORGANIZATION_SCOPE_SQL;
  const scopes = (policy: (typeof selectPolicies)[number]) =>
    conjunctionTerms(policySql(policy.using)).includes(scopeSql);
  const scopePolicyName =
    scope === "workspace"
      ? (name: string) =>
          name === "workspace_select" || name.endsWith("_workspace_select")
      : (name: string) =>
          name === "organization_select" ||
          name.endsWith("_organization_select");
  for (const policy of selectPolicies) {
    if (scopePolicyName(policy.name) && !scopes(policy)) {
      return panic(
        `${config.name}.${policy.name} no longer has a canonical ${scope} scope`,
      );
    }
  }
  const restrictive = selectPolicies.some(
    (policy) => policy.as === "restrictive" && scopes(policy),
  );
  if (restrictive) {
    return true;
  }
  const permissive = selectPolicies.filter(
    (policy) => policy.as !== "restrictive",
  );
  return permissive.length > 0 && permissive.every(scopes);
};

const assertWriteScope = (
  table: PgTable,
  scope: "workspace" | "organization",
) => {
  const config = getTableConfig(table);
  const scopeSql =
    scope === "workspace" ? WORKSPACE_SCOPE_SQL : ORGANIZATION_SCOPE_SQL;
  for (const action of ["insert", "update"] as const) {
    const policies = config.policies.filter(
      (policy) =>
        policy.name !== ENTITY_FEATURE_POLICY_NAME &&
        targetsApplicationRole(policy.to) &&
        (policy.for === undefined ||
          policy.for === "all" ||
          policy.for === action) &&
        (action === "update" ||
          !ownerOnlyExpression(
            table,
            policy.withCheck ??
              (policy.for === "insert" ? undefined : policy.using),
          )),
    );
    const permissive = policies.filter((policy) => policy.as !== "restrictive");
    const restrictive = policies.filter(
      (policy) => policy.as === "restrictive",
    );
    const checkExpression = (policy: PgPolicy) =>
      policySql(
        policy.withCheck ??
          (policy.for === "insert" ? undefined : policy.using),
      );
    const terms = (expression: string) => conjunctionTerms(expression);
    const denies = (expression: string) => terms(expression).includes("false");
    const hasScope = (expression: string) =>
      terms(expression).includes(scopeSql);
    const permissiveChecks = permissive.filter(
      (policy) =>
        !denies(checkExpression(policy)) &&
        !ownerOnlyExpression(
          table,
          action === "insert"
            ? (policy.withCheck ??
                (policy.for === "insert" ? undefined : policy.using))
            : (policy.withCheck ?? policy.using),
        ),
    );
    const permissiveUsing = permissive.filter(
      (policy) =>
        !denies(policySql(policy.using)) && !ownerOnlySelect(table, policy),
    );
    const restrictiveDenial = restrictive.some(
      (policy) =>
        denies(checkExpression(policy)) ||
        ownerOnlyExpression(
          table,
          action === "insert"
            ? (policy.withCheck ??
                (policy.for === "insert" ? undefined : policy.using))
            : (policy.withCheck ?? policy.using),
        ) ||
        (action === "update" &&
          (denies(policySql(policy.using)) || ownerOnlySelect(table, policy))),
    );
    if (
      permissiveChecks.length === 0 ||
      (action === "update" && permissiveUsing.length === 0) ||
      restrictiveDenial
    ) {
      continue;
    }
    if (
      restrictive.some((policy) => hasScope(checkExpression(policy))) ||
      permissiveChecks.every((policy) => hasScope(checkExpression(policy)))
    ) {
      continue;
    }
    panic(
      `${config.name} no longer enforces its canonical ${scope} scope for ${action.toUpperCase()} checks`,
    );
  }
};

const isEntityPolicyRoot = (table: PgTable) =>
  getTableConfig(table).columns.some(
    (column) => column.name === "list_item_type",
  );

const hasForeignKeyToId = (
  table: PgTable,
  column: AnyPgColumn,
  targetTable: string,
  visited = new Set<string>(),
): boolean => {
  const tableName = getTableName(table);
  if (tableName === targetTable && column.name === "id") {
    return true;
  }
  const state = `${tableName}.${column.name}`;
  if (visited.has(state)) {
    return false;
  }
  visited.add(state);
  return getTableConfig(table).foreignKeys.some((foreignKey) => {
    const reference = foreignKey.reference();
    const index = reference.columns.findIndex(
      (source) => source.name === column.name,
    );
    if (index === -1) {
      return false;
    }
    const parentColumn = reference.foreignColumns[index];
    return (
      parentColumn !== undefined &&
      hasForeignKeyToId(
        reference.foreignTable,
        parentColumn,
        targetTable,
        visited,
      )
    );
  });
};

type PairedForeignKeyChainOptions = {
  table: PgTable;
  relationColumn: AnyPgColumn;
  scopeColumn: AnyPgColumn;
  targetTable: string;
  targetScopeColumn: string;
  visited?: Set<string>;
};

const pairedForeignKeyChain = ({
  table,
  relationColumn,
  scopeColumn,
  targetTable,
  targetScopeColumn,
  visited = new Set<string>(),
}: PairedForeignKeyChainOptions): boolean => {
  const tableName = getTableName(table);
  if (
    tableName === targetTable &&
    relationColumn.name === "id" &&
    scopeColumn.name === targetScopeColumn
  ) {
    return true;
  }
  const state = `${tableName}.${relationColumn.name}\u0000${scopeColumn.name}`;
  if (visited.has(state)) {
    return false;
  }
  visited.add(state);
  return getTableConfig(table).foreignKeys.some((foreignKey) => {
    const reference = foreignKey.reference();
    const relationIndex = reference.columns.findIndex(
      (source) => source.name === relationColumn.name,
    );
    const scopeIndex = reference.columns.findIndex(
      (source) => source.name === scopeColumn.name,
    );
    if (relationIndex === -1 || scopeIndex === -1) {
      return false;
    }
    const parentRelation = reference.foreignColumns[relationIndex];
    const parentScope = reference.foreignColumns[scopeIndex];
    return (
      parentRelation !== undefined &&
      parentScope !== undefined &&
      pairedForeignKeyChain({
        table: reference.foreignTable,
        relationColumn: parentRelation,
        scopeColumn: parentScope,
        targetTable,
        targetScopeColumn,
        visited,
      })
    );
  });
};

const pairedScope = (
  table: PgTable,
  column: AnyPgColumn,
  parent: string,
  scope: "workspace" | "organization",
): boolean => {
  const scopeColumn = getTableConfig(table).columns.find(
    (candidate) => candidate.name === `${scope}_id`,
  );
  return (
    scopeColumn !== undefined &&
    pairedForeignKeyChain({
      table,
      relationColumn: column,
      scopeColumn,
      targetTable: parent,
      targetScopeColumn: `${scope}_id`,
    })
  );
};

const hasWorkspaceOrganizationPair = (table: PgTable) => {
  const columns = getTableConfig(table).columns;
  const workspaceColumn = columns.find(
    (column) => column.name === "workspace_id",
  );
  const organizationColumn = columns.find(
    (column) => column.name === "organization_id",
  );
  return (
    workspaceColumn !== undefined &&
    organizationColumn !== undefined &&
    pairedForeignKeyChain({
      table,
      relationColumn: workspaceColumn,
      scopeColumn: organizationColumn,
      targetTable: "workspaces",
      targetScopeColumn: "organization_id",
    })
  );
};

const relationsOf = (
  table: PgTable,
  tablesByName: ReadonlyMap<string, PgTable>,
): Relation[] => {
  if (isEntityPolicyRoot(table)) {
    return [];
  }
  const refs = new Map<string, Relation>();
  for (const column of getTableConfig(table).columns) {
    const classification = entityReferenceClassification(column);
    if (classification === undefined || classification.kind === "context") {
      continue;
    }
    const parent =
      classification.kind === "owned-by-parent"
        ? getTableName(classification.parent)
        : classification.target;
    const hasForeignKey = hasForeignKeyToId(table, column, parent);
    const sameWorkspace = pairedScope(table, column, parent, "workspace");
    const parentTable = tablesByName.get(parent);
    const sameOrganization =
      pairedScope(table, column, parent, "organization") ||
      (sameWorkspace &&
        parentTable !== undefined &&
        hasWorkspaceOrganizationPair(table) &&
        hasWorkspaceOrganizationPair(parentTable));
    const relation = {
      column: column.name,
      parent,
      hasForeignKey,
      sameWorkspace,
      sameOrganization,
    };
    const key = `${relation.column}\u0000${relation.parent}`;
    const previous = refs.get(key);
    refs.set(key, {
      ...relation,
      hasForeignKey: relation.hasForeignKey || previous?.hasForeignKey === true,
      sameWorkspace: relation.sameWorkspace || previous?.sameWorkspace === true,
      sameOrganization:
        relation.sameOrganization || previous?.sameOrganization === true,
    });
  }
  return [...refs.values()].toSorted(
    (left, right) =>
      compareCodeUnit(left.parent, right.parent) ||
      compareCodeUnit(left.column, right.column),
  );
};

const primaryKeyColumns = (table: PgTable): string[] => {
  const config = getTableConfig(table);
  const primary = [
    ...config.columns
      .filter((column) => column.primary)
      .map((column) => column.name),
    ...config.primaryKeys.flatMap((key) =>
      key.columns.map((column) => column.name),
    ),
  ].filter((column, index, columns) => columns.indexOf(column) === index);
  if (primary.length > 0) {
    return primary;
  }
  // A non-null unique key is also a stable checkpoint identity (evidence rows
  // have a compound source identity rather than a surrogate primary key).
  for (const index of config.indexes) {
    if (!index.config.unique || index.config.where !== undefined) {
      continue;
    }
    const names = index.config.columns.flatMap((column) =>
      "name" in column && typeof column.name === "string" ? [column.name] : [],
    );
    if (
      names.length === index.config.columns.length &&
      names.every((name) =>
        config.columns.some((column) => column.name === name && column.notNull),
      )
    ) {
      return names;
    }
  }
  return [];
};

const gateReadProjection = (table: PgTable, refs: readonly Relation[]) => {
  const config = getTableConfig(table);
  const names = [
    ...new Set([
      "id",
      "workspace_id",
      "organization_id",
      "list_item_type",
      "entity_feature_gate",
      "entity_feature_workspace_ids",
      "entity_feature_organization_ids",
      ...refs.map((ref) => ref.column),
      ...primaryKeyColumns(table),
    ]),
  ].filter((name) => config.columns.some((column) => column.name === name));
  return `jsonb_build_object(${names.map((name) => `'${name}', p."${name}"`).join(", ")})`;
};

/**
 * Derives the entity feature gate graph from registered classifications, schema
 * foreign keys, and app-role scope policies; no table census is copied here.
 */
export const entityFeatureGateMetadata = (
  tables: readonly PgTable[],
): EntityFeatureGateDescriptor[] => {
  const byName = new Map(tables.map((table) => [getTableName(table), table]));
  const allRelations = new Map(
    tables.map((table) => [getTableName(table), relationsOf(table, byName)]),
  );
  const included = new Set<string>();
  for (const table of tables) {
    if (isEntityPolicyRoot(table)) {
      included.add(getTableName(table));
    }
  }
  for (const [tableName, refs] of allRelations) {
    if (refs.length > 0) {
      included.add(tableName);
      for (const reference of refs) {
        included.add(reference.parent);
      }
    }
  }

  const descriptors = new Map<string, EntityFeatureGateDescriptor>();
  for (const tableName of included) {
    const table = byName.get(tableName);
    if (table === undefined) {
      continue;
    }
    const refs = allRelations.get(tableName);
    if (refs === undefined) {
      panic(`Missing entity feature relations for ${tableName}`);
    }
    const ownWorkspace = policyScopesColumn(table, "workspace");
    const ownOrganization = policyScopesColumn(table, "organization");
    if (ownWorkspace) {
      assertWriteScope(table, "workspace");
    }
    if (ownOrganization) {
      assertWriteScope(table, "organization");
    }
    descriptors.set(tableName, {
      tableName,
      primaryKey: primaryKeyColumns(table),
      projection: gateReadProjection(table, refs),
      refs,
      ownWorkspace,
      ownOrganization,
      needsWorkspace: false,
      needsOrganization: false,
    });
  }

  for (const parentName of new Set(
    [...descriptors.values()].flatMap((descriptor) =>
      descriptor.refs.map((reference) => reference.parent),
    ),
  )) {
    const parent = byName.get(parentName);
    if (parent !== undefined) {
      assertCacheableParent(parent);
    }
  }
  const ordered = topologicalOrder(descriptors);
  for (const descriptor of ordered) {
    const requirements = descriptor.refs.flatMap((reference) => {
      const parent = descriptors.get(reference.parent);
      if (parent === undefined) {
        return [];
      }
      return [{ parent, reference }];
    });
    descriptor.needsWorkspace = requirements.some(
      ({ parent, reference }) =>
        parent.needsWorkspace ||
        (parent.ownWorkspace &&
          !(descriptor.ownWorkspace && reference.sameWorkspace)),
    );
    descriptor.needsOrganization = requirements.some(
      ({ parent, reference }) =>
        parent.needsOrganization ||
        (parent.ownOrganization &&
          !(descriptor.ownOrganization && reference.sameOrganization)),
    );
    // Root entity rows establish the source scope and add no gate predicate.
    const table = byName.get(descriptor.tableName);
    if (
      table !== undefined &&
      isEntityPolicyRoot(table) &&
      descriptor.refs.length === 0
    ) {
      descriptor.needsWorkspace = false;
      descriptor.needsOrganization = false;
    }
  }

  return ordered;
};

const topologicalOrder = (
  descriptors: ReadonlyMap<string, EntityFeatureGateDescriptor>,
): EntityFeatureGateDescriptor[] => {
  const visited = new Set<string>();
  const active = new Set<string>();
  const ordered: EntityFeatureGateDescriptor[] = [];
  const visit = (tableName: string) => {
    if (visited.has(tableName)) {
      return;
    }
    if (active.has(tableName)) {
      panic(`Entity feature gate references contain a cycle at ${tableName}`);
    }
    active.add(tableName);
    const descriptor = descriptors.get(tableName);
    if (descriptor !== undefined) {
      for (const parentName of descriptor.refs
        .map((reference) => reference.parent)
        .filter((parent) => descriptors.has(parent))
        .toSorted(compareCodeUnit)) {
        visit(parentName);
      }
      ordered.push(descriptor);
    }
    active.delete(tableName);
    visited.add(tableName);
  };
  for (const tableName of [...descriptors.keys()].toSorted(compareCodeUnit)) {
    visit(tableName);
  }
  return ordered;
};

/** Reports schema changes that would leave a derived gate without its scope key. */
export const entityFeatureGateMetadataViolations = (
  tables: readonly PgTable[],
): string[] => {
  const descriptors = entityFeatureGateMetadata(tables);
  const tablesByName = new Map(
    tables.map((table) => [getTableName(table), table]),
  );
  const descriptorNames = new Set(
    descriptors.map(({ tableName }) => tableName),
  );
  const violations: string[] = [];
  for (const [tableName, table] of tablesByName) {
    if (isEntityPolicyRoot(table) && !descriptorNames.has(tableName)) {
      violations.push(
        `${tableName} requires an entity feature gate descriptor`,
      );
    }
  }
  for (const descriptor of descriptors) {
    const table = tablesByName.get(descriptor.tableName);
    if (table === undefined) {
      violations.push(`${descriptor.tableName} has no schema table`);
      continue;
    }
    if (descriptor.primaryKey.length === 0) {
      violations.push(
        `${descriptor.tableName} requires a primary key for its feature gate`,
      );
    }
    const columns = new Set(
      getTableConfig(table).columns.map(({ name }) => name),
    );
    for (const reference of descriptor.refs) {
      if (!reference.hasForeignKey) {
        violations.push(
          `${descriptor.tableName}.${reference.column} requires a foreign key for its stored feature gate`,
        );
      }
    }
    if (!columns.has("entity_feature_gate")) {
      violations.push(`${descriptor.tableName} requires entity_feature_gate`);
    }
    if (
      descriptor.needsWorkspace &&
      !columns.has("entity_feature_workspace_ids")
    ) {
      violations.push(
        `${descriptor.tableName} requires entity_feature_workspace_ids for its feature gate`,
      );
    }
    if (
      descriptor.needsOrganization &&
      !columns.has("entity_feature_organization_ids")
    ) {
      violations.push(
        `${descriptor.tableName} requires entity_feature_organization_ids for its feature gate`,
      );
    }
    if (
      descriptor.refs.length > 0 &&
      !descriptor.refs.every((reference) =>
        descriptorNames.has(reference.parent),
      )
    ) {
      violations.push(
        `${descriptor.tableName} references a missing feature gate parent`,
      );
    }
  }
  return violations.toSorted(compareCodeUnit);
};
