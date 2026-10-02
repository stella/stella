import { is } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";

type Declaration = {
  schemaExport: string;
  sqlName: string;
  reason: string;
  columns: Readonly<Record<string, string>>;
};

// Check presence, not nullability. Follow foreign keys too, so renamed or
// indirect ownership references cannot conceal a tenant boundary.
const OWNERSHIP_COLUMN =
  /(?:^|_)(?:organization|organisation|org|workspace|matter|user|tenant|author|actor|requester)(?:_|$)|(?:^|_)(?:created|updated|requested|owned)_by(?:_|$)/iu;
const OWNERSHIP_TABLE = /^(?:organization|user|member|workspaces)$/u;
const CONTENT_COLUMN =
  /(?:^|_)(?:body|content|document|payload|prompt|message|secret|token|credential)(?:_|$)/iu;
const normalizedColumnName = (name: string): string =>
  name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

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
  return [tableName, `public.${tableName}`].some(
    (relation) =>
      normalized ===
      `current_user=selectpg_get_userbyidrelownerfrompg_classwhereoid='${relation}'::regclass`,
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
      (reason) => reason.trim().split(/\s+/u).length < 3,
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
  if (names.some((name) => CONTENT_COLUMN.test(normalizedColumnName(name)))) {
    errors.push("content-bearing column is not bookkeeping");
  }
  const seen = new Set<PgTable>();
  const hasOwnership = (current: PgTable): boolean => {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    const currentConfig = getTableConfig(current);
    return (
      OWNERSHIP_TABLE.test(currentConfig.name) ||
      currentConfig.columns.some((column) =>
        OWNERSHIP_COLUMN.test(normalizedColumnName(column.name)),
      ) ||
      currentConfig.foreignKeys.some((key) =>
        hasOwnership(key.reference().foreignTable),
      )
    );
  };
  if (hasOwnership(table)) {
    errors.push("tenant or accountable-user ownership column/foreign key");
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
        (key) =>
          key.reference().foreignTable === table &&
          ((key.onDelete !== undefined &&
            key.onDelete !== "no action" &&
            key.onDelete !== "restrict") ||
            (key.onUpdate !== undefined &&
              key.onUpdate !== "no action" &&
              key.onUpdate !== "restrict")),
      )
    ) {
      errors.push("incoming foreign key can mutate dependent rows");
    }
  }
  return errors;
};

export type PublicCorpusCatalogPosture = {
  name: string;
  kind: string;
  enabled: boolean;
  forced: boolean;
  appPrivileges: boolean;
  userTriggers: boolean;
  cascadingDependents: boolean;
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
        !isOwnerOnlyExpression(policy.using, posture.name) ||
        !isOwnerOnlyExpression(policy.check, posture.name),
    )
  ) {
    errors.push("catalog policy must exclusively admit the table owner");
  }
  return errors;
};
