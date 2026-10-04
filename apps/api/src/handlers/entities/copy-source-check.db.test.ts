import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
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
import { createSafeDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import { createFileKey } from "@/api/lib/file-key";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createCopyToWorkspace } from "./copy";

const noAudit = async () => undefined;
const handler = createCopyToWorkspace({
  enqueueDocumentProcessingRun: async () => undefined,
  enqueueEntitySearchRepairs: async () => undefined,
  enqueueImageThumbnailOrMarkFailed: async () => undefined,
  enqueuePdfDerivativeOrMarkFailed: async () => undefined,
  flushEntitySearchRepairs: async () => ({ failed: 0, repaired: 0 }),
  requestNativeExtractionRuns: async () => [],
  syncWorkspaceSearchActivity: async () => undefined,
});
let db: TestDatabase;
const orgIds: SafeId<"organization">[] = [];
const userIds: SafeId<"user">[] = [];
beforeAll(
  async () => {
    db = await getTestDb();
  },
  { timeout: 30_000 },
);
afterAll(async () => {
  if (orgIds.length) {
    await db.delete(organization).where(inArray(organization.id, orgIds));
  }
  if (userIds.length) {
    await db.delete(user).where(inArray(user.id, userIds));
  }
  await releaseTestDb();
});

const seed = async (folder: boolean) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const sourceWorkspaceId = createSafeId<"workspace">();
  const targetWorkspaceId = createSafeId<"workspace">();
  const documentId = createSafeId<"entity">();
  const folderId = createSafeId<"entity">();
  const propertyId = createSafeId<"property">();
  const firstVersionId = createSafeId<"entityVersion">();
  const currentVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const fileId = allocateFileObject();
  const historicalFileId = allocateFileObject();
  await db.insert(organization).values({
    id: organizationId,
    name: "Transfer checks",
    slug: organizationId,
    createdAt: new Date(),
  });
  orgIds.push(organizationId);
  await db.insert(user).values({
    id: userId,
    name: "Transfer user",
    email: `${userId}@example.test`,
  });
  userIds.push(userId);
  await db.insert(workspaces).values([
    { id: sourceWorkspaceId, organizationId, name: "Source", reference: "SRC" },
    { id: targetWorkspaceId, organizationId, name: "Target", reference: "TGT" },
  ]);
  await db.insert(properties).values([
    {
      id: propertyId,
      workspaceId: sourceWorkspaceId,
      name: "File",
      content: { type: "file", version: 1 },
      tool: { type: "manual-input", version: 1 },
      status: "fresh",
      system: true,
      kinds: ["document"],
    },
    {
      id: createSafeId<"property">(),
      workspaceId: targetWorkspaceId,
      name: "File",
      content: { type: "file", version: 1 },
      tool: { type: "manual-input", version: 1 },
      status: "fresh",
      system: true,
      kinds: ["document"],
    },
  ]);
  if (folder) {
    const versionId = createSafeId<"entityVersion">();
    await db.insert(entities).values({
      id: folderId,
      workspaceId: sourceWorkspaceId,
      kind: "folder",
      name: "Folder",
    });
    await db.insert(entityVersions).values({
      id: versionId,
      entityId: folderId,
      workspaceId: sourceWorkspaceId,
      versionNumber: 1,
    });
    await db
      .update(entities)
      .set({ currentVersionId: versionId })
      .where(eq(entities.id, folderId));
  }
  await db.insert(entities).values({
    id: documentId,
    workspaceId: sourceWorkspaceId,
    kind: "document",
    name: "Original.txt",
    parentId: folder ? folderId : null,
    docSequence: 1,
  });
  await db.insert(entityVersions).values([
    {
      id: firstVersionId,
      entityId: documentId,
      workspaceId: sourceWorkspaceId,
      versionNumber: 1,
    },
    {
      id: currentVersionId,
      entityId: documentId,
      workspaceId: sourceWorkspaceId,
      versionNumber: 2,
    },
  ]);
  const content = {
    type: "file",
    version: 1,
    id: fileId,
    fileName: "Original.txt",
    mimeType: "text/plain",
    sizeBytes: 8,
    encrypted: false,
    sha256Hex: "a".repeat(64),
    pdfFileId: null,
  } as const;
  await db.insert(fields).values([
    {
      id: createSafeId<"field">(),
      entityVersionId: firstVersionId,
      workspaceId: sourceWorkspaceId,
      propertyId,
      content: { ...content, id: historicalFileId },
    },
    {
      id: fieldId,
      entityVersionId: currentVersionId,
      workspaceId: sourceWorkspaceId,
      propertyId,
      content,
    },
  ]);
  await db
    .update(entities)
    .set({ currentVersionId })
    .where(eq(entities.id, documentId));
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(
      db,
      [sourceWorkspaceId, targetWorkspaceId],
      organizationId,
      userId,
    ),
  );
  const fake = startFakeS3();
  const key = (id: string) =>
    createFileKey({
      organizationId,
      workspaceId: sourceWorkspaceId,
      fileId: id,
      mimeType: "text/plain",
    });
  fake.put(envBase.S3_BUCKET, key(fileId), "original", "text/plain");
  fake.put(envBase.S3_BUCKET, key(historicalFileId), "history", "text/plain");
  const run = async (deleteSource: boolean) =>
    handler.handler(
      asTestRaw<Parameters<typeof handler.handler>[0]>({
        workspaceId: sourceWorkspaceId,
        user: { id: userId, email: `${userId}@example.test` },
        session: { activeOrganizationId: organizationId },
        memberRole: sessionMemberRole("owner"),
        body: {
          entityId: folder ? folderId : documentId,
          targetWorkspaceId,
          targetParentId: null,
          deleteSource,
        },
        request: new Request("https://example.test/transfer"),
        route: "/v1/workspaces/:workspaceId/entities/copy-to-workspace",
        safeDb,
        recordAuditEvent: noAudit,
        createAuditRecorder: () => noAudit,
        getWorkspaceAccess: async () => ({
          id: targetWorkspaceId,
          status: "active",
        }),
      }),
    );
  return {
    organizationId,
    userId,
    sourceWorkspaceId,
    targetWorkspaceId,
    documentId,
    folderId,
    propertyId,
    firstVersionId,
    currentVersionId,
    fieldId,
    fileId,
    content,
    safeDb,
    fake,
    key,
    run,
  };
};
type Fixture = Awaited<ReturnType<typeof seed>>;

const removalBlockers = {
  processing: async (f: Fixture) => {
    const id = createSafeId<"documentProcessingRun">();
    await db.insert(documentProcessingRuns).values({
      id,
      organizationId: f.organizationId,
      workspaceId: f.sourceWorkspaceId,
      entityId: f.documentId,
      entityVersionId: f.currentVersionId,
      fieldId: f.fieldId,
      sourceFileId: f.fileId,
      sourceSha256Hex: f.content.sha256Hex,
      kind: "ocr",
      requestSource: "manual",
      status: "running",
    });
    return async () => {
      await db
        .delete(documentProcessingRuns)
        .where(eq(documentProcessingRuns.id, id));
    };
  },
  desktop: async (f: Fixture) => {
    const id = createSafeId<"desktopEditSession">();
    await db.insert(desktopEditSessions).values({
      id,
      workspaceId: f.sourceWorkspaceId,
      entityId: f.documentId,
      propertyId: f.propertyId,
      baseVersionId: f.currentVersionId,
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
        .delete(desktopEditSessions)
        .where(eq(desktopEditSessions.id, id));
    };
  },
  collaboration: async (f: Fixture) => {
    const id = createSafeId<"folioCollabRoom">();
    await db.insert(folioCollabRooms).values({
      id,
      workspaceId: f.sourceWorkspaceId,
      entityId: f.documentId,
      propertyId: f.propertyId,
      baseVersionId: f.currentVersionId,
      sourceVersionId: f.currentVersionId,
      fileName: "Source.docx",
      yjsSnapshotFileId: createSafeId<"userFile">(),
      docxCheckpointFileId: createSafeId<"userFile">(),
      lastActivityAt: new Date(),
    });
    return async () => {
      await db.delete(folioCollabRooms).where(eq(folioCollabRooms.id, id));
    };
  },
  signing: async (f: Fixture) => {
    const id = createSafeId<"pdfSigningSession">();
    await db.insert(pdfSigningSessions).values({
      id,
      workspaceId: f.sourceWorkspaceId,
      entityId: f.documentId,
      propertyId: f.propertyId,
      baseVersionId: f.currentVersionId,
      createdBy: f.userId,
      handoffTokenHash: "c".repeat(64),
      handoffExpiresAt: new Date(Date.now() + 60_000),
      tokenExpiresAt: new Date(Date.now() + 60_000),
      status: "open",
    });
    return async () => {
      await db.delete(pdfSigningSessions).where(eq(pdfSigningSessions.id, id));
    };
  },
  time: async (f: Fixture) => {
    const id = createSafeId<"timeEntry">();
    await db.insert(timeEntries).values({
      id,
      organizationId: f.organizationId,
      workspaceId: f.sourceWorkspaceId,
      workItemId: f.documentId,
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
      workspaceId: f.sourceWorkspaceId,
      matterId: f.documentId,
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

test.each(Object.entries(removalBlockers))(
  "folder move refuses %s state on a child before copying any object",
  async (kind, addBlocker) => {
    const f = await seed(true);
    const clearBlocker = await addBlocker(f);
    try {
      const before = await sourceState(f);
      const beforeObjects = [...f.fake.objects.entries()];
      const referenced = kind === "time" || kind === "expense";
      expect(await f.run(true)).toMatchObject({
        code: 409,
        response: {
          code: referenced
            ? "entity_transfer_source_referenced"
            : "entity_transfer_source_in_use",
          retryable: !referenced,
        },
      });
      expect(f.fake.requests.filter(({ method }) => method === "COPY")).toEqual(
        [],
      );
      expect([...f.fake.objects.entries()]).toEqual(beforeObjects);
      expect(await sourceState(f)).toEqual(before);
      expect(
        await db.$count(
          entities,
          eq(entities.workspaceId, f.targetWorkspaceId),
        ),
      ).toBe(0);
      // The removal gate applies only to moving; copying carries its ordinary snapshot.
      expect(await f.run(false)).toHaveProperty("entityId");
    } finally {
      await clearBlocker();
      f.fake.stop();
    }
  },
  30_000,
);

test.each(["desktop", "signing"] as const)(
  "folder move allows an expired open %s session on a child",
  async (kind) => {
    const f = await seed(true);
    const clearSession = await removalBlockers[kind](f);
    // A fixed old timestamp keeps this a liveness test, independent of how
    // long the handler takes to reach either removal-state check.
    const tokenExpiresAt = new Date("2020-01-01T00:00:00.000Z");
    try {
      switch (kind) {
        case "desktop": {
          const expired = await db
            .update(desktopEditSessions)
            .set({ tokenExpiresAt })
            .where(eq(desktopEditSessions.entityId, f.documentId))
            .returning({
              status: desktopEditSessions.status,
              tokenExpiresAt: desktopEditSessions.tokenExpiresAt,
            });
          expect(expired).toEqual([{ status: "open", tokenExpiresAt }]);
          break;
        }
        case "signing": {
          const expired = await db
            .update(pdfSigningSessions)
            .set({ tokenExpiresAt })
            .where(eq(pdfSigningSessions.entityId, f.documentId))
            .returning({
              status: pdfSigningSessions.status,
              tokenExpiresAt: pdfSigningSessions.tokenExpiresAt,
            });
          expect(expired).toEqual([{ status: "open", tokenExpiresAt }]);
          break;
        }
        default: {
          const exhaustive: never = kind;
          throw new TypeError("Unexpected session kind", { cause: exhaustive });
        }
      }
      expect(await f.run(true)).toHaveProperty("entityId");
      expect(
        await db.$count(
          entities,
          eq(entities.workspaceId, f.sourceWorkspaceId),
        ),
      ).toBe(0);
      expect(
        await db.$count(
          entities,
          eq(entities.workspaceId, f.targetWorkspaceId),
        ),
      ).toBe(2);
      expect(
        f.fake.requests.filter(({ method }) => method === "COPY"),
      ).toHaveLength(2);
      expect(f.fake.objects.size).toBe(2);
      expect(
        [...f.fake.objects.keys()].every((key) =>
          key.includes(f.targetWorkspaceId),
        ),
      ).toBe(true);
    } finally {
      await clearSession();
      f.fake.stop();
    }
  },
  30_000,
);

test("move refuses a source beyond the live-version read limit without suggesting retry or copying objects", async () => {
  const f = await seed(false);
  try {
    await db.insert(entityVersions).values(
      Array.from({ length: LIMITS.versionsPerEntity - 1 }, (_, index) => ({
        id: createSafeId<"entityVersion">(),
        entityId: f.documentId,
        workspaceId: f.sourceWorkspaceId,
        versionNumber: index + 3,
      })),
    );
    const objects = [...f.fake.objects.entries()];
    expect(await f.run(true)).toMatchObject({
      code: 409,
      response: { code: "entity_transfer_source_limit", retryable: false },
    });
    expect(f.fake.requests.filter(({ method }) => method === "COPY")).toEqual(
      [],
    );
    expect([...f.fake.objects.entries()]).toEqual(objects);
    expect(
      await db.$count(
        entityVersions,
        eq(entityVersions.workspaceId, f.sourceWorkspaceId),
      ),
    ).toBe(LIMITS.versionsPerEntity + 1);
    expect(
      await db.$count(entities, eq(entities.workspaceId, f.targetWorkspaceId)),
    ).toBe(0);
  } finally {
    f.fake.stop();
  }
}, 30_000);

const sourceState = async ({ sourceWorkspaceId }: Fixture) => ({
  entities: await db.query.entities.findMany({
    where: { workspaceId: { eq: sourceWorkspaceId } },
    orderBy: { id: "asc" },
    limit: 100,
  }),
  versions: await db.query.entityVersions.findMany({
    where: { workspaceId: { eq: sourceWorkspaceId } },
    orderBy: { id: "asc" },
    limit: 100,
  }),
  fields: await db.query.fields.findMany({
    where: { workspaceId: { eq: sourceWorkspaceId } },
    orderBy: { id: "asc" },
    limit: 100,
  }),
});
const cases = [
  "new version",
  "restored version",
  "deleted historical version",
  "rename",
  "field edit",
  "version metadata",
  "reparent",
  "read-only",
  "added child",
  "deleted child",
] as const;
test.each(cases)(
  "move refuses a committed %s change without changing source rows or storage",
  async (change) => {
    const f = await seed(
      change === "added child" ||
        change === "deleted child" ||
        change === "reparent",
    );
    const hold = f.fake.holdNext({
      method: "COPY",
      keyIncludes: f.targetWorkspaceId,
    });
    const moving = f.run(true);
    try {
      await Promise.race([
        hold.reached,
        moving.then(() => {
          throw new TypeError("Transfer settled before storage barrier");
        }),
      ]);
      const before = await sourceState(f);
      switch (change) {
        case "new version": {
          const fileId = allocateFileObject();
          f.fake.put(
            envBase.S3_BUCKET,
            f.key(fileId),
            "new file",
            "text/plain",
          );
          const outcome = await f.safeDb(
            async (tx) =>
              await writeFileVersion({
                tx,
                organizationId: f.organizationId,
                workspaceId: f.sourceWorkspaceId,
                entityId: f.documentId,
                userId: f.userId,
                recordAuditEvent: noAudit,
                entityVersionId: createSafeId<"entityVersion">(),
                fieldId: createSafeId<"field">(),
                fileId,
                fileName: "New.txt",
                mimeType: "text/plain",
                encryption: serverBuiltFileEncryption(),
                sizeBytes: 8,
                sha256Hex: "b".repeat(64),
                source: null,
                writePolicy: { type: "replace-current-file" },
              }),
          );
          expect(Result.isOk(outcome)).toBe(true);
          if (Result.isError(outcome)) {
            throw outcome.error;
          }
          expect(outcome.value.status).toBe("ok");
          break;
        }
        case "restored version": {
          const restored = createSafeId<"entityVersion">();
          await db.insert(entityVersions).values({
            id: restored,
            entityId: f.documentId,
            workspaceId: f.sourceWorkspaceId,
            versionNumber: 3,
          });
          const oldFields = await db.query.fields.findMany({
            where: { entityVersionId: { eq: f.firstVersionId } },
            limit: 100,
          });
          await db.insert(fields).values(
            oldFields.map(({ content, propertyId }) => ({
              id: createSafeId<"field">(),
              entityVersionId: restored,
              workspaceId: f.sourceWorkspaceId,
              propertyId,
              content,
            })),
          );
          await db
            .update(entities)
            .set({ currentVersionId: restored })
            .where(eq(entities.id, f.documentId));
          break;
        }
        case "deleted historical version":
          await db
            .update(entityVersions)
            .set({ deletedAt: new Date() })
            .where(eq(entityVersions.id, f.firstVersionId));
          break;
        case "rename":
          await db
            .update(entities)
            .set({ name: "Renamed.txt" })
            .where(eq(entities.id, f.documentId));
          break;
        case "field edit":
          await db
            .update(fields)
            .set({ content: { ...f.content, fileName: "Changed.txt" } })
            .where(eq(fields.id, f.fieldId));
          break;
        case "read-only":
          await db
            .update(entities)
            .set({ readOnly: true })
            .where(eq(entities.id, f.documentId));
          break;
        case "reparent":
          await db
            .update(entities)
            .set({ parentId: null })
            .where(eq(entities.id, f.documentId));
          break;
        case "version metadata":
          await db
            .update(entityVersions)
            .set({ label: "Revised" })
            .where(eq(entityVersions.id, f.firstVersionId));
          break;
        case "added child": {
          const childId = createSafeId<"entity">();
          const versionId = createSafeId<"entityVersion">();
          await db.insert(entities).values({
            id: childId,
            kind: "folder",
            name: "Added",
            parentId: f.folderId,
            workspaceId: f.sourceWorkspaceId,
          });
          await db.insert(entityVersions).values({
            id: versionId,
            entityId: childId,
            workspaceId: f.sourceWorkspaceId,
            versionNumber: 1,
          });
          await db
            .update(entities)
            .set({ currentVersionId: versionId })
            .where(eq(entities.id, childId));
          break;
        }
        case "deleted child":
          await db.delete(entities).where(eq(entities.id, f.documentId));
          break;
      }
      const edited = await sourceState(f);
      expect(edited).not.toEqual(before);
      const sourceObjects = [...f.fake.objects.entries()].filter(([key]) =>
        key.includes(f.sourceWorkspaceId),
      );
      hold.release();
      expect(await moving).toMatchObject({ code: 409 });
      expect(await sourceState(f)).toEqual(edited);
      expect(
        await db.$count(
          entities,
          eq(entities.workspaceId, f.targetWorkspaceId),
        ),
      ).toBe(0);
      expect(
        await db.$count(
          entityVersions,
          eq(entityVersions.workspaceId, f.targetWorkspaceId),
        ),
      ).toBe(0);
      expect(
        await db.$count(fields, eq(fields.workspaceId, f.targetWorkspaceId)),
      ).toBe(0);
      expect([...f.fake.objects.entries()]).toEqual(sourceObjects);
    } finally {
      hold.release();
      await moving;
      f.fake.stop();
    }
  },
  30_000,
);

test("an unchanged folder move carries its whole history and removes source objects", async () => {
  const f = await seed(true);
  try {
    expect(await f.run(true)).toHaveProperty("entityId");
    expect(
      await db.$count(entities, eq(entities.workspaceId, f.sourceWorkspaceId)),
    ).toBe(0);
    expect(
      await db.$count(entities, eq(entities.workspaceId, f.targetWorkspaceId)),
    ).toBe(2);
    expect(
      await db.$count(
        entityVersions,
        eq(entityVersions.workspaceId, f.targetWorkspaceId),
      ),
    ).toBe(3);
    expect(
      [...f.fake.objects.keys()].every((key) =>
        key.includes(f.targetWorkspaceId),
      ),
    ).toBe(true);
    expect(f.fake.objects.size).toBe(2);
    expect(
      [...f.fake.objects.values()]
        .map(({ bytes }) => new TextDecoder().decode(bytes))
        .toSorted(),
    ).toEqual(["history", "original"]);
  } finally {
    f.fake.stop();
  }
}, 30_000);

test("plain copy retains its snapshot when source name changes during storage copy", async () => {
  const f = await seed(false);
  const hold = f.fake.holdNext({
    method: "COPY",
    keyIncludes: f.targetWorkspaceId,
  });
  const copying = f.run(false);
  try {
    await Promise.race([
      hold.reached,
      copying.then(() => {
        throw new TypeError("Copy settled before storage barrier");
      }),
    ]);
    await db
      .update(entities)
      .set({ name: "Later.txt" })
      .where(eq(entities.id, f.documentId));
    const edited = await sourceState(f);
    hold.release();
    expect(await copying).toHaveProperty("entityId");
    expect(await sourceState(f)).toEqual(edited);
    const target = await db.query.entities.findFirst({
      where: { workspaceId: { eq: f.targetWorkspaceId } },
    });
    expect(target?.name).toBe("Original.txt");
    expect(
      await db.$count(
        entityVersions,
        eq(entityVersions.workspaceId, f.targetWorkspaceId),
      ),
    ).toBe(1);
    expect(f.fake.objects.size).toBe(3);
  } finally {
    hold.release();
    await copying;
    f.fake.stop();
  }
}, 30_000);
