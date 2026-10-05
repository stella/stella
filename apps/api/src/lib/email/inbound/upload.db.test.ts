import { Result } from "better-result";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { dkimSign } from "mailauth";
import { generateKeyPairSync } from "node:crypto";

import {
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
} from "@stll/api-contract/email-mime-types";
import { compareCodeUnit } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";

import { member, organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceFilers,
  entities,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
import { readCorrespondenceProvenance } from "@/api/lib/email/correspondence/provenance";
import {
  createOriginalSignatureVerifier,
  type verifyOriginalSignature,
} from "@/api/lib/email/inbound/authentication";
import {
  emlBytes,
  emlFile,
  GOLDEN_MESSAGE,
  msgFile,
} from "@/api/lib/email/inbound/email-file.test-fixture";
import { INBOUND_MAIL_LIMITS } from "@/api/lib/email/inbound/limits";
import {
  correspondenceFromMessage,
  parseEmailFile,
} from "@/api/lib/email/inbound/message";
import {
  fileUploadedMail,
  UploadedMailUnavailableError,
} from "@/api/lib/email/inbound/upload";
import { enqueueUploadedMailFiling } from "@/api/lib/email/inbound/upload-enqueue";
import { processUploadedMailJob } from "@/api/lib/email/inbound/upload-queue";
import { toArrayBuffer } from "@/api/lib/files/outlook-msg.test-fixture";
import {
  openGatedTestDatabase,
  type GatedTestDb,
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

const unverifiedOriginal: typeof verifyOriginalSignature = async () =>
  Result.ok({ status: "unverified" });

type StoreEmailFileOptions = {
  createdBy: SafeId<"user">;
  fileWorkspaceId?: SafeId<"workspace">;
};

const storeEmailFile = async ({
  createdBy,
  fileWorkspaceId = workspaceId,
}: StoreEmailFileOptions) => {
  const entityId = createSafeId<"entity">();
  await db.insert(entities).values({
    id: entityId,
    workspaceId: fileWorkspaceId,
    name: "letter.eml",
    createdBy,
  });
  return entityId;
};

type ProcessUploadOptions = {
  entityId: SafeId<"entity">;
  bytes: ArrayBuffer;
  mimeType?: string;
  verifyOriginal?: typeof verifyOriginalSignature;
};

const processUpload = async ({
  entityId,
  bytes,
  mimeType = EML_MIME_TYPE,
  verifyOriginal = unverifiedOriginal,
}: ProcessUploadOptions) =>
  await fileUploadedMail({
    bytes,
    mimeType,
    scope: { organizationId, workspaceId, entityId },
    database: db,
    scopedDbForUploader: (scope) =>
      createScopedDb(
        markRlsDatabase(db),
        [scope.workspaceId],
        scope.organizationId,
        scope.userId,
      ),
    verifyOriginal,
  });

const records = async () =>
  await db
    .select()
    .from(correspondence)
    .where(eq(correspondence.organizationId, organizationId));
const filers = async () =>
  await db
    .select()
    .from(correspondenceFilers)
    .where(eq(correspondenceFilers.organizationId, organizationId));

const causeChainText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
};

const signedEml = async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const raw = Buffer.from(emlBytes(GOLDEN_MESSAGE));
  const signed = await dkimSign(raw, {
    signTime: "2026-06-02T10:00:00.000Z",
    signatureData: [
      {
        signingDomain: "example.com",
        selector: "case",
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
      },
    ],
  });
  expect(signed.errors).toEqual([]);
  const publicKeyRecord = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const verifyOriginal = createOriginalSignatureVerifier(() => ({
    resolve: async (domain: string, rrtype: string) =>
      domain === "case._domainkey.example.com" && rrtype === "TXT"
        ? [[`v=DKIM1; k=rsa; p=${publicKeyRecord}`]]
        : [],
    cancel: () => {},
  }));
  return {
    bytes: Buffer.concat([Buffer.from(signed.signatures), raw]),
    verifyOriginal,
  };
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("uploaded email files filed as correspondence", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("uploaded email files filed as correspondence", () => {
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
          email: "Uploader@Example.test",
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
        name: "Uploaded mail",
        slug: `uploaded-mail-${organizationId}`,
        createdAt: new Date(),
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
          reference: "UPLOAD-1",
        },
        {
          id: otherWorkspaceId,
          organizationId,
          name: "Other matter",
          reference: "UPLOAD-2",
        },
      ]);
      await db.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId,
        userId: uploaderId,
      });
    }, 60_000);

    beforeEach(async () => {
      await db
        .delete(correspondence)
        .where(eq(correspondence.organizationId, organizationId));
      await db.delete(entities).where(eq(entities.workspaceId, workspaceId));
      await db
        .delete(entities)
        .where(eq(entities.workspaceId, otherWorkspaceId));
    });

    test("an uploaded .eml is one record linked to its file, with no copied attachments", async () => {
      const entityId = await storeEmailFile({ createdBy: uploaderId });
      const outcome = await processUpload({
        entityId,
        bytes: emlFile(GOLDEN_MESSAGE),
      });
      expect(outcome.isOk() && outcome.value.status).toBe("filed");

      const [record, ...others] = await records();
      expect(others).toHaveLength(0);
      expect(record).toMatchObject({
        workspaceId,
        source: "upload",
        sourceEntityId: entityId,
        intake: null,
        authenticatedSenderAddress: null,
        spf: null,
        dkim: null,
        dmarc: null,
        alignedIdentifier: null,
        originalSignature: { status: "unverified" },
        direction: "in",
        subject: "Settlement offer",
        from: { address: "jane.lawyer@example.com", name: null },
        to: [{ address: "client@example.org", name: null }],
        cc: [{ address: "copy@example.org", name: null }],
        messageId: "<offer@example.com>",
        inReplyTo: "<request@example.org>",
        bodyText: "Please find the offer attached.",
      });
      if (record === undefined) {
        throw new Error("expected the uploaded record");
      }
      expect(record.sentAt?.toISOString()).toBe("2026-06-02T10:00:00.000Z");
      expect(readCorrespondenceProvenance(record)).toEqual({
        source: "upload",
        sourceEntityId: entityId,
        originalSignature: { status: "unverified" },
      });
      expect(await filers()).toMatchObject([
        {
          correspondenceId: record.id,
          filedByUserId: uploaderId,
          filedByAllowedSenderId: null,
          filedByDisplay: {
            status: "active",
            name: "Uploader",
            email: "Uploader@Example.test",
          },
        },
      ]);
      expect(
        await db
          .select({ id: correspondenceAttachments.id })
          .from(correspondenceAttachments)
          .where(eq(correspondenceAttachments.correspondenceId, record.id)),
      ).toHaveLength(0);

      // The uploader reads the record through the matter's row policies, and
      // the file itself stays in the matter.
      const visible = await createScopedDb(
        markRlsDatabase(db),
        [workspaceId],
        organizationId,
        uploaderId,
      )(
        async (tx) =>
          await tx
            .select({ id: correspondence.id })
            .from(correspondence)
            .where(eq(correspondence.workspaceId, workspaceId)),
      );
      expect(visible).toEqual([{ id: record.id }]);
      expect(
        await db
          .select({ id: entities.id })
          .from(entities)
          .where(eq(entities.id, entityId)),
      ).toEqual([{ id: entityId }]);
    });

    test("a replayed upload converges on the file's one record and filer", async () => {
      const entityId = await storeEmailFile({ createdBy: uploaderId });
      const first = await processUpload({
        entityId,
        bytes: emlFile(GOLDEN_MESSAGE),
      });
      if (first.isErr() || first.value.status !== "filed") {
        throw new Error("expected the first run to file the record");
      }
      for (let replay = 0; replay < 2; replay += 1) {
        const again = await processUpload({
          entityId,
          bytes: emlFile(GOLDEN_MESSAGE),
        });
        expect(again.isOk() && again.value).toEqual({
          status: "duplicate",
          correspondenceId: first.value.correspondenceId,
        });
      }
      expect(await records()).toHaveLength(1);
      expect(await filers()).toHaveLength(1);
    });

    test("a delivered message and an uploaded file of it stay separate records", async () => {
      const parsed = await parseEmailFile({
        bytes: emlFile(GOLDEN_MESSAGE),
        format: "eml",
      });
      if (parsed.isErr() || parsed.value.from === null) {
        throw new Error("expected the fixture to parse with a sender");
      }
      const delivered = await createCorrespondence({
        safeDb: safeDbFromScoped(
          createScopedDb(
            markRlsDatabase(db),
            [workspaceId],
            organizationId,
            uploaderId,
          ),
        ),
        workspaceId,
        organizationId,
        filer: { type: "user", userId: uploaderId },
        parsed: correspondenceFromMessage({
          message: { ...parsed.value, from: parsed.value.from },
          provenance: {
            source: "delivery",
            intake: "direct",
            originalSignature: null,
            authenticatedSender: {
              address: "uploader@example.test",
              spf: "pass",
              dkim: "none",
              dmarc: "pass",
              alignedIdentifier: "example.test",
            },
          } as const,
          sender: "uploader@example.test",
          receivedAt: "2026-06-02T10:05:00.000Z",
        }),
        attachments: [],
        recordAuditEvent: async () => {},
      });
      expect(delivered.type).toBe("ok");

      const entityId = await storeEmailFile({ createdBy: uploaderId });
      const uploaded = await processUpload({
        entityId,
        bytes: emlFile(GOLDEN_MESSAGE),
      });
      expect(uploaded.isOk() && uploaded.value.status).toBe("filed");
      const stored = await records();
      expect(stored.map(({ source }) => source).toSorted()).toEqual([
        "delivery",
        "upload",
      ]);
      expect(new Set(stored.map(({ contentHash }) => contentHash)).size).toBe(
        1,
      );
    });

    test("two copies of one email file keep a record each", async () => {
      // Each copy is its own item in Files and owns its record, so deleting
      // one copy never removes the other's.
      const first = await storeEmailFile({ createdBy: uploaderId });
      const second = await storeEmailFile({ createdBy: uploaderId });
      for (const entityId of [first, second]) {
        const outcome = await processUpload({
          entityId,
          bytes: emlFile(GOLDEN_MESSAGE),
        });
        expect(outcome.isOk() && outcome.value.status).toBe("filed");
      }
      const stored = await records();
      expect(
        stored
          .map(({ sourceEntityId }) => sourceEntityId)
          .toSorted((left, right) => compareCodeUnit(left ?? "", right ?? "")),
      ).toEqual([first, second].toSorted(compareCodeUnit));
      expect(new Set(stored.map(({ dedupKey }) => dedupKey)).size).toBe(2);
    });

    test("an uploader's own message is filed as outgoing", async () => {
      const entityId = await storeEmailFile({ createdBy: uploaderId });
      const outcome = await processUpload({
        entityId,
        bytes: emlFile({ ...GOLDEN_MESSAGE, from: "uploader@example.test" }),
      });
      expect(outcome.isOk() && outcome.value.status).toBe("filed");
      expect(await records()).toMatchObject([{ direction: "out" }]);
    });

    test("an Outlook file yields the same record fields as its RFC 5322 twin", async () => {
      const emlEntity = await storeEmailFile({ createdBy: uploaderId });
      const msgEntity = await storeEmailFile({ createdBy: uploaderId });
      await processUpload({
        entityId: emlEntity,
        bytes: emlFile(GOLDEN_MESSAGE),
      });
      const msgOutcome = await processUpload({
        entityId: msgEntity,
        bytes: msgFile(GOLDEN_MESSAGE),
        mimeType: MSG_MIME_TYPE,
      });
      expect(msgOutcome.isOk() && msgOutcome.value.status).toBe("filed");
      const content = (sourceEntityId: SafeId<"entity">) =>
        db
          .select({
            direction: correspondence.direction,
            subject: correspondence.subject,
            from: correspondence.from,
            to: correspondence.to,
            cc: correspondence.cc,
            sentAt: correspondence.sentAt,
            messageId: correspondence.messageId,
            inReplyTo: correspondence.inReplyTo,
            references: correspondence.references,
            bodyText: correspondence.bodyText,
            bodyHtml: correspondence.bodyHtml,
            contentHash: correspondence.contentHash,
            originalSignature: correspondence.originalSignature,
          })
          .from(correspondence)
          .where(
            and(
              eq(correspondence.workspaceId, workspaceId),
              eq(correspondence.sourceEntityId, sourceEntityId),
            ),
          );
      const [emlRecord] = await content(emlEntity);
      const [msgRecord] = await content(msgEntity);
      expect(emlRecord).toBeDefined();
      expect(msgRecord).toEqual(emlRecord);
    });

    test("a DKIM signature over the uploaded bytes is recorded as verified", async () => {
      const { bytes, verifyOriginal } = await signedEml();
      const signedEntity = await storeEmailFile({ createdBy: uploaderId });
      await processUpload({
        entityId: signedEntity,
        bytes: toArrayBuffer(bytes),
        verifyOriginal,
      });
      const tamperedEntity = await storeEmailFile({ createdBy: uploaderId });
      await processUpload({
        entityId: tamperedEntity,
        bytes: toArrayBuffer(
          Buffer.from(
            bytes
              .toString("utf-8")
              .replace("Please find the offer", "Please ignore the offer"),
          ),
        ),
        verifyOriginal,
      });
      const signatures = new Map(
        (await records()).map(({ sourceEntityId, originalSignature }) => [
          sourceEntityId,
          originalSignature,
        ]),
      );
      expect(signatures.get(signedEntity)).toEqual({
        status: "verified",
        domain: "example.com",
      });
      expect(signatures.get(tamperedEntity)).toEqual({ status: "unverified" });
    });

    test("an Outlook file is always unverified", async () => {
      const entityId = await storeEmailFile({ createdBy: uploaderId });
      const verifyOriginal: typeof verifyOriginalSignature = async () =>
        Result.ok({ status: "verified", domain: "example.com" });
      await processUpload({
        entityId,
        bytes: msgFile(GOLDEN_MESSAGE),
        mimeType: MSG_MIME_TYPE,
        verifyOriginal,
      });
      expect(await records()).toMatchObject([
        { originalSignature: { status: "unverified" } },
      ]);
    });

    test("an uploader without matter access files nothing", async () => {
      const entityId = await storeEmailFile({ createdBy: outsiderId });
      const outcome = await processUpload({
        entityId,
        bytes: emlFile(GOLDEN_MESSAGE),
      });
      expect(outcome.isOk() && outcome.value).toEqual({
        status: "skipped",
        reason: "no_matter_access",
      });
      expect(await records()).toHaveLength(0);
      expect(await filers()).toHaveLength(0);
    });

    test("a transient failure is retried by the job and converges on one record", async () => {
      const entityId = await storeEmailFile({ createdBy: uploaderId });
      const scopedDbForUploader: Parameters<
        typeof fileUploadedMail
      >[0]["scopedDbForUploader"] = (scope) =>
        createScopedDb(
          markRlsDatabase(db),
          [scope.workspaceId],
          scope.organizationId,
          scope.userId,
        );
      const queued: Parameters<typeof processUploadedMailJob>[0]["data"][] = [];
      await enqueueUploadedMailFiling({
        file: {
          sourceFileId: "file_1",
          storageMimeType: EML_MIME_TYPE,
          mimeType: EML_MIME_TYPE,
        },
        scope: { organizationId, workspaceId, entityId },
        queue: {
          add: async (_name, data) => {
            queued.push(data);
          },
          getJob: async () => undefined,
        },
      });
      const [job] = queued;
      if (job === undefined) {
        throw new Error("expected a filing job");
      }
      const attempt = async (
        uploaderDb: NonNullable<typeof scopedDbForUploader>,
      ) =>
        await processUploadedMailJob({
          data: job,
          database: db,
          readFile: async () =>
            testScannedFile({
              bytes: emlFile(GOLDEN_MESSAGE),
              mimeType: EML_MIME_TYPE,
            }),
          fileMail: async (options) =>
            await fileUploadedMail({
              ...options,
              scopedDbForUploader: uploaderDb,
              verifyOriginal: unverifiedOriginal,
            }),
        });

      expect(
        await rejectionOf(
          attempt(() => async () => {
            throw new Error("connection reset");
          }),
        ),
      ).toBeInstanceOf(UploadedMailUnavailableError);
      expect(await records()).toHaveLength(0);

      const retry = async () => await attempt(scopedDbForUploader);
      expect(await retry()).toMatchObject({ status: "filed" });
      expect(await retry()).toMatchObject({ status: "duplicate" });
      expect(await records()).toMatchObject([
        { source: "upload", sourceEntityId: entityId },
      ]);
      expect(await filers()).toHaveLength(1);
    });

    test("an uploaded file with a blocked attachment type is still filed", async () => {
      const entityId = await storeEmailFile({ createdBy: uploaderId });
      const outcome = await processUpload({
        entityId,
        bytes: emlFile({
          ...GOLDEN_MESSAGE,
          attachments: [
            {
              fileName: "invoice.html",
              mimeType: "text/html",
              bytes: new TextEncoder().encode("<p>Invoice</p>"),
            },
          ],
        }),
      });
      expect(outcome.isOk() && outcome.value.status).toBe("filed");
      expect(await records()).toHaveLength(1);
    });

    test("deleting the file deletes its record", async () => {
      const entityId = await storeEmailFile({ createdBy: uploaderId });
      await processUpload({ entityId, bytes: emlFile(GOLDEN_MESSAGE) });
      expect(await records()).toHaveLength(1);

      await db.delete(entities).where(eq(entities.id, entityId));

      expect(await records()).toHaveLength(0);
      expect(await filers()).toHaveLength(0);
    });

    test.each([
      [
        "an unreadable Outlook container",
        new TextEncoder().encode("not a compound file"),
        MSG_MIME_TYPE,
        "malformed_message",
      ],
      [
        "an RFC 5322 file with two From headers",
        new TextEncoder().encode(
          "From: a@example.com\r\nFrom: b@example.com\r\nSubject: x\r\n\r\nBody",
        ),
        EML_MIME_TYPE,
        "malformed_message",
      ],
      [
        "an RFC 5322 file without a sender",
        new TextEncoder().encode("Subject: Draft\r\n\r\nBody"),
        EML_MIME_TYPE,
        "no_sender",
      ],
      [
        "an RFC 5322 file above the inbound size limit",
        new Uint8Array(INBOUND_MAIL_LIMITS.rawBytes + 1),
        EML_MIME_TYPE,
        "message_too_large",
      ],
    ] as const)(
      "%s files nothing and leaves the file in place",
      async (_label, bytes, mimeType, reason) => {
        const entityId = await storeEmailFile({ createdBy: uploaderId });
        const outcome = await processUpload({
          entityId,
          bytes: toArrayBuffer(bytes),
          mimeType,
        });
        expect(outcome.isOk() && outcome.value).toEqual({
          status: "skipped",
          reason,
        });
        expect(await records()).toHaveLength(0);
        expect(
          await db
            .select({ id: entities.id })
            .from(entities)
            .where(eq(entities.id, entityId)),
        ).toHaveLength(1);
      },
    );

    test("an email file attached to a delivered record is not filed again", async () => {
      const entityId = await storeEmailFile({ createdBy: uploaderId });
      const deliveredId = createSafeId<"correspondence">();
      await db.insert(correspondence).values({
        id: deliveredId,
        organizationId,
        workspaceId,
        direction: "in",
        channel: "email",
        source: "delivery",
        intake: "direct",
        authenticatedSenderAddress: "uploader@example.test",
        originalSignature: null,
        contentHash: "a".repeat(64),
        dedupKey: "b".repeat(64),
        from: { address: "uploader@example.test", name: null },
        to: [],
        cc: [],
        subject: "Delivered",
        receivedAt: new Date(),
        references: [],
        bodyText: "Delivered",
        spf: "pass",
        dkim: "none",
        dmarc: "pass",
      });
      await db.insert(correspondenceAttachments).values({
        organizationId,
        workspaceId,
        correspondenceId: deliveredId,
        entityId,
        ordinal: 0,
        filename: "letter.eml",
        mediaType: EML_MIME_TYPE,
        byteSize: 1,
        scanVerdict: "clean",
      });
      const outcome = await processUpload({
        entityId,
        bytes: emlFile(GOLDEN_MESSAGE),
      });
      expect(outcome.isOk() && outcome.value).toEqual({
        status: "skipped",
        reason: "correspondence_attachment",
      });
      expect(await records()).toHaveLength(1);
    });

    const recordRow = () => ({
      id: createSafeId<"correspondence">(),
      organizationId,
      workspaceId,
      direction: "in" as const,
      channel: "email" as const,
      contentHash: "a".repeat(64),
      dedupKey: Bun.randomUUIDv7().replaceAll("-", "").repeat(2),
      from: { address: "sender@example.test", name: null },
      to: [],
      cc: [],
      subject: "Constraint",
      receivedAt: new Date(),
      references: [],
      bodyText: "Constraint",
    });
    const deliveryAuthentication = {
      intake: "direct" as const,
      authenticatedSenderAddress: "sender@example.test",
      originalSignature: null,
      spf: "pass" as const,
      dkim: "none" as const,
      dmarc: "pass" as const,
    };
    const uploadProvenance = (sourceEntityId: SafeId<"entity"> | null) => ({
      source: "upload" as const,
      sourceEntityId,
      originalSignature: { status: "unverified" as const },
    });

    test.each([
      [
        "a delivery without transport authentication",
        () => ({
          source: "delivery" as const,
          intake: "direct" as const,
          originalSignature: null,
        }),
        "correspondence_provenance_check",
      ],
      [
        "a delivery naming a source file",
        (entityId: SafeId<"entity">) => ({
          source: "delivery" as const,
          ...deliveryAuthentication,
          sourceEntityId: entityId,
        }),
        "correspondence_provenance_check",
      ],
      [
        "an upload without its file",
        () => uploadProvenance(null),
        "correspondence_provenance_check",
      ],
      [
        "an upload carrying transport authentication",
        (entityId: SafeId<"entity">) => ({
          ...uploadProvenance(entityId),
          spf: "pass" as const,
          dkim: "none" as const,
          dmarc: "pass" as const,
        }),
        "correspondence_provenance_check",
      ],
      [
        "an upload with a delivery intake",
        (entityId: SafeId<"entity">) => ({
          ...uploadProvenance(entityId),
          intake: "direct" as const,
        }),
        "correspondence_provenance_check",
      ],
      [
        "an upload without signature provenance",
        (entityId: SafeId<"entity">) => ({
          ...uploadProvenance(entityId),
          originalSignature: null,
        }),
        "correspondence_original_signature_check",
      ],
    ] as const)(
      "the schema refuses %s",
      async (_label, provenance, constraint) => {
        const entityId = await storeEmailFile({ createdBy: uploaderId });
        const written = await Result.tryPromise(
          async () =>
            await db
              .insert(correspondence)
              .values({ ...recordRow(), ...provenance(entityId) }),
        );
        expect(Result.isError(written)).toBe(true);
        expect(
          causeChainText(Result.isError(written) ? written.error : null),
        ).toContain(constraint);
      },
    );

    test("the schema refuses a second record for one file and a file from another matter", async () => {
      const entityId = await storeEmailFile({ createdBy: uploaderId });
      await db
        .insert(correspondence)
        .values({ ...recordRow(), ...uploadProvenance(entityId) });
      const duplicate = await Result.tryPromise(
        async () =>
          await db
            .insert(correspondence)
            .values({ ...recordRow(), ...uploadProvenance(entityId) }),
      );
      expect(
        causeChainText(Result.isError(duplicate) ? duplicate.error : null),
      ).toContain("correspondence_ws_source_entity_uidx");

      const foreignEntityId = await storeEmailFile({
        createdBy: uploaderId,
        fileWorkspaceId: otherWorkspaceId,
      });
      const foreign = await Result.tryPromise(
        async () =>
          await db
            .insert(correspondence)
            .values({ ...recordRow(), ...uploadProvenance(foreignEntityId) }),
      );
      expect(
        causeChainText(Result.isError(foreign) ? foreign.error : null),
      ).toContain("correspondence_source_entity_workspace_fk");
    });
  });
}
