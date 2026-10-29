import { panic, Result } from "better-result";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";

import { DATA_BOX_MESSAGE_MIME_TYPE } from "@stll/api-contract/data-box";
import { compareCodeUnit } from "@stll/collation";
import { sha256Hex } from "@stll/sha256/bun";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceFilers,
  entities,
  organizationSettings,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { readCorrespondenceChannel } from "@/api/lib/email/correspondence/provenance";
import { fileUploadedMail } from "@/api/lib/email/inbound/upload";
import type { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { fileSecurityRejection } from "@/api/lib/file-scan/rejection";
import { FileScanRejectedError } from "@/api/lib/file-scan/scan-upload";
import type { scanUpload } from "@/api/lib/file-scan/scan-upload";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  FIXTURE_MESSAGE,
  messageXml,
  sealContent,
  zfoFile,
} from "@/api/tests/fixtures/zfo";
import {
  type GatedTestDb,
  openGatedTestDatabase,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const organizationId = mintAuthProviderId<"organization">();
const uploaderId = mintAuthProviderId<"user">();
const outsiderId = mintAuthProviderId<"user">();
const workspaceId = createSafeId<"workspace">();
const otherWorkspaceId = createSafeId<"workspace">();
let db: GatedTestDb;

const fixtureScoped = () =>
  createScopedDb(
    markRlsDatabase(db),
    [workspaceId, otherWorkspaceId],
    organizationId,
    uploaderId,
  );

const toArrayBuffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;

const passingScan: typeof scanUpload = async ({
  bytes,
  fileName,
  declaredMimeType,
}) =>
  Result.ok(
    testScannedFile({
      bytes: toArrayBuffer(new Uint8Array(bytes)),
      mimeType: declaredMimeType,
      path: fileName,
    }),
  );

const rejectingScan: typeof scanUpload = async () => {
  const rejection = fileSecurityRejection({
    verdict: "reject",
    findings: [{ rule: "test-rule", severity: "reject", message: "rejected" }],
  });
  if (rejection === null) {
    throw new Error("expected a rejection");
  }
  return Result.err(
    new FileScanRejectedError({
      message: rejection.message,
      rejection,
      inspectionFailures: [],
    }),
  );
};

type DocumentWrites = { failAfter: number | null; written: number };

/**
 * Stores a document row and runs its link in the same transaction, as the
 * real writer does, without object storage.
 */
const fakeDocumentWriter =
  (writes: DocumentWrites): typeof createEntityFromBuffer =>
  async ({
    scopedDb,
    workspaceId: documentWorkspaceId,
    userId,
    fileName,
    parentId,
    afterCreate,
  }) => {
    if (writes.failAfter !== null && writes.written >= writes.failAfter) {
      throw new Error("Simulated storage outage");
    }
    const value = {
      entityId: createSafeId<"entity">(),
      entityVersionId: createSafeId<"entityVersion">(),
      fieldId: createSafeId<"field">(),
      fileName,
      renamed: false,
    };
    await scopedDb(async (tx) => {
      await tx.insert(entities).values({
        id: value.entityId,
        workspaceId: documentWorkspaceId,
        name: fileName,
        createdBy: userId,
        parentId: parentId ?? null,
      });
      await afterCreate?.(tx, value);
    });
    writes.written += 1;
    return Result.ok(value);
  };

type StoreZfoOptions = {
  createdBy: SafeId<"user">;
  fileWorkspaceId?: SafeId<"workspace">;
  parentId?: SafeId<"entity"> | null;
};

const storeZfoFile = async ({
  createdBy,
  fileWorkspaceId = workspaceId,
  parentId = null,
}: StoreZfoOptions) => {
  const entityId = createSafeId<"entity">();
  await db.insert(entities).values({
    id: entityId,
    workspaceId: fileWorkspaceId,
    name: "zprava.zfo",
    createdBy,
    parentId,
  });
  return entityId;
};

type ProcessOptions = {
  entityId: SafeId<"entity">;
  bytes: Uint8Array;
  fileWorkspaceId?: SafeId<"workspace">;
  writes?: DocumentWrites;
  scan?: typeof scanUpload;
};

const processUpload = async ({
  entityId,
  bytes,
  fileWorkspaceId = workspaceId,
  writes = { failAfter: null, written: 0 },
  scan = passingScan,
}: ProcessOptions) =>
  await fileUploadedMail({
    bytes: toArrayBuffer(bytes),
    mimeType: DATA_BOX_MESSAGE_MIME_TYPE,
    scope: { organizationId, workspaceId: fileWorkspaceId, entityId },
    database: db,
    scopedDbForUploader: (scope) =>
      createScopedDb(
        markRlsDatabase(db),
        [scope.workspaceId],
        scope.organizationId,
        scope.userId,
      ),
    createDocument: fakeDocumentWriter(writes),
    scanAttachment: scan,
  });

const records = async () =>
  await fixtureScoped()(
    async (tx) =>
      await tx
        .select()
        .from(correspondence)
        .where(eq(correspondence.organizationId, organizationId)),
  );

const attachmentsOf = async (correspondenceId: SafeId<"correspondence">) =>
  await fixtureScoped()(
    async (tx) =>
      await tx
        .select({
          ordinal: correspondenceAttachments.ordinal,
          filename: correspondenceAttachments.filename,
          mediaType: correspondenceAttachments.mediaType,
          parentId: entities.parentId,
        })
        .from(correspondenceAttachments)
        .innerJoin(
          entities,
          eq(entities.id, correspondenceAttachments.entityId),
        )
        .where(eq(correspondenceAttachments.correspondenceId, correspondenceId))
        .orderBy(asc(correspondenceAttachments.ordinal)),
  );

if (!databaseUrl || !runPostgresTests) {
  describe.skip("uploaded data-box messages filed as correspondence", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("uploaded data-box messages filed as correspondence", () => {
    const gated = openGatedTestDatabase(databaseUrl);
    db = gated.db;
    gated.cleanUp(async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      for (const id of [uploaderId, outsiderId]) {
        await db.delete(user).where(eq(user.id, id));
      }
    });

    beforeAll(async () => {
      await db.insert(user).values([
        {
          id: uploaderId,
          name: "Uploader",
          email: "uploader@example.test",
          emailVerified: true,
        },
        {
          id: outsiderId,
          name: "Outsider",
          email: "outsider@example.test",
          emailVerified: true,
        },
      ]);
      await db.insert(organization).values({
        id: organizationId,
        name: "Data-box uploads",
        slug: `data-box-uploads-${organizationId}`,
        createdAt: new Date(),
      });
      await recordNewOrganizationAccessState(db, {
        organizationId,
        now: new Date(),
      });
      await db.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: uploaderId,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: outsiderId,
          role: "member",
          createdAt: new Date(),
        },
      ]);
      await db.insert(workspaces).values([
        {
          id: workspaceId,
          organizationId,
          name: "Matter",
          reference: "DATABOX-1",
        },
        {
          id: otherWorkspaceId,
          organizationId,
          name: "Other matter",
          reference: "DATABOX-2",
        },
      ]);
      await db.insert(workspaceMembers).values([
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId,
          userId: uploaderId,
        },
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId: otherWorkspaceId,
          userId: uploaderId,
        },
      ]);
    });

    beforeEach(async () => {
      await fixtureScoped()(
        async (tx) =>
          await tx
            .delete(correspondence)
            .where(eq(correspondence.organizationId, organizationId)),
      );
      for (const id of [workspaceId, otherWorkspaceId]) {
        await db.delete(entities).where(eq(entities.workspaceId, id));
      }
    });

    test("a .zfo is one data-box record whose files are stored beside it", async () => {
      const folderId = createSafeId<"entity">();
      await db.insert(entities).values({
        id: folderId,
        workspaceId,
        name: "Court",
        createdBy: uploaderId,
      });
      const entityId = await storeZfoFile({
        createdBy: uploaderId,
        parentId: folderId,
      });
      const outcome = await processUpload({
        entityId,
        bytes: await zfoFile(),
      });
      expect(outcome.isOk() && outcome.value.status).toBe("filed");

      const [record, ...others] = await records();
      expect(others).toHaveLength(0);
      expect(record).toMatchObject({
        channel: "data_box",
        direction: null,
        source: "upload",
        sourceEntityId: entityId,
        originalSignature: { status: "unverified" },
        messageId: FIXTURE_MESSAGE.messageId,
        subject: FIXTURE_MESSAGE.annotation,
        from: { address: "abc2def", name: FIXTURE_MESSAGE.senderName },
        to: [{ address: "xyz9876", name: FIXTURE_MESSAGE.recipientName }],
        bodyText: "",
        dataBox: {
          messageId: FIXTURE_MESSAGE.messageId,
          status: "accepted_by_login",
          sender: { boxId: "abc2def", fileMark: "12 C 345/2026" },
        },
      });
      if (record === undefined) {
        throw new Error("expected the data-box record");
      }
      expect(record.receivedAt.toISOString()).toBe("2026-10-14T07:12:33.120Z");
      expect(await attachmentsOf(record.id)).toEqual([
        {
          ordinal: 0,
          filename: "usneseni.pdf",
          mediaType: "application/pdf",
          parentId: folderId,
        },
        {
          ordinal: 1,
          filename: "pouceni.txt",
          mediaType: "text/plain",
          parentId: folderId,
        },
      ]);
    });

    test("the organization's own boxes decide the direction", async () => {
      const cases = [
        { boxIds: ["abc2def"], direction: "out", basis: "organization_sender" },
        {
          boxIds: ["xyz9876"],
          direction: "in",
          basis: "organization_recipient",
        },
        { boxIds: ["abc2def", "xyz9876"], direction: "in", basis: "unknown" },
      ] as const;
      for (const [index, { boxIds, direction, basis }] of cases.entries()) {
        // db-await-in-loop: one filing per organization box setting, in order
        await db
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId,
            dataBoxIds: [...boxIds],
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: { dataBoxIds: [...boxIds] },
          });
        const messageId = `98765432${index}`;
        const outcome = await processUpload({
          entityId: await storeZfoFile({ createdBy: uploaderId }),
          bytes: await zfoFile({ messageId }),
        });
        expect(outcome.isOk() && outcome.value.status).toBe("filed");
        const record = (await records()).find(
          (candidate) => candidate.messageId === messageId,
        );
        expect(record?.direction).toBeNull();
        expect(record?.dataBox).not.toHaveProperty("directionBasis");
        if (record === undefined) {
          panic("Expected filed data-box record");
        }
        const projected = readCorrespondenceChannel(record, boxIds);
        expect([
          projected.direction,
          projected.dataBox?.directionBasis,
        ]).toEqual([direction, basis]);
      }
      await db
        .delete(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId));
    });

    test("a batch with copies of one message converges per matter", async () => {
      const bytes = await zfoFile();
      const first = await storeZfoFile({ createdBy: uploaderId });
      const copy = await storeZfoFile({ createdBy: uploaderId });
      const elsewhere = await storeZfoFile({
        createdBy: uploaderId,
        fileWorkspaceId: otherWorkspaceId,
      });
      const other = await storeZfoFile({ createdBy: uploaderId });
      const outcomes = [
        await processUpload({ entityId: first, bytes }),
        await processUpload({ entityId: copy, bytes }),
        await processUpload({ entityId: first, bytes }),
        await processUpload({
          entityId: elsewhere,
          bytes,
          fileWorkspaceId: otherWorkspaceId,
        }),
        await processUpload({
          entityId: other,
          bytes: await zfoFile({ messageId: "1234567891" }),
        }),
      ];
      expect(
        outcomes.map((outcome) => outcome.isOk() && outcome.value.status),
      ).toEqual(["filed", "duplicate", "duplicate", "filed", "filed"]);

      const filed = await records();
      expect(
        filed
          .map((record) => [record.workspaceId, record.messageId])
          .toSorted((left, right) =>
            compareCodeUnit(left.join(":"), right.join(":")),
          ),
      ).toEqual(
        [
          [workspaceId, "1234567890"],
          [workspaceId, "1234567891"],
          [otherWorkspaceId, "1234567890"],
        ].toSorted((left, right) =>
          compareCodeUnit(left.join(":"), right.join(":")),
        ),
      );
      const original = filed.find(
        (record) =>
          record.workspaceId === workspaceId &&
          record.messageId === "1234567890",
      );
      if (original === undefined) {
        throw new Error("expected the first file's record");
      }
      expect(original.sourceEntityId).toBe(first);
      // The copy stored no second set of documents.
      expect(await attachmentsOf(original.id)).toHaveLength(2);
      expect(
        await fixtureScoped()(
          async (tx) =>
            await tx
              .select({ id: correspondenceFilers.id })
              .from(correspondenceFilers)
              .where(eq(correspondenceFilers.correspondenceId, original.id)),
        ),
      ).toHaveLength(1);
    });

    test("a replay after a failed document write resumes the missing files", async () => {
      const entityId = await storeZfoFile({ createdBy: uploaderId });
      const bytes = await zfoFile();
      const writes = { failAfter: 1, written: 0 };
      const failed = await processUpload({ entityId, bytes, writes });
      expect(failed.isErr()).toBe(true);
      const [record] = await records();
      if (record === undefined) {
        throw new Error("expected the partially filed record");
      }
      expect(await attachmentsOf(record.id)).toHaveLength(1);

      const replayed = await processUpload({ entityId, bytes });
      expect(replayed.isOk() && replayed.value.status).toBe("duplicate");
      expect(
        (await attachmentsOf(record.id)).map(({ ordinal }) => ordinal),
      ).toEqual([0, 1]);
    });

    test("a copy resumes missing ordinals across distinct exports of one message", async () => {
      const firstExport = await zfoFile();
      const secondExport = await sealContent(
        new TextEncoder().encode(messageXml().replaceAll("><", ">\n<")),
      );
      expect(sha256Hex(firstExport)).not.toBe(sha256Hex(secondExport));
      const first = await storeZfoFile({ createdBy: uploaderId });
      const copy = await storeZfoFile({ createdBy: uploaderId });
      const failed = await processUpload({
        entityId: first,
        bytes: firstExport,
        writes: { failAfter: 1, written: 0 },
      });
      expect(failed.isErr()).toBe(true);
      const [record] = await records();
      if (record === undefined) {
        throw new Error("expected the partially filed record");
      }
      expect(
        (await attachmentsOf(record.id)).map(({ ordinal }) => ordinal),
      ).toEqual([0]);

      const resumed = await processUpload({
        entityId: copy,
        bytes: secondExport,
      });
      expect(resumed.isOk() && resumed.value.status).toBe("duplicate");
      const replayedCopy = await processUpload({
        entityId: copy,
        bytes: secondExport,
      });
      expect(replayedCopy.isOk() && replayedCopy.value.status).toBe(
        "duplicate",
      );
      expect(
        (await attachmentsOf(record.id)).map(({ ordinal }) => ordinal),
      ).toEqual([0, 1]);
    });

    test("a copy resumes missing attachments after the initial source is deleted", async () => {
      const bytes = await zfoFile();
      const first = await storeZfoFile({ createdBy: uploaderId });
      const copy = await storeZfoFile({ createdBy: uploaderId });
      const writes = { failAfter: 1, written: 0 };
      const failed = await processUpload({ entityId: first, bytes, writes });
      expect(failed.isErr()).toBe(true);
      const copyPending = await processUpload({
        entityId: copy,
        bytes,
        writes: { failAfter: 0, written: 0 },
      });
      expect(copyPending.isErr()).toBe(true);
      await db.delete(entities).where(eq(entities.id, first));
      const resumed = await processUpload({ entityId: copy, bytes });
      expect(resumed.isOk() && resumed.value.status).toBe("duplicate");
      const [record] = await records();
      expect(record?.sourceEntityId).toBe(copy);
      if (record === undefined) {
        throw new TypeError("Expected surviving data-box correspondence");
      }
      expect(await attachmentsOf(record.id)).toHaveLength(
        FIXTURE_MESSAGE.files.length,
      );
    });

    test("an unreadable or rejected message files nothing", async () => {
      const unreadable = await storeZfoFile({ createdBy: uploaderId });
      const unreadableOutcome = await processUpload({
        entityId: unreadable,
        bytes: new TextEncoder().encode("<not a sealed message/>"),
      });
      expect(unreadableOutcome.isOk() && unreadableOutcome.value).toEqual({
        status: "skipped",
        reason: "data_box_not_signed_data",
      });

      const rejected = await storeZfoFile({ createdBy: uploaderId });
      const rejectedOutcome = await processUpload({
        entityId: rejected,
        bytes: await zfoFile(),
        scan: rejectingScan,
      });
      expect(rejectedOutcome.isOk() && rejectedOutcome.value).toEqual({
        status: "skipped",
        reason: "attachment_rejected",
      });
      expect(await records()).toEqual([]);
    });

    test("an uploader without matter access files nothing", async () => {
      const entityId = await storeZfoFile({ createdBy: outsiderId });
      const outcome = await processUpload({
        entityId,
        bytes: await zfoFile(),
      });
      expect(outcome.isOk() && outcome.value).toEqual({
        status: "skipped",
        reason: "no_matter_access",
      });
      expect(await records()).toEqual([]);
    });
  });
}
