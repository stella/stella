import { panic, Result } from "better-result";
import { eq, getTableName, inArray, SQL, sql } from "drizzle-orm";
import { getTableConfig, makePgArray, PgDialect } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  member,
  oauthClient,
  oauthConsent,
  organization,
  user,
} from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  cellMetadata,
  desktopEditSessions,
  documentProcessingRuns,
  entities,
  entityVersions,
  extractedContent,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import { mcpWebHandoff } from "@/api/db/schema/mcp-web-handoff";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { queryEntities } from "@/api/lib/entities/query-entities";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

/**
 * Session-local copies of `tables` that shadow the shared ones on this
 * connection, so a scaling fixture writes without row-level policies.
 */
export const createScalingTempTables = async (
  db: GatedTestDb,
  tables: readonly PgTable[],
) => {
  const dialect = new PgDialect();
  for (const table of tables) {
    const columns = getTableConfig(table).columns.map((column) => {
      let fallback = "";
      if (column.default instanceof SQL) {
        fallback = ` DEFAULT ${dialect.sqlToQuery(column.default).sql}`;
      } else if (column.default === null) {
        fallback = " DEFAULT NULL";
      } else if (
        column.default !== undefined &&
        typeof column.default !== "function"
      ) {
        let value: string;
        if (column.dimensions > 0 && Array.isArray(column.default)) {
          value = makePgArray(column.default);
        } else if (typeof column.default === "object") {
          value = JSON.stringify(column.default);
        } else if (
          typeof column.default === "string" ||
          typeof column.default === "number" ||
          typeof column.default === "boolean" ||
          typeof column.default === "bigint"
        ) {
          value = String(column.default);
        } else {
          return panic(`Unsupported default for ${column.name}`);
        }
        fallback = ` DEFAULT '${value.replaceAll("'", "''")}'`;
      }
      return `"${column.name}" ${column.getSQLType()}${"[]".repeat(column.dimensions)}${fallback}`;
    });
    await db.execute(
      sql.raw(
        `CREATE TEMP TABLE "${getTableName(table)}" (${columns.join(", ")})`,
      ),
    );
  }
};

export const prepareEntityReadScalingTables = async (db: GatedTestDb) =>
  await createScalingTempTables(db, [
    organization,
    user,
    member,
    workspaces,
    properties,
    entities,
    entityVersions,
    fields,
    cellMetadata,
    desktopEditSessions,
    extractedContent,
    documentProcessingRuns,
    oauthClient,
    oauthConsent,
    mcpWebHandoff,
    auditLogs,
  ]);

export const seedEntityReadScaling = async (db: GatedTestDb, size: number) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Read fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Read actor",
    email: `${userId}@example.test`,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Read matter",
    reference: workspaceId,
  });
  const propertyIds = Array.from({ length: size }, () =>
    createSafeId<"property">(),
  );
  await db.insert(properties).values(
    propertyIds.map((id) => ({
      id,
      workspaceId,
      name: id,
      status: "fresh" as const,
      content: { version: 1 as const, type: "text" as const },
      tool: { version: 1 as const, type: "manual-input" as const },
    })),
  );
  const rows = Array.from({ length: size }, () => ({
    id: createSafeId<"entity">(),
    versionId: createSafeId<"entityVersion">(),
  }));
  await db.insert(entities).values(
    rows.map(({ id }) => ({
      id,
      workspaceId,
      kind: "document" as const,
      name: "Read fixture row",
    })),
  );
  await db.insert(entityVersions).values(
    rows.map(({ id, versionId }) => ({
      id: versionId,
      workspaceId,
      entityId: id,
    })),
  );
  await db
    .update(entities)
    .set({
      currentVersionId: sqlCaseFragment({
        branches: rows.map(
          ({ id, versionId }) =>
            sql`when ${entities.id} = ${id} then ${versionId}::uuid`,
        ),
        fallback: sql`${entities.currentVersionId}`,
      }),
    })
    .where(
      inArray(
        entities.id,
        rows.map(({ id }) => id),
      ),
    );
  const textValue = "x".repeat(512 + size * 4);
  const fieldRows = rows.flatMap(({ versionId }) =>
    propertyIds.map((propertyId) => ({
      id: createSafeId<"field">(),
      workspaceId,
      entityVersionId: versionId,
      propertyId,
      content: {
        version: 1 as const,
        type: "text" as const,
        value: textValue,
      },
    })),
  );
  for (let offset = 0; offset < fieldRows.length; offset += 1000) {
    await db.insert(fields).values(fieldRows.slice(offset, offset + 1000));
  }
  const versionEntity = rows.at(0) ?? panic("Read fixture requires an entity");
  const history = Array.from({ length: 9 }, (_, index) => ({
    id: createSafeId<"entityVersion">(),
    workspaceId,
    entityId: versionEntity.id,
    versionNumber: index + 2,
  }));
  await db.insert(entityVersions).values(history);
  const historyFields = history.flatMap(({ id }) =>
    propertyIds.map((propertyId) => ({
      id: createSafeId<"field">(),
      workspaceId,
      entityVersionId: id,
      propertyId,
      content: {
        version: 1 as const,
        type: "text" as const,
        value: textValue,
      },
    })),
  );
  for (let offset = 0; offset < historyFields.length; offset += 1000) {
    await db.insert(fields).values(historyFields.slice(offset, offset + 1000));
  }
  const safeDb: SafeDb = async (work) =>
    await Result.tryPromise(async () => await db.transaction(work));
  return {
    db,
    size,
    textValue,
    organizationId,
    userId,
    workspaceId,
    propertyIds,
    versionEntityId: versionEntity.id,
    safeDb,
    cleanup: async () => {
      await db
        .update(entities)
        .set({ currentVersionId: null })
        .where(eq(entities.workspaceId, workspaceId));
      await db.delete(fields).where(eq(fields.workspaceId, workspaceId));
      await db
        .delete(entityVersions)
        .where(eq(entityVersions.workspaceId, workspaceId));
      await db.delete(entities).where(eq(entities.workspaceId, workspaceId));
      await db
        .delete(properties)
        .where(eq(properties.workspaceId, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    },
    measure: async ({
      fieldMode,
      textMode,
      selected = propertyIds.slice(0, 1),
    }: {
      fieldMode: "full" | "visible";
      textMode: "full" | "preview";
      selected?: typeof propertyIds;
    }) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const result = (
          await queryEntities({
            textMode,
            safeDb,
            scope: { type: "matter", workspaceId },
            currentUserId: userId,
            currentOrganizationId: organizationId,
            filters: [],
            sorts: [],
            limit: 10,
            fieldMode,
            fieldIds: selected,
          })
        ).unwrap();
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(result.entities)),
          rows: result.entities.length,
          entities: result.entities,
        };
      }),
  };
};
