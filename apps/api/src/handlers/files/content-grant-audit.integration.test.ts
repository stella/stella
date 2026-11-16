import { PDF } from "@libpdf/core";
import { Result } from "better-result";
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

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import { ZipArchive } from "@stll/docx-core/zip";
import { rejectionOf } from "@stll/property-testing/rejection";

import { session } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  auditLogs,
  entities,
  entityVersions,
  fields,
  properties,
  syntheticSessionControl,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { readDocumentProperties } from "@/api/handlers/files/document-properties";
import emailAttachmentEndpoint from "@/api/handlers/files/email-attachment";
import {
  printPdfHandler,
  readEmailHtmlPreviewHandler,
  stampedDownloadHandler,
} from "@/api/handlers/files/get";
import { readMarkedDownload } from "@/api/handlers/files/marked-download";
import { readScrubbedDownload } from "@/api/handlers/files/scrubbed-download";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "@/api/lib/desktop-edit-file-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createEmailAttachmentDescriptor } from "@/api/lib/files/email-attachment-token";
import { readFileHandler } from "@/api/lib/files/read-file";
import { createFileKey } from "@/api/lib/files/utils";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  SYNTHETIC_PRINCIPAL,
  SYNTHETIC_SESSION_CONTROL_ID,
} from "@/api/lib/synthetic-principal/constants";
import { readSyntheticSessionAuthority } from "@/api/lib/synthetic-principal/session-authority";
import { createSyntheticSessionStore } from "@/api/lib/synthetic-principal/store";
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
const seededWorkspaceIds: SafeId<"workspace">[] = [];

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
  if (seededWorkspaceIds.length > 0) {
    await testDb
      .delete(properties)
      .where(inArray(properties.workspaceId, seededWorkspaceIds));
    await testDb
      .delete(workspaceMembers)
      .where(inArray(workspaceMembers.workspaceId, seededWorkspaceIds));
    await testDb
      .delete(workspaces)
      .where(inArray(workspaces.id, seededWorkspaceIds));
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
  expect(response).toBeInstanceOf(HttpStatusResponse);
  if (response instanceof HttpStatusResponse) {
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
    readSessionAuthority: async () => null,
    source: { kind: "request", sessionId: "fixture-session" },
    scopedDb: scopedDbA(),
    fieldId,
    userId: ids.userA1,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    purpose,
    recordAuditEvent,
  });

const setupDedicatedDownload = async () => {
  const store = createSyntheticSessionStore(asTestRaw(testDb));
  await store.revokeSyntheticSessions();
  await testDb
    .insert(syntheticSessionControl)
    .values({ id: SYNTHETIC_SESSION_CONTROL_ID, status: "enabled" })
    .onConflictDoUpdate({
      target: syntheticSessionControl.id,
      set: { status: "enabled" },
    });
  await store.mintSyntheticSession({
    keyLabel: "file-download-fixture",
    requestId: undefined,
    userAgent: null,
  });
  const [source] = await testDb
    .select({ id: session.id })
    .from(session)
    .where(eq(session.userId, SYNTHETIC_PRINCIPAL.user.id));
  expect(source).toBeDefined();
  if (!source) {
    throw new Error("Dedicated session fixture was not created");
  }

  const organizationId = brandPersistedOrganizationId(
    SYNTHETIC_PRINCIPAL.org.id,
  );
  const userId = brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id);
  const workspaceId = createSafeId<"workspace">();
  seededWorkspaceIds.push(workspaceId);
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Dedicated principal fixture",
    reference: workspaceId,
  });
  await testDb.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
  const propertyId = createSafeId<"property">();
  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "File",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const fileId = createSafeId<"userFile">();
  seededEntityIds.push(entityId);
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: "Dedicated download.pdf",
  });
  await testDb.insert(entityVersions).values({
    id: entityVersionId,
    workspaceId,
    entityId,
  });
  await testDb.insert(fields).values({
    id: fieldId,
    workspaceId,
    propertyId,
    entityVersionId,
    content: {
      version: 1,
      type: "file",
      id: fileId,
      fileName: "dedicated-download.pdf",
      mimeType: PDF_MIME_TYPE,
      sizeBytes: 2048,
      encrypted: false,
      sha256Hex: "d".repeat(64),
      pdfFileId: null,
    },
  });
  fake.put(
    envBase.S3_BUCKET,
    createFileKey({
      organizationId,
      workspaceId,
      fileId,
      mimeType: PDF_MIME_TYPE,
    }),
    new Uint8Array([37, 80, 68, 70]),
    PDF_MIME_TYPE,
  );

  const scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [workspaceId], organizationId, userId),
  );
  const recordAuditEvent = createAuditRecorder({
    organizationId,
    workspaceId,
    userId,
    request: new Request("https://api.example.test/files"),
    server: null,
  });
  const download = async () => {
    const authority = await readSyntheticSessionAuthority(testDb, {
      sessionId: source.id,
      userId,
    });
    return await readFileHandler({
      readSessionAuthority: async ({ sessionId, userId: authorityUserId }) =>
        sessionId === source.id && authorityUserId === userId
          ? authority
          : null,
      source: { kind: "request", sessionId: source.id },
      scopedDb,
      fieldId,
      userId,
      organizationId,
      workspaceId,
      purpose: "download",
      recordAuditEvent,
    });
  };

  return { download, store };
};

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
  test("a dedicated principal receives a session-bound signed URL", async () => {
    const { download } = await setupDedicatedDownload();

    const response = await download();

    expect(response).toHaveProperty("presignedUrl");
    if (!("presignedUrl" in response)) {
      return;
    }
    expect(
      Number(new URL(response.presignedUrl).searchParams.get("X-Amz-Expires")),
    ).toBeLessThanOrEqual(60);
  });

  test("a revoked dedicated session is refused a signed URL", async () => {
    const { download, store } = await setupDedicatedDownload();
    await store.revokeSyntheticSessions();

    expect(await rejectionOf(download())).toMatchObject({
      status: 403,
      code: "account_access_unavailable",
    });
  });

  test.each(URL_CASES)(
    "$name commits one $action row bound to the actor, matter and document",
    async ({ purpose, stored, deliveredMimeType, action, disposition }) => {
      const seeded = await seedFile(stored);
      const deliveredKey = fileKeyFor(
        stored.pdfFileId ?? seeded.fileId,
        deliveredMimeType,
      );

      const response = await readUrl(seeded.fieldId, purpose);

      const requestedLifetime =
        "presignedUrl" in response
          ? Number(
              new URL(response.presignedUrl).searchParams.get("X-Amz-Expires"),
            )
          : null;
      expect(response).toMatchObject({
        mimeType: deliveredMimeType,
        presignedUrl: expect.stringContaining(deliveredKey),
      });
      expect(requestedLifetime).toBe(15 * 60);
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
  scopedDb = scopedDbA(),
}: {
  seeded: SeededFile;
  disposition: "inline" | "download";
  recordAuditEvent: AuditRecorder;
  scopedDb?: ScopedDb;
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
      route:
        "/v1/files/:workspaceId/email-attachment/:fieldId/:attachmentId" satisfies ApiRoutePath,
      scopedDb,
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

// Streamed deliveries read or derive the bytes outside any lock and record the
// delivery afterwards. A version tombstoned in between must answer as a
// missing file and leave no row, the same refusal a link for a tombstoned
// version gets.

/**
 * Matter A's scoped database, tombstoning `entityVersionId` once the first
 * transaction (the handler's lookup) has committed: the withdrawal lands
 * while the handler reads and transforms the bytes.
 */
const withdrawnAfterLookup = (entityVersionId: SafeId<"entityVersion">) => {
  const scopedDb = scopedDbA();
  let transactions = 0;
  return asTestRaw<ScopedDb>(async (fn: Parameters<ScopedDb>[0]) => {
    const result = await scopedDb(fn);
    transactions += 1;
    if (transactions === 1) {
      await testDb
        .update(entityVersions)
        .set({ deletedAt: new Date("2026-02-01T00:00:00.000Z") })
        .where(eq(entityVersions.id, entityVersionId));
    }
    return result;
  });
};

const docxBytes = async () => {
  const zip = new ZipArchive();
  zip.set(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      `<Override PartName="/${DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mainPartPath}" ContentType="${DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mainPartContentType}"/>`,
      "</Types>",
    ].join(""),
  );
  zip.set(
    DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mainPartPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      "<w:body><w:p><w:r><w:t>Smlouva</w:t></w:r></w:p><w:sectPr/></w:body>",
      "</w:document>",
    ].join(""),
  );
  return await zip.generate({ compression: "store" });
};

const pdfBytes = async () => {
  const pdf = PDF.create();
  pdf.addPage({ size: "a4" }).drawText("Rozsudek", { x: 72, y: 700, size: 12 });
  return await pdf.save();
};

const seedStored = async (stored: StoredFile, bytes: Uint8Array) => {
  const seeded = await seedFile(stored);
  fake.put(
    envBase.S3_BUCKET,
    fileKeyFor(seeded.fileId, stored.mimeType),
    bytes,
    stored.mimeType,
  );
  return seeded;
};

const seedStampableDocx = async () => {
  const seeded = await seedStored(
    { fileName: "smlouva.docx", mimeType: DOCX_MIME_TYPE, pdfFileId: null },
    await docxBytes(),
  );
  await testDb
    .update(entityVersions)
    .set({
      stamp: "2026/001/001.v1",
      verificationCode: Bun.randomUUIDv7().slice(-12),
    })
    .where(eq(entityVersions.id, seeded.entityVersionId));
  return seeded;
};

const seedPdf = async () =>
  await seedStored(
    { fileName: "rozsudek.pdf", mimeType: PDF_MIME_TYPE, pdfFileId: null },
    await pdfBytes(),
  );

type StreamedPath = {
  name: string;
  seed: () => Promise<SeededFile>;
  /** The HTTP status the path answered with. */
  read: (seeded: SeededFile, scopedDb: ScopedDb) => Promise<number>;
};

/** A plain object answer is the JSON body of a 200. */
const answeredStatus = (answer: unknown): number => {
  if (answer instanceof Response) {
    return answer.status;
  }
  if (answer instanceof HttpStatusResponse) {
    // `instanceof` cannot name the class's code parameter, so the narrowed
    // value reads it as the class's declared bound.
    const { code }: HttpStatusResponse = answer;
    return code;
  }
  return 200;
};

const STREAMED_PATHS: readonly StreamedPath[] = [
  {
    name: "an email preview",
    seed: seedEmail,
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await readEmailHtmlPreviewHandler({
          scopedDb,
          fieldId,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          recordAuditEvent: recorderA(),
        }),
      ),
  },
  {
    name: "an email attachment",
    seed: seedEmail,
    read: async (seeded, scopedDb) =>
      answeredStatus(
        await readAttachment({
          seeded,
          disposition: "download",
          recordAuditEvent: recorderA(),
          scopedDb,
        }),
      ),
  },
  {
    name: "a print PDF",
    seed: seedPdf,
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await printPdfHandler({
          scopedDb,
          fieldId,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          recordAuditEvent: recorderA(),
        }),
      ),
  },
  {
    name: "a marked PDF download",
    seed: seedPdf,
    read: async ({ fieldId }, scopedDb) => {
      const result = await Result.gen(async function* () {
        return yield* readMarkedDownload({
          fieldId,
          mode: "highlights",
          organizationId: ids.orgA,
          recordAuditEvent: recorderA(),
          requestSignal: new AbortController().signal,
          safeDb: asTestRaw<SafeDb>(
            createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
          ),
          scopedDb,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
      });
      if (Result.isError(result)) {
        return result.error instanceof HandlerError ? result.error.status : 500;
      }
      return answeredStatus(result.value);
    },
  },
  {
    name: "a stamped download",
    seed: seedStampableDocx,
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await stampedDownloadHandler({
          scopedDb,
          fieldId,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          recordAuditEvent: recorderA(),
          metadata: "keep",
        }),
      ),
  },
  {
    name: "a download without metadata",
    seed: seedPdf,
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await readScrubbedDownload({
          scopedDb,
          fieldId,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          recordAuditEvent: recorderA(),
        }),
      ),
  },
  {
    name: "a document properties read",
    seed: async () =>
      await seedStored(
        { fileName: "smlouva.docx", mimeType: DOCX_MIME_TYPE, pdfFileId: null },
        await docxBytes(),
      ),
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await readDocumentProperties({
          canUpdateEntity: false,
          scopedDb,
          fieldId,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          recordAuditEvent: recorderA(),
        }),
      ),
  },
];

describe("a version withdrawn while its bytes are prepared", () => {
  test.each(STREAMED_PATHS)(
    "$name of a live version commits one row",
    async ({ seed, read }) => {
      const seeded = await seed();

      expect(await read(seeded, scopedDbA())).toBe(200);
      expect(await auditRowsFor(seeded.entityId)).toHaveLength(1);
    },
  );

  test.each(STREAMED_PATHS)(
    "$name answers 404 and records nothing",
    async ({ seed, read }) => {
      const seeded = await seed();

      expect(
        await read(seeded, withdrawnAfterLookup(seeded.entityVersionId)),
      ).toBe(404);
      expect(await auditRowsFor(seeded.entityId)).toEqual([]);
    },
  );
});
