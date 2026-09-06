import { Result, panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { bufferObjectCleanupIntents, templates } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  reserveObjectCleanupIntents,
  settleObjectCleanupIntentsAfterWriter,
} from "@/api/lib/buffer-intent-reconciliation";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const uuid = () => Bun.randomUUIDv7();
const organizationId = toSafeId<"organization">(uuid());
const otherOrganizationId = toSafeId<"organization">(uuid());
const userId = toSafeId<"user">(uuid());
const otherUserId = toSafeId<"user">(uuid());
const templateId = createSafeId<"template">();
const otherTemplateId = createSafeId<"template">();

let testDb: TestDatabase;
let scopedSafeDb: SafeDb;
let otherWriterSafeDb: SafeDb;
let schemaPolicyExpression: string;
let migratedPolicyExpression: string;

const migrationPath = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260906130000_template_write_cleanup_intents/migration.sql",
);

const insertPolicy = getTableConfig(bufferObjectCleanupIntents).policies.find(
  ({ name }) => name === "buffer_object_cleanup_insert",
);
if (insertPolicy?.withCheck === undefined) {
  panic("Schema insert policy is missing its WITH CHECK expression");
}
const schemaInsertPolicySql = new PgDialect().sqlToQuery(
  insertPolicy.withCheck,
).sql;

const readInsertPolicyExpression = async (): Promise<string> => {
  const rows = await testDb.execute<{ expression: string }>(sql`
    SELECT pg_catalog.pg_get_expr(polwithcheck, polrelid) AS expression
    FROM pg_catalog.pg_policy
    WHERE polname = 'buffer_object_cleanup_insert'
      AND polrelid = 'public.buffer_object_cleanup_intents'::regclass
  `);
  const expression = rows.rows.at(0)?.expression;
  if (expression === undefined) {
    panic("Template cleanup insert policy is missing");
  }
  return expression;
};

const reserve = async (objectKey: string) =>
  await reserveObjectCleanupIntents({
    objectKey,
    organizationId,
    safeDb: scopedSafeDb,
    workspaceIds: [],
  });

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.insert(user).values([
    {
      id: userId,
      name: "Template writer",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: otherUserId,
      name: "Other template writer",
      email: `${otherUserId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  await testDb.insert(organization).values([
    {
      id: organizationId,
      name: "Template intent organization",
      slug: `template-intent-${organizationId}`,
      createdAt: new Date(),
    },
    {
      id: otherOrganizationId,
      name: "Other template intent organization",
      slug: `other-template-intent-${otherOrganizationId}`,
      createdAt: new Date(),
    },
  ]);
  await testDb.insert(member).values([
    {
      id: uuid(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: uuid(),
      organizationId: otherOrganizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: uuid(),
      organizationId,
      userId: otherUserId,
      role: "owner",
      createdAt: new Date(),
    },
  ]);
  await testDb.insert(templates).values([
    {
      id: templateId,
      organizationId,
      name: "Template",
      fileName: "template.docx",
      s3Key: `${organizationId}/templates/${templateId}.docx`,
      sizeBytes: 1,
      createdBy: userId,
    },
    {
      id: otherTemplateId,
      organizationId: otherOrganizationId,
      name: "Other template",
      fileName: "other.docx",
      s3Key: `${otherOrganizationId}/templates/${otherTemplateId}.docx`,
      sizeBytes: 1,
      createdBy: userId,
    },
  ]);
  scopedSafeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [], organizationId, userId),
  );
  otherWriterSafeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [], organizationId, otherUserId),
  );

  await testDb.execute(
    sql.raw(
      `ALTER POLICY "buffer_object_cleanup_insert" ON "buffer_object_cleanup_intents" WITH CHECK (${schemaInsertPolicySql})`,
    ),
  );
  schemaPolicyExpression = await readInsertPolicyExpression();
  const migration = readFileSync(migrationPath, "utf-8");
  for (const source of migration.split("--> statement-breakpoint")) {
    const statement = source.trim();
    if (statement.length > 0) {
      await testDb.execute(sql.raw(statement));
    }
  }
  migratedPolicyExpression = await readInsertPolicyExpression();
}, 120_000);

afterAll(async () => {
  await testDb
    .delete(bufferObjectCleanupIntents)
    .where(eq(bufferObjectCleanupIntents.organizationId, organizationId));
  await testDb.delete(templates).where(eq(templates.id, templateId));
  await testDb.delete(templates).where(eq(templates.id, otherTemplateId));
  await testDb.delete(member).where(eq(member.userId, userId));
  await testDb.delete(organization).where(eq(organization.id, organizationId));
  await testDb
    .delete(organization)
    .where(eq(organization.id, otherOrganizationId));
  await testDb.delete(user).where(eq(user.id, userId));
  await testDb.delete(user).where(eq(user.id, otherUserId));
  await releaseTestDb();
});

describe("template write cleanup intent RLS", () => {
  test("the migration preserves the schema-generated insert policy", () => {
    expect(migratedPolicyExpression).toBe(schemaPolicyExpression);
  });

  test("admits only a unique attempt key under an existing tenant template", async () => {
    const result = await reserve(
      `${organizationId}/templates/${templateId}/write-${uuid()}.docx`,
    );

    expect(Result.isOk(result)).toBeTrue();
  });

  test.each([
    [
      "cross-organization template",
      () =>
        `${organizationId}/templates/${otherTemplateId}/write-${uuid()}.docx`,
    ],
    [
      "missing template",
      () =>
        `${organizationId}/templates/${createSafeId<"template">()}/write-${uuid()}.docx`,
    ],
    [
      "legacy version key",
      () => `${organizationId}/templates/${templateId}/v2.docx`,
    ],
    [
      "arbitrary organization prefix",
      () => `${organizationId}/style-sets/${templateId}/write-${uuid()}.docx`,
    ],
    [
      "nested candidate key",
      () =>
        `${organizationId}/templates/${templateId}/write-${uuid()}.docx/extra`,
    ],
    [
      "trailing-slash candidate key",
      () => `${organizationId}/templates/${templateId}/write-${uuid()}.docx/`,
    ],
  ])("rejects a %s", async (_label, key) => {
    const result = await reserve(key());

    expect(Result.isError(result)).toBeTrue();
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("DatabaseRlsError");
    }
  });

  test("the stamped writer can settle an intent after its template is removed", async () => {
    const reservation = await reserve(
      `${organizationId}/templates/${templateId}/write-${uuid()}.docx`,
    );
    if (Result.isError(reservation)) {
      throw reservation.error;
    }
    const intentId = reservation.value.at(0);
    if (intentId === undefined) {
      panic("Expected one cleanup intent");
    }

    await testDb.delete(templates).where(eq(templates.id, templateId));
    const foreignSettlement = await settleObjectCleanupIntentsAfterWriter({
      intentIds: [intentId],
      objectState: "object-deleted",
      safeDb: otherWriterSafeDb,
    });
    expect(Result.isError(foreignSettlement)).toBeTrue();

    const settled = await settleObjectCleanupIntentsAfterWriter({
      intentIds: [intentId],
      objectState: "object-deleted",
      safeDb: scopedSafeDb,
    });

    expect(Result.isOk(settled)).toBeTrue();
    const rows = await testDb
      .select({ id: bufferObjectCleanupIntents.id })
      .from(bufferObjectCleanupIntents)
      .where(eq(bufferObjectCleanupIntents.id, intentId));
    expect(rows).toEqual([]);
  });
});
