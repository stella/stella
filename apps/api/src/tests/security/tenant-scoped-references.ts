import { panic } from "better-result";
import { SQL, is } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import type { ForeignKey } from "drizzle-orm/pg-core";

/**
 * Tenant-scoped references, read off the Drizzle schema.
 *
 * PostgreSQL checks a foreign key as the table owner, without row security,
 * so a reference by id alone accepts a row of another tenant whenever the
 * writer names one. A reference that carries the tenant column cannot: the
 * referenced key then includes the tenant, and a row of another tenant has a
 * different key.
 *
 * A table is tenant-owned when it carries `workspace_id` or
 * `organization_id`. For a reference from one tenant-owned table to another,
 * the binding column is the narrowest tenant column both carry that is NOT
 * NULL on the referencing side (a NULL in any column of a composite key skips
 * the whole check). The reference is tenant-scoped when a foreign key from the
 * same table to the same target covers every column of it and also maps the
 * binding column onto itself, or onto it through a nullable copy column whose
 * CHECK ties the copy to the binding column (the shape an ON DELETE SET NULL
 * reference needs, since setting the tenant column itself to NULL would break
 * the row). The covering key must name a unique key of the target, or the
 * database refuses to create it.
 *
 * A reference from a workspace-only table to `workspaces` by `workspace_id`
 * is the tenant itself and needs no binding.
 */

export const TENANT_COLUMNS = ["workspace_id", "organization_id"] as const;
type TenantColumn = (typeof TENANT_COLUMNS)[number];

const WORKSPACE_ROOT_TABLE = "workspaces";

export type ReferenceFinding = {
  /** `source(columns) -> target(columns)`, the ledger key. */
  reference: string;
  source: string;
  target: string;
  onDelete: string;
  problem:
    | "id-only"
    | "no-shared-tenant-column"
    | "nullable-tenant-column"
    | "target-key-not-unique";
  /** The tenant column the reference must carry. */
  bindingColumn: TenantColumn | null;
};

type Pair = readonly [source: string, target: string];

const dialect = new PgDialect();

const pairsOf = (foreignKey: ForeignKey): Pair[] => {
  const reference = foreignKey.reference();
  return reference.columns.map((column, index) => {
    const target = reference.foreignColumns[index];
    if (target === undefined) {
      return panic(`Foreign key ${foreignKey.getName()} is uneven`);
    }
    return [column.name, target.name] as const;
  });
};

export const referenceKey = (foreignKey: ForeignKey): string => {
  const reference = foreignKey.reference();
  const source = getTableConfig(foreignKey.table).name;
  const target = getTableConfig(reference.foreignTable).name;
  const pairs = pairsOf(foreignKey);
  return `${source}(${pairs.map(([column]) => column).join(",")}) -> ${target}(${pairs.map(([, column]) => column).join(",")})`;
};

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((name) => right.includes(name));

/** Column sets the database accepts as the target of a foreign key. */
export const uniqueKeysOf = (table: PgTable): string[][] => {
  const config = getTableConfig(table);
  const keys: string[][] = [];
  for (const column of config.columns) {
    if (column.primary || column.isUnique) {
      keys.push([column.name]);
    }
  }
  for (const primaryKey of config.primaryKeys) {
    keys.push(primaryKey.columns.map((column) => column.name));
  }
  for (const unique of config.uniqueConstraints) {
    keys.push(unique.columns.map((column) => column.name));
  }
  for (const index of config.indexes) {
    if (!index.config.unique || index.config.where !== undefined) {
      continue;
    }
    // An expression index names no column, so it cannot back a reference.
    const names = index.config.columns.flatMap((column) =>
      is(column, SQL) || typeof column.name !== "string" ? [] : [column.name],
    );
    if (names.length === index.config.columns.length) {
      keys.push(names);
    }
  }
  return keys;
};

const normalizedChecks = (table: PgTable): string[] => {
  const config = getTableConfig(table);
  return config.checks.map((check) =>
    dialect
      .sqlToQuery(check.value)
      .sql.replaceAll(`"${config.name}".`, "")
      .replaceAll('"', "")
      .replaceAll(/\s+/gu, " ")
      .toLowerCase()
      .trim(),
  );
};

/**
 * True when `copy` is a nullable stand-in for `binding`: a CHECK says the copy
 * is NULL exactly when the rest of the reference is, and equals the binding
 * column otherwise. Only this exact shape counts.
 */
const isTenantCopy = (
  table: PgTable,
  copy: string,
  binding: TenantColumn,
  others: readonly string[],
): boolean => {
  if (others.length !== 1) {
    return false;
  }
  const [other] = others;
  const expected = `(${other} is null and ${copy} is null) or (${other} is not null and ${copy} = ${binding})`;
  return normalizedChecks(table).includes(expected);
};

const tenantColumnsOf = (table: PgTable): TenantColumn[] => {
  const names = new Set(getTableConfig(table).columns.map((c) => c.name));
  return TENANT_COLUMNS.filter((column) => names.has(column));
};

const findingFor = (
  table: PgTable,
  foreignKey: ForeignKey,
): ReferenceFinding | null => {
  const config = getTableConfig(table);
  const target = foreignKey.reference().foreignTable;
  const targetName = getTableConfig(target).name;
  const sourceTenant = tenantColumnsOf(table);
  const targetTenant = tenantColumnsOf(target);
  if (sourceTenant.length === 0 || targetTenant.length === 0) {
    return null;
  }
  const pairs = pairsOf(foreignKey);
  const base = {
    reference: referenceKey(foreignKey),
    source: config.name,
    target: targetName,
    onDelete: foreignKey.onDelete ?? "no action",
  };
  const shared = TENANT_COLUMNS.filter(
    (column) => sourceTenant.includes(column) && targetTenant.includes(column),
  );
  if (shared.length === 0) {
    const [only] = pairs;
    const isWorkspaceRoot =
      targetName === WORKSPACE_ROOT_TABLE &&
      pairs.length === 1 &&
      only?.[0] === "workspace_id" &&
      only[1] === "id";
    return isWorkspaceRoot
      ? null
      : { ...base, problem: "no-shared-tenant-column", bindingColumn: null };
  }
  const notNull = new Set(
    config.columns.filter((c) => c.notNull).map((c) => c.name),
  );
  const binding = shared.find((column) => notNull.has(column));
  if (binding === undefined) {
    return {
      ...base,
      problem: "nullable-tenant-column",
      bindingColumn: shared[0] ?? null,
    };
  }

  let coveringKeyIsUnique: boolean | null = null;
  for (const candidate of config.foreignKeys) {
    if (candidate.reference().foreignTable !== target) {
      continue;
    }
    const candidatePairs = pairsOf(candidate);
    const covers = pairs.every(([from, to]) =>
      candidatePairs.some(([f, t]) => f === from && t === to),
    );
    if (!covers) {
      continue;
    }
    const binds = candidatePairs.some(
      ([from, to]) =>
        to === binding &&
        (from === binding ||
          isTenantCopy(
            table,
            from,
            binding,
            candidatePairs.filter(([f]) => f !== from).map(([f]) => f),
          )),
    );
    if (!binds) {
      continue;
    }
    const targetColumns = candidatePairs.map(([, to]) => to);
    const unique = uniqueKeysOf(target).some((key) =>
      sameSet(key, targetColumns),
    );
    if (unique) {
      return null;
    }
    coveringKeyIsUnique = false;
  }
  return {
    ...base,
    problem:
      coveringKeyIsUnique === false ? "target-key-not-unique" : "id-only",
    bindingColumn: binding,
  };
};

/** Every reference between tenant-owned tables that is not tenant-scoped. */
export const unscopedTenantReferences = (
  tables: readonly PgTable[],
): ReferenceFinding[] =>
  tables
    .flatMap((table) =>
      getTableConfig(table).foreignKeys.map((foreignKey) =>
        findingFor(table, foreignKey),
      ),
    )
    .filter((finding) => finding !== null)
    .toSorted((left, right) => {
      // Ledger keys are identifiers; order them by code unit.
      if (left.reference === right.reference) {
        return 0;
      }
      return left.reference < right.reference ? -1 : 1;
    });

/** References between tenant-owned tables, scoped or not. */
export const tenantReferenceCount = (tables: readonly PgTable[]): number =>
  tables
    .flatMap((table) => getTableConfig(table).foreignKeys)
    .filter(
      (foreignKey) =>
        tenantColumnsOf(foreignKey.table).length > 0 &&
        tenantColumnsOf(foreignKey.reference().foreignTable).length > 0,
    ).length;

export const isPgTable = (value: unknown): value is PgTable =>
  is(value, PgTable);
