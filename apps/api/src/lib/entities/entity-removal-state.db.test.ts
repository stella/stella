import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  desktopEditSessions,
  documentProcessingRuns,
  entities,
  entityVersions,
  expenses,
  fields,
  folioCollabRooms,
  pdfSigningSessions,
  properties,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS } from "@/api/lib/folio-collab-room-contract";
import { cents } from "@/api/lib/money";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { validateEntityRemovalState } from "./entity-removal-state";

let db: TestDatabase;
beforeAll(
  async () => {
    db = await getTestDb();
  },
  { timeout: 30_000 },
);
afterAll(async () => {
  await releaseTestDb();
});

const seed = async () => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  const fieldId = createSafeId<"field">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Removal state",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Removal actor",
    email: `${userId}@example.test`,
  });
  await db.insert(workspaces).values([
    { id: workspaceId, organizationId, name: "Source", reference: "SOURCE" },
    { id: otherWorkspaceId, organizationId, name: "Other", reference: "OTHER" },
  ]);
  await db.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "File",
    content: { type: "file", version: 1 },
    tool: { type: "manual-input", version: 1 },
    status: "fresh",
    kinds: ["document"],
    system: true,
  });
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    name: "Source.docx",
    kind: "document",
    docSequence: 1,
  });
  await db
    .insert(entityVersions)
    .values({ id: entityVersionId, entityId, workspaceId, versionNumber: 1 });
  await db.insert(fields).values({
    id: fieldId,
    entityVersionId,
    propertyId,
    workspaceId,
    content: { type: "text", version: 1, value: "Source" },
  });
  return {
    organizationId,
    userId,
    workspaceId,
    otherWorkspaceId,
    entityId,
    entityVersionId,
    propertyId,
    fieldId,
  };
};
type Fixture = Awaited<ReturnType<typeof seed>>;
const validate = (
  f: Fixture,
  operation: "delete" | "move",
  workspaceId = f.workspaceId,
) =>
  db.transaction(
    async (tx) =>
      await validateEntityRemovalState({
        tx: asTestRaw<Transaction>(tx),
        workspaceId,
        entityIds: [createSafeId<"entity">(), f.entityId],
        operation,
        now: new Date(),
      }),
  );

const cases = {
  processing: async (f: Fixture) => {
    const id = createSafeId<"documentProcessingRun">();
    await db.insert(documentProcessingRuns).values({
      id,
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      entityId: f.entityId,
      entityVersionId: f.entityVersionId,
      fieldId: f.fieldId,
      sourceFileId: createSafeId<"userFile">(),
      sourceSha256Hex: "a".repeat(64),
      kind: "ocr",
      requestSource: "manual",
      status: "running",
    });
    return async () => {
      await db
        .update(documentProcessingRuns)
        .set({ status: "succeeded" })
        .where(eq(documentProcessingRuns.id, id));
    };
  },
  desktop: async (f: Fixture) => {
    const id = createSafeId<"desktopEditSession">();
    await db.insert(desktopEditSessions).values({
      id,
      workspaceId: f.workspaceId,
      entityId: f.entityId,
      propertyId: f.propertyId,
      baseVersionId: f.entityVersionId,
      createdBy: f.userId,
      fileType: "docx",
      fileName: "Source.docx",
      checkpointFileId: createSafeId<"userFile">(),
      sessionTokenHash: "b".repeat(64),
      tokenExpiresAt: new Date(Date.now() + 60_000),
      status: "open",
    });
    return async () => {
      await db
        .update(desktopEditSessions)
        .set({ status: "cancelled" })
        .where(eq(desktopEditSessions.id, id));
    };
  },
  collaboration: async (f: Fixture) => {
    const id = createSafeId<"folioCollabRoom">();
    await db.insert(folioCollabRooms).values({
      id,
      workspaceId: f.workspaceId,
      entityId: f.entityId,
      propertyId: f.propertyId,
      baseVersionId: f.entityVersionId,
      sourceVersionId: f.entityVersionId,
      fileName: "Source.docx",
      yjsSnapshotFileId: createSafeId<"userFile">(),
      docxCheckpointFileId: createSafeId<"userFile">(),
      lastActivityAt: new Date(),
    });
    return async () => {
      await db
        .update(folioCollabRooms)
        .set({
          lastActivityAt: new Date(
            Date.now() - FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS - 60_000,
          ),
        })
        .where(eq(folioCollabRooms.id, id));
    };
  },
  signing: async (f: Fixture) => {
    const id = createSafeId<"pdfSigningSession">();
    await db.insert(pdfSigningSessions).values({
      id,
      workspaceId: f.workspaceId,
      entityId: f.entityId,
      propertyId: f.propertyId,
      baseVersionId: f.entityVersionId,
      createdBy: f.userId,
      handoffTokenHash: "c".repeat(64),
      handoffExpiresAt: new Date(Date.now() + 60_000),
      tokenExpiresAt: new Date(Date.now() + 60_000),
      status: "open",
    });
    return async () => {
      await db
        .update(pdfSigningSessions)
        .set({ status: "cancelled" })
        .where(eq(pdfSigningSessions.id, id));
    };
  },
  time: async (f: Fixture) => {
    const id = createSafeId<"timeEntry">();
    await db.insert(timeEntries).values({
      id,
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      workItemId: f.entityId,
      dateWorked: "2026-10-02",
      timezoneId: "UTC",
      durationMinutes: 1,
      billedMinutes: 1,
      rateAtEntry: cents(0),
      currency: "EUR",
      narrative: "Source",
      source: "manual",
    });
    return async () => {
      await db.delete(timeEntries).where(eq(timeEntries.id, id));
    };
  },
  expense: async (f: Fixture) => {
    const id = createSafeId<"expense">();
    await db.insert(expenses).values({
      id,
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      matterId: f.entityId,
      dateIncurred: "2026-10-02",
      amount: cents(1),
      currency: "EUR",
      category: "other",
      description: "Source",
    });
    return async () => {
      await db.delete(expenses).where(eq(expenses.id, id));
    };
  },
};
test.each(Object.entries(cases))(
  "move refuses %s state anywhere in its source set and leaves delete semantics unchanged",
  async (kind, addState) => {
    const f = await seed();
    const clearState = await addState(f);
    const result = await validate(f, "move");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const referenced = kind === "time" || kind === "expense";
      expect(result.error.status).toBe(409);
      expect(result.error.code).toBe(
        referenced
          ? "entity_transfer_source_referenced"
          : "entity_transfer_source_in_use",
      );
      expect(result.error.retryable).toBe(!referenced);
    }
    expect((await validate(f, "move", f.otherWorkspaceId)).isOk()).toBe(true);
    expect((await validate(f, "delete")).isErr()).toBe(kind === "processing");
    await clearState();
    expect((await validate(f, "move")).isOk()).toBe(true);
    // Restrictions must be removed before the organization's cascading teardown.
    await db.delete(organization).where(eq(organization.id, f.organizationId));
    await db.delete(user).where(eq(user.id, f.userId));
  },
);

test.each(["desktop", "signing"] as const)(
  "only unexpired open %s sessions block removal at the caller's cutoff",
  async (kind) => {
    const f = await seed();
    const clear = await cases[kind](f);
    const now = new Date("2030-01-01T12:00:00.000Z");
    try {
      for (const offset of [-1, 0, 1]) {
        const tokenExpiresAt = new Date(now.getTime() + offset);
        if (kind === "desktop") {
          await db
            .update(desktopEditSessions)
            .set({ tokenExpiresAt })
            .where(eq(desktopEditSessions.entityId, f.entityId));
        } else {
          await db
            .update(pdfSigningSessions)
            .set({ tokenExpiresAt })
            .where(eq(pdfSigningSessions.entityId, f.entityId));
        }
        const result = await db.transaction(
          async (tx) =>
            await validateEntityRemovalState({
              tx: asTestRaw<Transaction>(tx),
              workspaceId: f.workspaceId,
              entityIds: [f.entityId],
              operation: "move",
              now,
            }),
        );
        if (offset <= 0) {
          expect(result.isOk()).toBe(true);
        } else {
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error).toMatchObject({
              status: 409,
              code: "entity_transfer_source_in_use",
              retryable: true,
            });
          }
        }
      }
    } finally {
      await clear();
      await db
        .delete(organization)
        .where(eq(organization.id, f.organizationId));
      await db.delete(user).where(eq(user.id, f.userId));
    }
  },
);
