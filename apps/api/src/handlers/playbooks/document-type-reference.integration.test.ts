import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { organization } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  auditLogs,
  documentTypes,
  playbookDefinitions,
  playbookDefinitionVersions,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import deleteDocumentType from "@/api/handlers/document-types/delete";
import { DOCUMENT_TYPE_NOT_FOUND_MESSAGE } from "@/api/handlers/playbooks/assert-document-type";
import createPlaybookDefinition from "@/api/handlers/playbooks/create";
import createPlaybookFromStarter from "@/api/handlers/playbooks/from-starter/create";
import updatePlaybookDefinition from "@/api/handlers/playbooks/update";
import restorePlaybookVersion from "@/api/handlers/playbooks/versions/restore";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DEFAULT_DOCUMENT_TYPES,
  ensureDefaultDocumentTypes,
} from "@/api/lib/document-types/defaults";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";
import type { PlaybookScope } from "@/api/lib/workflow/playbook-positions";
import { STARTER_PLAYBOOKS } from "@/api/lib/workflow/starter-playbooks";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
const PRE_MIGRATION_DOCUMENT_TYPE_KEY = "pre-migration";
const preMigrationScopedId = createSafeId<"playbookDefinition">();
const preMigrationUnscopedId = createSafeId<"playbookDefinition">();
const PRE_MIGRATION_ORPHAN_KEY = "pre-migration-deleted";
const preMigrationOrphanId = createSafeId<"playbookDefinition">();

const orgContext = (organizationId = ids.orgA) => {
  const bindings = {
    organizationId,
    workspaceId: null,
    userId: ids.userA1,
    request: new Request("https://example.test/playbooks"),
    server: null,
  };
  return createTestHandlerContext({
    scopedDb: NO_DB,
    getActiveWorkspaceIds: async () => [],
    getAccessibleWorkspaces: async () => [],
    getWorkspaceAccess: async () => null,
    pinServerValidatedWorkspaceId: () => false,
    audit: createAuditRecorder(bindings),
    request: bindings.request,
    route: "/playbooks",
    safeDb: toSafeDbMock(
      asTestRaw<ScopedDb>(
        createScopedDb(testDb, [], organizationId, ids.userA1),
      ),
    ),
    session: { activeOrganizationId: organizationId },
    user: { id: ids.userA1 },
  });
};

const readPlaybookAudit = (
  organizationId: SafeId<"organization">,
  playbookId: SafeId<"playbookDefinition">,
) =>
  testDb
    .select({
      organizationId: auditLogs.organizationId,
      workspaceId: auditLogs.workspaceId,
      userId: auditLogs.userId,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      changes: auditLogs.changes,
      performerType: auditLogs.performerType,
      performerId: auditLogs.performerId,
      triggerType: auditLogs.triggerType,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.PLAYBOOK),
        eq(auditLogs.resourceId, playbookId),
      ),
    );

const readDefinition = (playbookId: SafeId<"playbookDefinition">) =>
  testDb
    .select({
      name: playbookDefinitions.name,
      description: playbookDefinitions.description,
      scope: playbookDefinitions.scope,
      positions: playbookDefinitions.positions,
      status: playbookDefinitions.status,
      approvedAt: playbookDefinitions.approvedAt,
      approvedBy: playbookDefinitions.approvedBy,
      updatedAt: playbookDefinitions.updatedAt,
    })
    .from(playbookDefinitions)
    .where(eq(playbookDefinitions.id, playbookId));

const createdId = (result: unknown) => {
  expect(result).toMatchObject({ outcome: "created" });
  if (!isRecord(result) || typeof result["id"] !== "string") {
    throw new Error("Expected a created playbook id");
  }
  return toSafeId<"playbookDefinition">(result["id"]);
};

// The seeding helper is typed against the production driver; the test driver
// exposes the same `insert` builder at runtime.
const asDocumentTypeWriter = (tx: unknown) =>
  asTestRaw<Parameters<typeof ensureDefaultDocumentTypes>[1]>(tx);

const createOrganization = async () => {
  const organizationId = mintAuthProviderId<"organization">();
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Document type reference test",
    slug: `doc-type-${organizationId}`,
    createdAt: new Date(),
  });
  return organizationId;
};

const applyMigration = async (migration: URL) => {
  const statements = (await Bun.file(migration).text()).split(
    "--> statement-breakpoint",
  );
  await testDb.$client.exec("BEGIN");
  for (const statement of statements) {
    await testDb.$client.exec(statement);
  }
  await testDb.$client.exec("COMMIT");
};

beforeAll(async () => {
  testDb = await getTestDb();
  // PGlite starts from the Drizzle schema plus the installed trigger. Rebuild
  // this slice from the deployment SQL so omitting the migration's column
  // derivation, backfill or FK cannot hide behind the test harness.
  await testDb.$client.exec(`
    ALTER TABLE "playbook_definitions" DROP CONSTRAINT "playbook_definitions_document_type_fk";
    DROP TRIGGER "playbook_definitions_derive_document_type_key" ON "playbook_definitions";
    DROP FUNCTION "derive_playbook_definition_document_type_key"();
    ALTER TABLE "playbook_definitions" DROP COLUMN "document_type_key";
  `);
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  // Definitions written before the migration, by the previous schema.
  await testDb.insert(documentTypes).values({
    id: createSafeId<"documentType">(),
    organizationId: ids.orgA,
    key: PRE_MIGRATION_DOCUMENT_TYPE_KEY,
    label: "Pre-migration type",
  });
  // The orphan names a type its organization deleted before the reference
  // existed; the validating migration restores that type.
  await testDb.$client.query(
    `INSERT INTO "playbook_definitions" ("id", "organization_id", "name", "scope", "positions")
     VALUES ($1, $2, 'Scoped before migration', $3::text::jsonb, $5::text::jsonb),
            ($4, $2, 'Unscoped before migration', NULL, $5::text::jsonb),
            ($6, $2, 'Orphaned before migration', $7::text::jsonb, $5::text::jsonb)`,
    [
      preMigrationScopedId,
      ids.orgA,
      JSON.stringify({ documentTypeKey: PRE_MIGRATION_DOCUMENT_TYPE_KEY }),
      preMigrationUnscopedId,
      JSON.stringify({ version: 3, items: [] }),
      preMigrationOrphanId,
      JSON.stringify({ documentTypeKey: PRE_MIGRATION_ORPHAN_KEY }),
    ],
  );
  await applyMigration(
    new URL(
      "../../../drizzle/20261003125200_playbook_document_type_reference/migration.sql",
      import.meta.url,
    ),
  );
});

const readDocumentTypeKey = async (playbookId: SafeId<"playbookDefinition">) =>
  await testDb
    .select({ documentTypeKey: playbookDefinitions.documentTypeKey })
    .from(playbookDefinitions)
    .where(eq(playbookDefinitions.id, playbookId));

afterAll(async () => {
  await releaseTestDb();
});

describe("playbook document type references", () => {
  test("refuses restoring a deleted historic document type and preserves the active definition", async () => {
    const documentTypeId = createSafeId<"documentType">();
    const playbookId = createSafeId<"playbookDefinition">();
    const documentTypeKey = `historic-${documentTypeId}`;
    await testDb.insert(documentTypes).values({
      id: documentTypeId,
      organizationId: ids.orgA,
      key: documentTypeKey,
      label: "Historic type",
    });
    await testDb.insert(playbookDefinitions).values({
      id: playbookId,
      organizationId: ids.orgA,
      name: "Current definition",
      description: "Current description",
      scope: null,
      positions: { version: 3, items: [] },
      status: "approved",
      approvedAt: new Date("2026-01-01T00:00:00Z"),
      approvedBy: ids.userA1,
    });
    await testDb.insert(playbookDefinitionVersions).values({
      organizationId: ids.orgA,
      playbookDefinitionId: playbookId,
      version: 1,
      source: "approval",
      name: "Historic definition",
      description: "Historic description",
      scope: { documentTypeKey },
      positions: { version: 3, items: [] },
      createdBy: ids.userA1,
    });

    expect(
      await deleteDocumentType.handler(
        asTestRaw<Parameters<typeof deleteDocumentType.handler>[0]>({
          ...orgContext(),
          params: { documentTypeId },
        }),
      ),
    ).toEqual({});
    expect(
      await testDb
        .select({ id: documentTypes.id })
        .from(documentTypes)
        .where(eq(documentTypes.id, documentTypeId)),
    ).toEqual([]);
    const before = await readDefinition(playbookId);
    expect(await readPlaybookAudit(ids.orgA, playbookId)).toEqual([]);
    const restored = await restorePlaybookVersion.handler(
      asTestRaw<Parameters<typeof restorePlaybookVersion.handler>[0]>({
        ...orgContext(),
        params: { playbookId, version: 1 },
      }),
    );
    expect(restored).toMatchObject({
      code: 400,
      response: { message: DOCUMENT_TYPE_NOT_FOUND_MESSAGE, retryable: false },
    });
    expect(await readDefinition(playbookId)).toEqual(before);
    expect(await readPlaybookAudit(ids.orgA, playbookId)).toEqual([]);
    expect(
      await testDb
        .select({ scope: playbookDefinitionVersions.scope })
        .from(playbookDefinitionVersions)
        .where(eq(playbookDefinitionVersions.playbookDefinitionId, playbookId)),
    ).toEqual([{ scope: { documentTypeKey } }]);
  });

  test("refuses a direct insert whose document type does not exist", async () => {
    const playbookId = createSafeId<"playbookDefinition">();
    const inserted = await Result.tryPromise(() =>
      testDb.insert(playbookDefinitions).values({
        id: playbookId,
        organizationId: ids.orgA,
        name: "Unknown type",
        scope: { documentTypeKey: `missing-${playbookId}` },
        positions: { version: 3, items: [] },
      }),
    );
    expect(Result.isError(inserted)).toBe(true);
    if (Result.isError(inserted)) {
      expect(getPgErrorCode(inserted.error)).toBe(
        PG_ERROR.FOREIGN_KEY_VIOLATION,
      );
    }
    expect(
      await testDb
        .select({ id: playbookDefinitions.id })
        .from(playbookDefinitions)
        .where(eq(playbookDefinitions.id, playbookId)),
    ).toEqual([]);
  });

  test("backfills the key of definitions written before the migration", async () => {
    expect(await readDocumentTypeKey(preMigrationScopedId)).toEqual([
      { documentTypeKey: PRE_MIGRATION_DOCUMENT_TYPE_KEY },
    ]);
    expect(await readDocumentTypeKey(preMigrationUnscopedId)).toEqual([
      { documentTypeKey: null },
    ]);
    expect(await readDocumentTypeKey(preMigrationOrphanId)).toEqual([
      { documentTypeKey: PRE_MIGRATION_ORPHAN_KEY },
    ]);
  });

  test("every direct write stores the scope's key, whatever key the writer supplies", async () => {
    const suffix = createSafeId<"documentType">();
    const keys = [`first-${suffix}`, `second-${suffix}`] as const;
    await testDb.insert(documentTypes).values(
      keys.map((key) => ({
        organizationId: ids.orgA,
        key,
        label: "Derived key type",
      })),
    );
    const scopeKey = fc.option(fc.constantFrom(...keys), { nil: undefined });
    const suppliedKey = fc.option(fc.constantFrom(...keys), { nil: null });
    await assertProperty(
      "every direct write stores the scope's key, whatever key the writer supplies",
      fc.asyncProperty(
        scopeKey,
        suppliedKey,
        scopeKey,
        suppliedKey,
        async (insertedKey, insertedSupplied, updatedKey, updatedSupplied) => {
          const scopeOf = (key: string | undefined): PlaybookScope | null =>
            key === undefined ? null : { documentTypeKey: key };
          const playbookId = createSafeId<"playbookDefinition">();
          await testDb.insert(playbookDefinitions).values({
            id: playbookId,
            organizationId: ids.orgA,
            name: "Derived key",
            scope: scopeOf(insertedKey),
            documentTypeKey: insertedSupplied,
            positions: { version: 3, items: [] },
          });
          expect(await readDocumentTypeKey(playbookId)).toEqual([
            { documentTypeKey: insertedKey ?? null },
          ]);
          await testDb
            .update(playbookDefinitions)
            .set({ documentTypeKey: updatedSupplied })
            .where(eq(playbookDefinitions.id, playbookId));
          expect(await readDocumentTypeKey(playbookId)).toEqual([
            { documentTypeKey: insertedKey ?? null },
          ]);
          await testDb
            .update(playbookDefinitions)
            .set({ scope: scopeOf(updatedKey) })
            .where(eq(playbookDefinitions.id, playbookId));
          expect(await readDocumentTypeKey(playbookId)).toEqual([
            { documentTypeKey: updatedKey ?? null },
          ]);
        },
      ),
    );
  });

  test("stale and missing scoped updates preserve definitions and commit no audit", async () => {
    const documentTypeId = createSafeId<"documentType">();
    const playbookId = createSafeId<"playbookDefinition">();
    const documentTypeKey = `update-${documentTypeId}`;
    await testDb.insert(documentTypes).values({
      id: documentTypeId,
      organizationId: ids.orgA,
      key: documentTypeKey,
      label: "Update type",
    });
    await testDb.insert(playbookDefinitions).values({
      id: playbookId,
      organizationId: ids.orgA,
      name: "Stored scoped definition",
      description: "Stored description",
      scope: { documentTypeKey },
      positions: { version: 3, items: [] },
      status: "approved",
      approvedAt: new Date("2026-01-01T00:00:00Z"),
      approvedBy: ids.userA1,
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    });
    const before = await readDefinition(playbookId);
    const expectedUpdatedAt = "2026-01-01T00:00:00.000Z";
    expect(before.at(0)?.updatedAt.toISOString()).not.toBe(expectedUpdatedAt);
    expect(await readPlaybookAudit(ids.orgA, playbookId)).toEqual([]);
    const staleUpdate = await updatePlaybookDefinition.handler(
      asTestRaw<Parameters<typeof updatePlaybookDefinition.handler>[0]>({
        ...orgContext(),
        params: { playbookId },
        body: {
          name: "Replacement definition",
          description: "Replacement description",
          scope: { documentTypeKey },
          positions: { version: 3, items: [] },
          expectedUpdatedAt,
        },
      }),
    );
    expect(staleUpdate).toMatchObject({
      code: 409,
      response: { code: VERSION_CONFLICT_ERROR_CODE },
    });
    expect(await readDefinition(playbookId)).toEqual(before);
    expect(await readPlaybookAudit(ids.orgA, playbookId)).toEqual([]);

    const missingId = createSafeId<"playbookDefinition">();
    const missingUpdate = await updatePlaybookDefinition.handler(
      asTestRaw<Parameters<typeof updatePlaybookDefinition.handler>[0]>({
        ...orgContext(),
        params: { playbookId: missingId },
        body: {
          name: "Missing definition",
          scope: { documentTypeKey },
          positions: { version: 3, items: [] },
          expectedUpdatedAt,
        },
      }),
    );
    expect(missingUpdate).toMatchObject({
      code: 404,
      response: { message: "Playbook not found" },
    });
    expect(await readDefinition(missingId)).toEqual([]);
    expect(await readPlaybookAudit(ids.orgA, missingId)).toEqual([]);
    expect(await readDefinition(playbookId)).toEqual(before);
  });

  test("document type ownership governs every generated optional scope", async () => {
    await assertProperty(
      "document type ownership governs every generated optional scope",
      fc.asyncProperty(
        fc
          .array(fc.constantFrom("a", "b", "z", "0", "9", "-", "_"), {
            minLength: 1,
            maxLength: 24,
          })
          .map((characters) => characters.join("")),
        async (keyPrefix) => {
          const documentTypeId = createSafeId<"documentType">();
          const ownKey = `${keyPrefix}-${documentTypeId}`;
          const foreignKey = `foreign-${ownKey}`;
          await testDb.insert(documentTypes).values([
            { organizationId: ids.orgA, key: ownKey, label: "Own type" },
            {
              organizationId: ids.orgB,
              key: foreignKey,
              label: "Foreign type",
            },
          ]);
          const scopes: (PlaybookScope | null)[] = [
            null,
            { perspective: "buyer" },
            { documentTypeKey: ownKey },
          ];
          for (const scope of scopes) {
            const playbookId = createSafeId<"playbookDefinition">();
            await testDb.insert(playbookDefinitions).values({
              id: playbookId,
              organizationId: ids.orgA,
              name: "Valid optional scope",
              scope,
              positions: { version: 3, items: [] },
            });
            expect((await readDefinition(playbookId)).at(0)?.scope).toEqual(
              scope,
            );
          }
          for (const documentTypeKey of [foreignKey, `missing-${ownKey}`]) {
            const playbookId = createSafeId<"playbookDefinition">();
            const insertion = testDb.insert(playbookDefinitions).values({
              id: playbookId,
              organizationId: ids.orgA,
              name: "Unresolved scope",
              scope: { documentTypeKey },
              positions: { version: 3, items: [] },
            });
            const inserted = await Result.tryPromise(() => insertion);
            expect(Result.isError(inserted)).toBe(true);
            if (Result.isError(inserted)) {
              expect(getPgErrorCode(inserted.error)).toBe(
                PG_ERROR.FOREIGN_KEY_VIOLATION,
              );
            }
            expect(await readDefinition(playbookId)).toEqual([]);
          }
        },
      ),
      { numRuns: 8 },
    );
  });

  test("creates an unscoped playbook without a document type", async () => {
    const organizationId = await createOrganization();
    const result = await createPlaybookDefinition.handler(
      asTestRaw<Parameters<typeof createPlaybookDefinition.handler>[0]>({
        ...orgContext(organizationId),
        body: { name: "Unscoped", positions: { version: 3, items: [] } },
      }),
    );
    const playbookId = createdId(result);
    expect((await readDefinition(playbookId)).at(0)?.scope).toBeNull();
    expect(await readPlaybookAudit(organizationId, playbookId)).toEqual([
      {
        organizationId,
        workspaceId: null,
        userId: ids.userA1,
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
        resourceId: playbookId,
        changes: {
          created: { old: null, new: { name: "Unscoped", positionCount: 0 } },
        },
        performerType: "user",
        performerId: ids.userA1,
        triggerType: "direct",
      },
    ]);
  });

  test("real default seeding remains idempotent and supplies every starter scope", async () => {
    const organizationId = await createOrganization();
    const context = orgContext(organizationId);
    for (let pass = 0; pass < 2; pass += 1) {
      const seeded = await context.safeDb(async (tx) => {
        await ensureDefaultDocumentTypes(
          organizationId,
          asDocumentTypeWriter(tx),
        );
      });
      expect(Result.isOk(seeded)).toBe(true);
    }
    const defaults = await testDb
      .select({
        key: documentTypes.key,
        label: documentTypes.label,
        sortOrder: documentTypes.sortOrder,
      })
      .from(documentTypes)
      .where(eq(documentTypes.organizationId, organizationId))
      .orderBy(documentTypes.sortOrder);
    expect(defaults).toEqual([...DEFAULT_DOCUMENT_TYPES]);
    expect(
      await testDb
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, organizationId)),
    ).toEqual([]);
    for (const starter of STARTER_PLAYBOOKS) {
      const result = await createPlaybookFromStarter.handler(
        asTestRaw<Parameters<typeof createPlaybookFromStarter.handler>[0]>({
          ...context,
          body: { starterId: starter.starterId },
        }),
      );
      const playbookId = createdId(result);
      expect((await readDefinition(playbookId)).at(0)?.scope).toEqual({
        documentTypeKey: starter.documentTypeKey,
      });
      expect(await readPlaybookAudit(organizationId, playbookId)).toEqual([
        {
          organizationId,
          workspaceId: null,
          userId: ids.userA1,
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: playbookId,
          changes: {
            created: {
              old: null,
              new: {
                name: starter.name,
                positionCount: starter.positions.items.length,
              },
            },
          },
          performerType: "user",
          performerId: ids.userA1,
          triggerType: "direct",
        },
      ]);
    }
  });

  test("refuses a starter whose seeded document type was deleted", async () => {
    const organizationId = await createOrganization();
    const context = orgContext(organizationId);
    const seeded = await context.safeDb(async (tx) => {
      await ensureDefaultDocumentTypes(
        organizationId,
        asDocumentTypeWriter(tx),
      );
    });
    expect(Result.isOk(seeded)).toBe(true);
    const starter = STARTER_PLAYBOOKS.at(0);
    if (!starter) {
      throw new Error("Expected a bundled starter");
    }
    const typeRow = await testDb.query.documentTypes.findFirst({
      where: {
        organizationId: { eq: organizationId },
        key: { eq: starter.documentTypeKey },
      },
      columns: { id: true },
    });
    expect(typeRow).toBeDefined();
    if (!typeRow) {
      throw new Error("Expected the starter's seeded type");
    }
    expect(
      await deleteDocumentType.handler(
        asTestRaw<Parameters<typeof deleteDocumentType.handler>[0]>({
          ...context,
          params: { documentTypeId: typeRow.id },
        }),
      ),
    ).toEqual({});
    const result = await createPlaybookFromStarter.handler(
      asTestRaw<Parameters<typeof createPlaybookFromStarter.handler>[0]>({
        ...context,
        body: { starterId: starter.starterId },
      }),
    );
    expect(result).toMatchObject({
      code: 400,
      response: { message: DOCUMENT_TYPE_NOT_FOUND_MESSAGE, retryable: false },
    });
    expect(
      await testDb
        .select({ id: playbookDefinitions.id })
        .from(playbookDefinitions)
        .where(eq(playbookDefinitions.organizationId, organizationId)),
    ).toEqual([]);
    expect(
      await testDb
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.PLAYBOOK),
          ),
        ),
    ).toEqual([]);
  });

  test("organization teardown cascades scoped definitions and document types together", async () => {
    const organizationId = await createOrganization();
    const documentTypeId = createSafeId<"documentType">();
    const playbookId = createSafeId<"playbookDefinition">();
    await testDb.insert(documentTypes).values({
      id: documentTypeId,
      organizationId,
      key: "teardown",
      label: "Teardown",
    });
    await testDb.insert(playbookDefinitions).values({
      id: playbookId,
      organizationId,
      name: "Scoped teardown",
      scope: { documentTypeKey: "teardown" },
      positions: { version: 3, items: [] },
    });
    await testDb
      .delete(organization)
      .where(eq(organization.id, organizationId));
    expect(
      await testDb
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, organizationId)),
    ).toEqual([]);
    expect(await readDefinition(playbookId)).toEqual([]);
    expect(
      await testDb
        .select({ id: documentTypes.id })
        .from(documentTypes)
        .where(eq(documentTypes.id, documentTypeId)),
    ).toEqual([]);
  });

  test("validates the deployed reference while retaining NO ACTION for organization teardown", async () => {
    const readTypes = async () =>
      await testDb
        .select({
          organizationId: documentTypes.organizationId,
          key: documentTypes.key,
          label: documentTypes.label,
        })
        .from(documentTypes);
    const before = await readTypes();
    expect(before).not.toContainEqual(
      expect.objectContaining({ key: PRE_MIGRATION_ORPHAN_KEY }),
    );
    await applyMigration(
      new URL(
        "../../../drizzle/20261003125300_validate_playbook_document_type_reference/migration.sql",
        import.meta.url,
      ),
    );
    const constraint = await testDb.$client.query(`
      SELECT convalidated AS validated, confdeltype AS delete_action
      FROM pg_constraint
      WHERE conrelid = 'playbook_definitions'::regclass
        AND conname = 'playbook_definitions_document_type_fk'
    `);
    expect(constraint.rows).toEqual([{ validated: true, delete_action: "a" }]);
    // Only the deleted type a definition still names is restored.
    const after = await readTypes();
    expect(after).toHaveLength(before.length + 1);
    expect(after).toEqual(
      expect.arrayContaining([
        ...before,
        {
          organizationId: ids.orgA,
          key: PRE_MIGRATION_ORPHAN_KEY,
          label: PRE_MIGRATION_ORPHAN_KEY,
        },
      ]),
    );
    expect(await readDocumentTypeKey(preMigrationOrphanId)).toEqual([
      { documentTypeKey: PRE_MIGRATION_ORPHAN_KEY },
    ]);
  });
});
