import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";

import type { ScopedDb } from "@/api/db/safe-db";
import { auditLogs, entities, entityVersions, fields } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import emailAttachmentEndpoint from "@/api/handlers/files/email-attachment";
import { readEmailHtmlPreviewHandler } from "@/api/handlers/files/get";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { createEmailAttachmentDescriptor } from "@/api/lib/files/email-attachment-token";
import { readFileHandler } from "@/api/lib/files/read-file";
import { createFileKey } from "@/api/lib/files/utils";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Every route that hands a caller stored file content commits one audit row
// bound to the actor, the matter and the document: an access for an inline
// view, a download for a saved copy. The rows are read back from the database
// the handlers wrote to.

const DOC_MIME_TYPE = "application/msword";

let testDb: TestDatabase;
let ids: TestIds;
let fake: FakeS3;
const seededEntityIds: SafeId<"entity">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (seededEntityIds.length > 0) {
    await testDb
      .delete(fields)
      .where(
        inArray(
          fields.entityVersionId,
          testDb
            .select({ id: entityVersions.id })
            .from(entityVersions)
            .where(inArray(entityVersions.entityId, seededEntityIds)),
        ),
      );
    await testDb
      .delete(entityVersions)
      .where(inArray(entityVersions.entityId, seededEntityIds));
    await testDb.delete(entities).where(inArray(entities.id, seededEntityIds));
  }
  await releaseRlsFixture();
});

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
});

type StoredFile = {
  fileName: string;
  mimeType: string;
  pdfFileId: string | null;
};

type SeededFile = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  fileId: string;
};

/** A document with one stored file in matter A1 (or B1 for `side: "b"`). */
const seedFile = async (
  { fileName, mimeType, pdfFileId }: StoredFile,
  side: "a" | "b" = "a",
): Promise<SeededFile> => {
  const workspaceId = side === "a" ? ids.wsA1 : ids.wsB1;
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const fileId = Bun.randomUUIDv7();
  seededEntityIds.push(entityId);
  await testDb
    .insert(entities)
    .values({ id: entityId, workspaceId, kind: "document", name: fileName });
  await testDb
    .insert(entityVersions)
    .values({ id: entityVersionId, workspaceId, entityId });
  await testDb.insert(fields).values({
    id: fieldId,
    workspaceId,
    propertyId: side === "a" ? ids.filePropertyA1 : ids.filePropertyB1,
    entityVersionId,
    content: {
      version: 1,
      type: "file",
      id: fileId,
      fileName,
      mimeType,
      sizeBytes: 2048,
      encrypted: false,
      sha256Hex: "b".repeat(64),
      pdfFileId,
    },
  });
  return { entityId, entityVersionId, fieldId, fileId };
};

const scopedDbA = (): ScopedDb =>
  asTestRaw<ScopedDb>(createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));

const recorderA = (): AuditRecorder =>
  createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    request: new Request("https://api.example.test/files"),
    server: null,
  });

const failingRecorder: AuditRecorder = async () =>
  await Promise.reject(new Error("audit store unavailable"));

// bun-types declares `.rejects.toThrow` as void; capture the rejection so
// type-aware lint and the runtime observe the same promise.
const rejectionMessage = async (
  promise: Promise<unknown>,
): Promise<string | null> =>
  await promise.then(
    () => null,
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );

const auditRowsFor = async (entityId: SafeId<"entity">) =>
  await testDb
    .select({
      action: auditLogs.action,
      metadata: auditLogs.metadata,
      organizationId: auditLogs.organizationId,
      resourceId: auditLogs.resourceId,
      resourceType: auditLogs.resourceType,
      userId: auditLogs.userId,
      workspaceId: auditLogs.workspaceId,
    })
    .from(auditLogs)
    .where(eq(auditLogs.resourceId, entityId));

type ExpectedRow = {
  action: "access" | "download";
  metadata: Record<string, unknown>;
};

const expectOneContentRow = async (
  entityId: SafeId<"entity">,
  { action, metadata }: ExpectedRow,
) => {
  expect(await auditRowsFor(entityId)).toEqual([
    {
      action,
      metadata: expect.objectContaining(metadata),
      organizationId: ids.orgA,
      resourceId: entityId,
      resourceType: "entity",
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    },
  ]);
};

const expectStatus = (response: unknown, code: number) => {
  expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
  if (response instanceof ElysiaCustomStatusResponse) {
    expect(response.code).toBe(code);
  }
};

const fileKeyFor = (fileId: string, mimeType: string) =>
  createFileKey({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    fileId,
    mimeType,
  });

const readUrl = async (
  fieldId: SafeId<"field">,
  purpose: "download" | "display" | "native-display",
  recordAuditEvent: AuditRecorder = recorderA(),
) =>
  await readFileHandler({
    scopedDb: scopedDbA(),
    fieldId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    purpose,
    recordAuditEvent,
  });

const URL_CASES = [
  {
    name: "a download",
    purpose: "download",
    stored: {
      fileName: "smlouva.docx",
      mimeType: DOCX_MIME_TYPE,
      pdfFileId: null,
    },
    deliveredMimeType: DOCX_MIME_TYPE,
    action: "download",
    disposition: "attachment",
  },
  {
    name: "a native display of the original",
    purpose: "native-display",
    stored: {
      fileName: "smlouva.docx",
      mimeType: DOCX_MIME_TYPE,
      pdfFileId: null,
    },
    deliveredMimeType: DOCX_MIME_TYPE,
    action: "access",
    disposition: "inline",
  },
  {
    name: "a display of an original PDF",
    purpose: "display",
    stored: {
      fileName: "rozsudek.pdf",
      mimeType: PDF_MIME_TYPE,
      pdfFileId: null,
    },
    deliveredMimeType: PDF_MIME_TYPE,
    action: "access",
    disposition: "inline",
  },
  {
    name: "a display of a converted PDF",
    purpose: "display",
    stored: {
      fileName: "plná moc.doc",
      mimeType: DOC_MIME_TYPE,
      pdfFileId: "derived-pdf",
    },
    deliveredMimeType: PDF_MIME_TYPE,
    action: "access",
    disposition: "inline",
  },
] as const;

describe("file URL grants", () => {
  test.each(URL_CASES)(
    "$name commits one $action row bound to the actor, matter and document",
    async ({ purpose, stored, deliveredMimeType, action, disposition }) => {
      const seeded = await seedFile(stored);
      const deliveredKey = fileKeyFor(
        stored.pdfFileId ?? seeded.fileId,
        deliveredMimeType,
      );

      const response = await readUrl(seeded.fieldId, purpose);

      expect(response).toMatchObject({
        mimeType: deliveredMimeType,
        presignedUrl: expect.stringContaining(deliveredKey),
      });
      await expectOneContentRow(seeded.entityId, {
        action,
        metadata: {
          disposition,
          fieldId: seeded.fieldId,
          mimeType: deliveredMimeType,
          purpose,
          s3Key: deliveredKey,
        },
      });
    },
  );

  test.each(URL_CASES)(
    "$name grants no URL when the audit row cannot be written",
    async ({ purpose, stored }) => {
      const seeded = await seedFile(stored);

      expect(
        await rejectionMessage(
          readUrl(seeded.fieldId, purpose, failingRecorder),
        ),
      ).toBe("audit store unavailable");
      expect(await auditRowsFor(seeded.entityId)).toEqual([]);
    },
  );

  test.each(["download", "display", "native-display"] as const)(
    "a %s request for another matter's field is not found and records nothing",
    async (purpose) => {
      const other = await seedFile(
        { fileName: "cizí.pdf", mimeType: PDF_MIME_TYPE, pdfFileId: null },
        "b",
      );

      expectStatus(await readUrl(other.fieldId, purpose), 404);
      expect(await auditRowsFor(other.entityId)).toEqual([]);
    },
  );

  test.each([
    {
      name: "a native display of a type the browser cannot render",
      purpose: "native-display",
      stored: {
        fileName: "plná moc.doc",
        mimeType: DOC_MIME_TYPE,
        pdfFileId: null,
      },
    },
    {
      name: "a display of a file with no PDF rendition",
      purpose: "display",
      stored: {
        fileName: "plná moc.doc",
        mimeType: DOC_MIME_TYPE,
        pdfFileId: null,
      },
    },
  ] as const)(
    "$name grants nothing and records nothing",
    async ({ purpose, stored }) => {
      const seeded = await seedFile(stored);

      expectStatus(await readUrl(seeded.fieldId, purpose), 400);
      expect(await auditRowsFor(seeded.entityId)).toEqual([]);
    },
  );
});

const EMAIL_WITH_ATTACHMENT = [
  "From: Jana Nováková <jana@example.test>",
  "To: kancelar@example.test",
  "Subject: =?UTF-8?Q?Smlouva_o_d=C3=ADlo?=",
  "Date: Thu, 01 Oct 2026 09:30:00 +0200",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="hranice"',
  "",
  "--hranice",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 8bit",
  "",
  "Dobrý den, v příloze posílám návrh smlouvy.",
  "--hranice",
  'Content-Type: text/plain; charset=utf-8; name="poznamky.txt"',
  'Content-Disposition: attachment; filename="poznamky.txt"',
  "Content-Transfer-Encoding: 8bit",
  "",
  "Lhůta: 15. 10. 2026",
  "--hranice--",
  "",
].join("\r\n");

const seedEmail = async () => {
  const seeded = await seedFile({
    fileName: "smlouva.eml",
    mimeType: EML_MIME_TYPE,
    pdfFileId: null,
  });
  fake.put(
    envBase.S3_BUCKET,
    fileKeyFor(seeded.fileId, EML_MIME_TYPE),
    new TextEncoder().encode(EMAIL_WITH_ATTACHMENT),
    EML_MIME_TYPE,
  );
  return seeded;
};

const previewEmail = async (
  fieldId: SafeId<"field">,
  recordAuditEvent: AuditRecorder = recorderA(),
) =>
  await readEmailHtmlPreviewHandler({
    scopedDb: scopedDbA(),
    fieldId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    recordAuditEvent,
  });

describe("email preview", () => {
  test("commits one access row bound to the actor, matter and document", async () => {
    const seeded = await seedEmail();

    const response = await previewEmail(seeded.fieldId);

    expect(response).toMatchObject({
      source: { entityId: seeded.entityId, fieldId: seeded.fieldId },
    });
    await expectOneContentRow(seeded.entityId, {
      action: "access",
      metadata: {
        disposition: "inline",
        fieldId: seeded.fieldId,
        format: "email-html",
        mimeType: EML_MIME_TYPE,
      },
    });
  });

  test("returns no preview when the audit row cannot be written", async () => {
    const seeded = await seedEmail();

    expect(
      await rejectionMessage(previewEmail(seeded.fieldId, failingRecorder)),
    ).toBe("audit store unavailable");
    expect(await auditRowsFor(seeded.entityId)).toEqual([]);
  });

  test("another matter's email is not found and records nothing", async () => {
    const other = await seedFile(
      { fileName: "cizí.eml", mimeType: EML_MIME_TYPE, pdfFileId: null },
      "b",
    );

    expectStatus(await previewEmail(other.fieldId), 404);
    expect(await auditRowsFor(other.entityId)).toEqual([]);
  });
});

type AttachmentContext = Parameters<typeof emailAttachmentEndpoint.handler>[0];

const readAttachment = async ({
  seeded,
  disposition,
  recordAuditEvent,
}: {
  seeded: SeededFile;
  disposition: "inline" | "download";
  recordAuditEvent: AuditRecorder;
}) =>
  await emailAttachmentEndpoint.handler(
    asTestRaw<AttachmentContext>({
      memberRole: sessionMemberRole("owner"),
      params: {
        attachmentId: createEmailAttachmentDescriptor({
          attachmentIndex: 0,
          secret: env.BETTER_AUTH_SECRET,
          sourceFileId: seeded.fileId,
          sourceVersionId: seeded.entityVersionId,
        }),
        fieldId: seeded.fieldId,
        workspaceId: ids.wsA1,
      },
      query: { disposition },
      recordAuditEvent,
      request: new Request("https://api.example.test/files/email-attachment"),
      route: "/files/:workspaceId/email-attachment/:fieldId/:attachmentId",
      scopedDb: scopedDbA(),
      safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      workspaceId: ids.wsA1,
    }),
  );

describe("email attachment", () => {
  test.each([
    ["inline", "access", "inline"],
    ["download", "download", "attachment"],
  ] as const)(
    "a %s read commits one %s row bound to the actor, matter and document",
    async (disposition, action, recorded) => {
      const seeded = await seedEmail();

      const response = await readAttachment({
        seeded,
        disposition,
        recordAuditEvent: recorderA(),
      });

      expect(response).toBeInstanceOf(Response);
      if (!(response instanceof Response)) {
        return;
      }
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Lhůta");
      await expectOneContentRow(seeded.entityId, {
        action,
        metadata: { disposition: recorded, fieldId: seeded.fieldId },
      });
    },
  );

  test.each(["inline", "download"] as const)(
    "a %s read returns no content when the audit row cannot be written",
    async (disposition) => {
      const seeded = await seedEmail();

      const response = await readAttachment({
        seeded,
        disposition,
        recordAuditEvent: failingRecorder,
      });

      const delivered = response instanceof Response && response.status === 200;
      expect(delivered).toBe(false);
      expect(await auditRowsFor(seeded.entityId)).toEqual([]);
    },
  );
});
