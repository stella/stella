import { getColumns, getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as agentAuthSchema from "@/api/db/agent-auth-schema";
import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";
import { isDecisionReferenceKey } from "@/api/lib/case-law/withdrawn-copy-fields";

export type DatabaseSchema = typeof schema;

type SchemaTable = Extract<
  | (typeof schema)[keyof typeof schema]
  | (typeof authSchema)[keyof typeof authSchema]
  | (typeof agentAuthSchema)[keyof typeof agentAuthSchema],
  PgTable
>;

export type SchemaTableName = SchemaTable["_"]["name"];

const isPgTable = (value: unknown): value is PgTable => is(value, PgTable);

const allSchemaExports = {
  ...agentAuthSchema,
  ...authSchema,
  ...schema,
};

/** Physical table names from every canonical schema, without exposing table handles. */
export const allSchemaTableNames = () =>
  [
    ...new Set(
      Object.values(allSchemaExports)
        .filter((value): value is SchemaTable => is(value, PgTable))
        .map((table) => getTableName(table)),
    ),
  ].toSorted();

// These tables bind to a user in application code and intentionally have no FK.
// Keep their declarations here so the census imports schema metadata only.
const nonForeignKeyUserOwnedTables = [
  agentAuthSchema.agentRegistration,
  agentAuthSchema.agentDelegation,
  schema.fileComparisonUploads,
] as const;

const userTableName = getTableConfig(authSchema.user).name;

/** Names of tables with a direct user FK or an explicit non-FK user binding. */
export const userOwnedTableNames = (): string[] => {
  const names = new Set<string>([
    userTableName,
    ...nonForeignKeyUserOwnedTables.map((table) => getTableConfig(table).name),
  ]);

  for (const value of Object.values(allSchemaExports)) {
    if (!isPgTable(value)) {
      continue;
    }

    const config = getTableConfig(value);
    if (
      config.foreignKeys.some((foreignKey) => {
        const reference = foreignKey.reference();
        return getTableConfig(reference.foreignTable).name === userTableName;
      })
    ) {
      names.add(config.name);
    }
  }

  return [...names].toSorted();
};

/** Schema names of tenant stores associated with a decision by key, target, or FK. */
export const tenantDecisionTableNames = (
  tables: Record<string, unknown> = schema,
): string[] => {
  const names: string[] = [];
  for (const [name, value] of Object.entries(tables)) {
    if (!isPgTable(value)) {
      continue;
    }
    const columns = getColumns(value);
    if (!("organizationId" in columns) && !("workspaceId" in columns)) {
      continue;
    }
    const hasDecisionKey = Object.values(columns).some((column) =>
      isDecisionReferenceKey(column.name),
    );
    const hasDecisionTarget =
      columns["targetType"]?.enumValues?.includes("decision") === true &&
      "targetId" in columns;
    const hasDecisionForeignKey = getTableConfig(value).foreignKeys.some(
      (foreignKey) =>
        getTableConfig(foreignKey.reference().foreignTable).name ===
        getTableConfig(schema.caseLawDecisions).name,
    );
    if (hasDecisionKey || hasDecisionTarget || hasDecisionForeignKey) {
      names.push(name);
    }
  }
  return names;
};
