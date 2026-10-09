import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  auditLogs,
  cellMetadata,
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import type { CellMetadata } from "@/api/db/schema-validators";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { createWorkspaceTools } from "@/api/handlers/chat/tools/workspace-tools";
import upsertField from "@/api/handlers/fields/upsert";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { writeFieldValue } from "@/api/lib/fields/write-field";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let db: TestDatabase;
let ids: TestIds;
const workspaceId = createSafeId<"workspace">();
const entityId = createSafeId<"entity">();
const entityVersionId = createSafeId<"entityVersion">();
const restPropertyId = createSafeId<"property">();
const chatPropertyId = createSafeId<"property">();
const propertyIds = [restPropertyId, chatPropertyId];

/** Who acts: a session that may edit documents, and narrower ones that may not. */
const editor = sessionMemberRole("owner");
const intern = sessionMemberRole("intern");
const createOnlyKey = authorizedMemberRole({
  role: "owner",
  credential: { type: "attenuated", permissions: { entity: ["create"] } },
});

const userId = () => ids.userAdmin;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    name: "Field write test",
    reference: workspaceId,
    status: "active",
  });
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: "Agreement",
  });
  await db.insert(entityVersions).values({
    id: entityVersionId,
    workspaceId,
    entityId,
  });
  await db
    .update(entities)
    .set({ currentVersionId: entityVersionId })
    .where(eq(entities.id, entityId));
  await db.insert(properties).values(
    propertyIds.map((id) => ({
      id,
      workspaceId,
      name: `Counterparty ${id}`,
      content: { version: 1 as const, type: "text" as const },
      tool: { version: 1 as const, type: "manual-input" as const },
      status: "fresh" as const,
    })),
  );
});

const cleanup = async () => {
  await db.delete(auditLogs).where(eq(auditLogs.workspaceId, workspaceId));
  await db.delete(fields).where(inArray(fields.propertyId, propertyIds));
  await db
    .delete(cellMetadata)
    .where(inArray(cellMetadata.propertyId, propertyIds));
};

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.delete(properties).where(inArray(properties.id, propertyIds));
  await db
    .update(entities)
    .set({ currentVersionId: null })
    .where(eq(entities.id, entityId));
  await db.delete(entityVersions).where(eq(entityVersions.id, entityVersionId));
  await db.delete(entities).where(eq(entities.id, entityId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await releaseRlsFixture();
});

const safeDb = () =>
  asTestRaw<SafeDb>(createSafeDb(db, [workspaceId], ids.orgA, userId()));
const scopedDb = () =>
  asTestRaw<ScopedDb>(createScopedDb(db, [workspaceId], ids.orgA, userId()));
// One recorder shape for every surface, bound the way a request binds it, so
// the rows the surfaces write can be compared column for column.
const recorder = () =>
  createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId,
    userId: userId(),
    request: new Request("https://example.test/fields"),
    server: null,
  });

const textContent = (value: string) =>
  ({ version: 1, type: "text", value }) as const;

const writeOverRest = async (propertyId: SafeId<"property">, value: string) =>
  await upsertField.handler(
    createTestHandlerContext<Parameters<typeof upsertField.handler>[0]>({
      scopedDb: NO_DB,
      workspaceId,
      memberRole: editor,
      session: { activeOrganizationId: ids.orgA },
      user: { id: userId() },
      safeDb: safeDb(),
      audit: recorder(),
      createAuditRecorder: recorder,
      body: { entityId, propertyId, content: textContent(value) },
    }),
  );

const writeOverChat = async ({
  authority,
  propertyId,
  value,
}: {
  authority: AuthorizedMemberRole;
  propertyId: SafeId<"property">;
  value: string;
}): Promise<unknown> => {
  const refRegistry = createChatRefRegistry();
  const tool = createWorkspaceTools({
    allowedWorkspaceIds: [workspaceId],
    fieldWriter: {
      authority,
      recordAuditEvent: recorder(),
      userId: userId(),
      workspaceStatusById: new Map([[workspaceId, "active"]]),
    },
    refRegistry,
    scopedDb: scopedDb(),
  })["update-entity-fields"];
  const execute = tool?.execute ?? panic("update-entity-fields is missing");
  return await Promise.resolve()
    .then(
      async () =>
        await execute(
          {
            matterRef: refRegistry.toMatterRef(workspaceId),
            entityRef: refRegistry.toEntityRef({ entityId, workspaceId }),
            propertyRef: refRegistry.toPropertyRef(propertyId),
            value,
          },
          { emitCustomEvent: () => undefined },
        ),
    )
    .then(
      (output: unknown) => output,
      (error: unknown) => error,
    );
};

const cellState = async (propertyId: SafeId<"property">) => {
  const [field] = await db
    .select({ content: fields.content })
    .from(fields)
    .where(eq(fields.propertyId, propertyId));
  const [metadata] = await db
    .select({ metadata: cellMetadata.metadata })
    .from(cellMetadata)
    .where(eq(cellMetadata.propertyId, propertyId));
  const audits = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.resourceId, `${entityVersionId}:${propertyId}`));
  return { field, metadata: metadata?.metadata, audits };
};

/** An audit row with the columns that legitimately differ per write removed. */
const comparableAudit = (
  row: typeof auditLogs.$inferSelect,
  propertyId: SafeId<"property">,
) => {
  const { id: _id, createdAt: _createdAt, groupId: _groupId, ...rest } = row;
  return JSON.parse(
    JSON.stringify(rest).replaceAll(propertyId, "<property>"),
  ) as unknown;
};

/** Cell metadata with the lock time removed. */
const comparableMetadata = (metadata: CellMetadata | undefined) => {
  if (metadata?.lockProvenance === undefined) {
    return metadata;
  }
  const { lockedAt: _lockedAt, ...provenance } = metadata.lockProvenance;
  return { ...metadata, lockProvenance: provenance };
};

describe("writing a field value", () => {
  test("refuses an entity without a current version as not found", async () => {
    await db
      .update(entities)
      .set({ currentVersionId: null })
      .where(eq(entities.id, entityId));
    const refusal = await writeOverChat({
      authority: editor,
      propertyId: chatPropertyId,
      value: "Acme",
    });
    await db
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));

    expect(ChatToolError.is(refusal) && refusal.kind).toBe("not-found");
    expect(await cellState(chatPropertyId)).toEqual({
      field: undefined,
      metadata: undefined,
      audits: [],
    });
  });

  test("refuses a member whose role does not allow editing documents", async () => {
    const refusal = await writeOverChat({
      authority: intern,
      propertyId: chatPropertyId,
      value: "Acme",
    });

    expect(ChatToolError.is(refusal) && refusal.kind).toBe("unavailable");
    expect(await cellState(chatPropertyId)).toEqual({
      field: undefined,
      metadata: undefined,
      audits: [],
    });
  });

  test("refuses a credential whose permissions do not include editing documents", async () => {
    const refusal = await writeOverChat({
      authority: createOnlyKey,
      propertyId: chatPropertyId,
      value: "Acme",
    });
    expect(ChatToolError.is(refusal) && refusal.kind).toBe("unavailable");

    const direct = await Result.gen(() =>
      writeFieldValue({
        safeDb: safeDb(),
        authority: createOnlyKey,
        workspaceId,
        userId: userId(),
        recordAuditEvent: recorder(),
        entityId,
        propertyId: chatPropertyId,
        content: textContent("Acme"),
        flushSearchRepairs: false,
      }),
    );
    expect(Result.isError(direct) && direct.error).toMatchObject({
      status: 403,
    });
    expect(await cellState(chatPropertyId)).toEqual({
      field: undefined,
      metadata: undefined,
      audits: [],
    });
  });

  test("records the same audit event and cell lock through chat as through REST", async () => {
    await writeOverRest(restPropertyId, "Acme");
    const output = await writeOverChat({
      authority: editor,
      propertyId: chatPropertyId,
      value: "Acme",
    });
    expect(output).toMatchObject({ success: true, newValue: "Acme" });

    const rest = await cellState(restPropertyId);
    const chat = await cellState(chatPropertyId);

    expect(chat.field).toEqual({ content: textContent("Acme") });
    expect(chat.field).toEqual(rest.field);

    expect(rest.audits).toHaveLength(1);
    expect(chat.audits).toHaveLength(1);
    const [restAudit] = rest.audits;
    const [chatAudit] = chat.audits;
    if (!restAudit || !chatAudit) {
      panic("Expected one audit row per write");
    }
    expect(chatAudit).toMatchObject({
      action: "create",
      resourceType: "field",
      workspaceId,
    });
    expect(comparableAudit(chatAudit, chatPropertyId)).toEqual(
      comparableAudit(restAudit, restPropertyId),
    );

    expect(chat.metadata).toMatchObject({
      locked: true,
      lockProvenance: { lockedBy: userId(), reason: "manual-edit" },
    });
    expect(comparableMetadata(chat.metadata)).toEqual(
      comparableMetadata(rest.metadata),
    );
  });

  test("keeps an existing explicit lock through chat as through REST", async () => {
    const explicitLock: CellMetadata = {
      version: 1,
      manualFlags: [],
      locked: true,
      lockProvenance: {
        lockedBy: ids.userA1,
        lockedAt: "2026-01-02T03:04:05.000Z",
        reason: "explicit",
      },
    };
    await db.insert(cellMetadata).values(
      propertyIds.map((propertyId) => ({
        workspaceId,
        entityVersionId,
        propertyId,
        metadata: explicitLock,
        createdBy: ids.userA1,
        updatedBy: ids.userA1,
      })),
    );

    await writeOverRest(restPropertyId, "Acme");
    await writeOverChat({
      authority: editor,
      propertyId: chatPropertyId,
      value: "Acme",
    });

    const rest = await cellState(restPropertyId);
    const chat = await cellState(chatPropertyId);
    expect(rest.metadata).toEqual(explicitLock);
    expect(chat.metadata).toEqual(explicitLock);
  });

  test("records an update, then a removal, through chat", async () => {
    await writeOverChat({
      authority: editor,
      propertyId: chatPropertyId,
      value: "Acme",
    });
    await writeOverChat({
      authority: editor,
      propertyId: chatPropertyId,
      value: "Globex",
    });
    await writeOverChat({
      authority: editor,
      propertyId: chatPropertyId,
      value: "",
    });

    const chat = await cellState(chatPropertyId);
    expect(chat.field).toBeUndefined();
    expect(
      chat.audits
        .map((row) => ({ action: row.action, changes: row.changes }))
        .toSorted((left, right) => (left.action < right.action ? -1 : 1)),
    ).toEqual([
      {
        action: "create",
        changes: { content: { old: null, new: textContent("Acme") } },
      },
      {
        action: "delete",
        changes: { content: { old: textContent("Globex"), new: null } },
      },
      {
        action: "update",
        changes: {
          content: { old: textContent("Acme"), new: textContent("Globex") },
        },
      },
    ]);
  });
});
