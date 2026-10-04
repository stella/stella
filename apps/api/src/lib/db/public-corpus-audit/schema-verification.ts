import { is } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";

type Declaration = {
  schemaExport: string;
  sqlName: string;
  reason: string;
  purpose: string;
  columns: Readonly<Record<string, { kind: string; reason: string }>>;
};

const COLUMN_SQL_TYPES = new Map(
  Object.entries({
    "public-corpus-id": ["uuid", "text", "varchar"],
    counter: ["integer", "bigint", "numeric", "smallint"],
    timestamp: ["timestamp", "date"],
    enum: ["text", "varchar"],
    "parser-version": ["integer", "smallint"],
    "corpus-cursor": ["text", "varchar", "json", "jsonb", "bytea"],
  }),
);

const normalizedPolicy = (expression: string): string =>
  expression
    .toLowerCase()
    .replaceAll("pg_catalog.", "")
    .replaceAll("pg_class.", "")
    .replace(/[\s()]/gu, "")
    .replaceAll("aspg_get_userbyid", "");

export const isOwnerOnlyExpression = (
  expression: string,
  tableName: string,
): boolean => {
  const normalized = normalizedPolicy(expression);
  const relations = tableName.includes(".")
    ? [
        tableName,
        ...(tableName.startsWith("public.") ? [tableName.slice(7)] : []),
      ]
    : [tableName, `public.${tableName}`];
  return relations.some(
    (relation) =>
      normalized ===
        `current_user=selectpg_get_userbyidrelownerfrompg_classwhereoid='${relation}'::regclass` ||
      normalized ===
        `current_user=selectpg_get_userbyidrelownerfrompg_classwhereoid='${relation}'::regclass::oid`,
  );
};

type SchemaVerificationArgs = {
  declaration: Declaration;
  schema: Readonly<Record<string, unknown>>;
};

export const verifyPublicCorpusSchema = ({
  declaration,
  schema,
}: SchemaVerificationArgs): string[] => {
  const table = schema[declaration.schemaExport];
  if (!is(table, PgTable)) {
    return ["missing table or non-table schema export"];
  }
  const config = getTableConfig(table);
  const errors: string[] = [];
  if (
    config.name !== declaration.sqlName ||
    (config.schema !== undefined && config.schema !== "public")
  ) {
    errors.push("schema relation identity differs from declaration");
  }
  if (
    declaration.reason.trim().split(/\s+/u).length < 3 ||
    Object.values(declaration.columns).some(
      ({ reason }) => reason.trim().split(/\s+/u).length < 12,
    )
  ) {
    errors.push("reviewed table and column reasons are required");
  }
  const names = config.columns.map((column) => column.name).toSorted();
  if (
    JSON.stringify(names) !==
    JSON.stringify(Object.keys(declaration.columns).toSorted())
  ) {
    errors.push("reviewed columns must exactly match schema columns");
  }
  if (declaration.purpose !== "public-corpus-bookkeeping") {
    errors.push("generic maintenance state incl. tenant repairs");
  }
  for (const column of config.columns) {
    const classification = declaration.columns[column.name];
    const sqlType = column.getSQLType().toLowerCase().split(/[ (]/u).at(0);
    if (
      classification === undefined ||
      sqlType === undefined ||
      !COLUMN_SQL_TYPES.get(classification.kind)?.includes(sqlType)
    ) {
      errors.push("column classification does not match its schema type");
    }
    if (
      classification?.kind === "enum" &&
      (column.enumValues?.length ?? 0) === 0
    ) {
      errors.push("enum classification requires schema enum values");
    }
  }
  if (config.foreignKeys.length !== 0) {
    errors.push("foreign keys require a separate admission design");
  }
  if (!config.enableRLS) {
    errors.push("schema RLS is not enabled");
  }
  const dialect = new PgDialect();
  if (
    config.policies.length !== 1 ||
    config.policies.some((policy) => {
      if (
        policy.to !== "public" ||
        policy.for !== "all" ||
        policy.as === "restrictive" ||
        policy.using === undefined ||
        policy.withCheck === undefined
      ) {
        return true;
      }
      const using = dialect.sqlToQuery(policy.using);
      const check = dialect.sqlToQuery(policy.withCheck);
      return (
        using.params.length !== 0 ||
        check.params.length !== 0 ||
        !isOwnerOnlyExpression(using.sql, config.name) ||
        !isOwnerOnlyExpression(check.sql, config.name)
      );
    })
  ) {
    errors.push("schema policy must exclusively admit the table owner");
  }
  // A delete/update of bookkeeping must not cascade into another table.
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) {
      continue;
    }
    if (
      getTableConfig(value).foreignKeys.some(
        (key) => key.reference().foreignTable === table,
      )
    ) {
      errors.push("incoming foreign key can mutate dependent rows");
    }
  }
  return errors;
};

export type PublicCorpusCatalogPosture = {
  name: string;
  schema: string;
  kind: string;
  enabled: boolean;
  forced: boolean;
  appPrivileges: boolean;
  userTriggers: boolean;
  cascadingDependents: boolean;
  otherRolePrivileges: boolean;
  rewriteRules: boolean;
  inheritance: boolean;
  accessibleViews: boolean;
  securityDefiners: boolean;
  policies: readonly {
    command: string;
    publicOnly: boolean;
    permissive: boolean;
    using: string | null;
    check: string | null;
  }[];
};

export const verifyPublicCorpusCatalog = (
  posture: PublicCorpusCatalogPosture | undefined,
): string[] => {
  if (posture === undefined) {
    return ["table missing from migrated catalog"];
  }
  const errors: string[] = [];
  // Partition children may have additional triggers or cascading effects.
  // They need their own admission design before partitioned parents can join.
  if (posture.kind !== "r") {
    errors.push("catalog relation is not a table");
  }
  if (!posture.enabled || !posture.forced) {
    errors.push("catalog RLS must be enabled and forced");
  }
  if (posture.appPrivileges) {
    errors.push("application role has table or column privileges");
  }
  if (posture.otherRolePrivileges) {
    errors.push("non-owner role has privileges");
  }
  if (posture.rewriteRules) {
    errors.push("rewrite rule can redirect mutations");
  }
  if (posture.inheritance) {
    errors.push("relation participates in inheritance");
  }
  if (posture.accessibleViews) {
    errors.push("non-owner can read a dependent view");
  }
  if (posture.securityDefiners) {
    errors.push("security definer may expose the relation");
  }
  if (posture.userTriggers) {
    errors.push("user trigger could perform an unclassified write");
  }
  if (posture.cascadingDependents) {
    errors.push("migrated foreign key can mutate dependent rows");
  }
  if (
    posture.policies.length !== 1 ||
    posture.policies.some(
      (policy) =>
        policy.command !== "*" ||
        !policy.publicOnly ||
        !policy.permissive ||
        policy.using === null ||
        policy.check === null ||
        !isOwnerOnlyExpression(
          policy.using,
          `${posture.schema}.${posture.name}`,
        ) ||
        !isOwnerOnlyExpression(
          policy.check,
          `${posture.schema}.${posture.name}`,
        ),
    )
  ) {
    errors.push("catalog policy must exclusively admit the table owner");
  }
  return errors;
};
