import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { DATA_BOX_MESSAGE_MIME_TYPE } from "@stll/api-contract/data-box";
import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import {
  ASIC_E_FILE_FORMAT,
  ASIC_S_FILE_FORMAT,
  CADES_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";
import { STRUCTURED_DOCUMENT_FORMATS } from "@stll/api-contract/structured-document-formats";
import { ZipArchive } from "@stll/docx-core/zip";
import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";
import { dbClock } from "@stll/test-kit/db";

import { session } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  auditLogs,
  correspondence,
  correspondenceAttachments,
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
import asicPreviewEndpoint from "@/api/handlers/files/asic";
import {
  cadesContentEndpoint,
  cadesPreviewEndpoint,
} from "@/api/handlers/files/cades";
import { readDocumentProperties } from "@/api/handlers/files/document-properties";
import emailAttachmentEndpoint from "@/api/handlers/files/email-attachment";
import {
  printPdfHandler,
  readEmailHtmlPreviewHandler,
  stampedDownloadHandler,
} from "@/api/handlers/files/get";
import { readMarkedDownload } from "@/api/handlers/files/marked-download";
import { readScrubbedDownload } from "@/api/handlers/files/scrubbed-download";
import {
  signatureContentEndpoint,
  signaturePreviewEndpoint,
} from "@/api/handlers/files/signature";
import structuredDocumentEndpoint from "@/api/handlers/files/structured-document";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "@/api/lib/desktop-edit-file-types";
import { dataBoxPayloadIdentity } from "@/api/lib/email/correspondence/data-box/payload-hash";
import { parseDataBoxMessage } from "@/api/lib/email/correspondence/data-box/zfo";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import { createEmailAttachmentDescriptor } from "@/api/lib/files/email-attachment-token";
import {
  checkFileContentGrant,
  FILE_CONTENT_GRANT_TTL_MS,
} from "@/api/lib/files/file-content-grant";
import { loadLegalFileSource } from "@/api/lib/files/legal-file-source";
import { readDataBoxFile } from "@/api/lib/files/read-data-box-file";
import {
  readFileContentHandler,
  readFileHandler,
} from "@/api/lib/files/read-file";
import { LEGAL_FILE_READERS } from "@/api/lib/files/read-legal-file";
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
import { makeAsicFixture } from "@/api/tests/fixtures/asic";
import { wrapP7m } from "@/api/tests/fixtures/p7m";
import {
  detachedCms,
  envelopingXades,
} from "@/api/tests/fixtures/signature-files";
import { FIXTURE_MESSAGE, zfoFile } from "@/api/tests/fixtures/zfo";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { withTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock, asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { asicPreviewScalingScenario } from "@/api/tests/read-scaling/asic-preview";
import {
  cadesContentScalingScenario,
  cadesPreviewScalingScenario,
} from "@/api/tests/read-scaling/cades-preview";
import { dataBoxPreviewScalingScenario } from "@/api/tests/read-scaling/data-box-preview";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  signatureContentScalingScenario,
  signaturePreviewScalingScenario,
} from "@/api/tests/read-scaling/signature-preview";
import { structuredDocumentScalingScenario } from "@/api/tests/read-scaling/structured-document";
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

const contentGrantFromUrl = (url: string): string =>
  decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");

/**
 * The wall clock the handlers stamp grants with, read from the database so
 * the test holds no ambient clock: floored for a bound taken before a grant is
 * issued, ceiled for one taken after.
 */
const databaseClockMs = async (bound: "before" | "after"): Promise<number> => {
  const epochMs =
    bound === "before"
      ? sql`floor(extract(epoch from clock_timestamp()) * 1000)`
      : sql`ceil(extract(epoch from clock_timestamp()) * 1000)`;
  const [row] = await testDb
    .select({ epochMs: sql<number>`(${epochMs})::float8`.mapWith(Number) })
    .from(sql`(SELECT 1) AS database_clock`);
  return row?.epochMs ?? panic("Database clock missing");
};

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
      .update(entities)
      .set({ currentVersionId: null })
      .where(inArray(entities.id, seededEntityIds));
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
  sha256Hex?: string;
  sizeBytes?: number;
};

type SeededFile = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  fileId: string;
};

/** A document with one stored file in matter A1 (or B1 for `side: "b"`). */
const seedFile = async (
  {
    fileName,
    mimeType,
    pdfFileId,
    sha256Hex: storedHash = "b".repeat(64),
    sizeBytes = 2048,
  }: StoredFile,
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
      sizeBytes,
      encrypted: false,
      sha256Hex: storedHash,
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
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
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
    const checkedAt = await databaseClockMs("after");

    expect(response).toHaveProperty("presignedUrl");
    if (!("presignedUrl" in response)) {
      return;
    }
    const checked = checkFileContentGrant({
      grant: contentGrantFromUrl(response.presignedUrl),
      now: checkedAt,
      secret: env.BETTER_AUTH_SECRET,
    });
    expect(checked).toMatchObject({ status: "valid" });
    if (checked.status === "valid") {
      expect(checked.grant.expiresAt - checkedAt).toBeLessThanOrEqual(60_000);
    }
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

      const requestedAt = await databaseClockMs("before");
      const response = await readUrl(seeded.fieldId, purpose);

      expect(response).toMatchObject({
        mimeType: deliveredMimeType,
      });
      expect(JSON.stringify(response)).not.toContain(deliveredKey);
      if (!("presignedUrl" in response)) {
        return;
      }
      const { presignedUrl } = response;
      expect(presignedUrl).toContain("/v1/file-content/fc1.");
      const checkedAt = await databaseClockMs("after");
      const checked = checkFileContentGrant({
        grant: contentGrantFromUrl(presignedUrl),
        now: checkedAt,
        secret: env.BETTER_AUTH_SECRET,
      });
      expect(checked).toMatchObject({ status: "valid" });
      if (checked.status === "valid") {
        expect(checked.grant.expiresAt).toBeGreaterThanOrEqual(
          requestedAt + FILE_CONTENT_GRANT_TTL_MS,
        );
        expect(checked.grant.expiresAt - checkedAt).toBeLessThanOrEqual(
          FILE_CONTENT_GRANT_TTL_MS,
        );
      }
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

  test("an issued grant cannot read retained bytes after its version is tombstoned", async () => {
    const seeded = await seedFile({
      fileName: "withdrawn.pdf",
      mimeType: PDF_MIME_TYPE,
      pdfFileId: null,
    });
    const key = fileKeyFor(seeded.fileId, PDF_MIME_TYPE);
    fake.put(
      envBase.S3_BUCKET,
      key,
      "retained legal-hold bytes",
      PDF_MIME_TYPE,
    );

    const issued = await readUrl(seeded.fieldId, "download");
    expect(issued).toMatchObject({
      presignedUrl: expect.stringContaining("/v1/file-content/fc1."),
    });
    await testDb
      .update(entityVersions)
      .set({ deletedAt: dbClock.now() })
      .where(eq(entityVersions.id, seeded.entityVersionId));

    const redeemed = await readFileContentHandler({
      abortSignal: new AbortController().signal,
      fieldId: seeded.fieldId,
      organizationId: ids.orgA,
      purpose: "download",
      scopedDb: scopedDbA(),
      workspaceId: ids.wsA1,
    });

    expectStatus(redeemed, 404);
    expect(fake.requests.filter((request) => request.method === "GET")).toEqual(
      [],
    );
  });

  test("redeems a live grant through stella without exposing the storage URL", async () => {
    const seeded = await seedFile({
      fileName: "live.pdf",
      mimeType: PDF_MIME_TYPE,
      pdfFileId: null,
    });
    const key = fileKeyFor(seeded.fileId, PDF_MIME_TYPE);
    fake.put(envBase.S3_BUCKET, key, "authorized bytes", PDF_MIME_TYPE);

    const issued = await readUrl(seeded.fieldId, "download");
    expect(JSON.stringify(issued)).not.toContain(key);
    const redeemed = await readFileContentHandler({
      abortSignal: new AbortController().signal,
      fieldId: seeded.fieldId,
      organizationId: ids.orgA,
      purpose: "download",
      scopedDb: scopedDbA(),
      workspaceId: ids.wsA1,
    });

    expect(redeemed).toBeInstanceOf(Response);
    if (!(redeemed instanceof Response)) {
      return;
    }
    expect(await redeemed.text()).toBe("authorized bytes");
    expect(redeemed.headers.get("Content-Disposition")).toContain(
      'attachment; filename="live.pdf"',
    );
    expect(
      fake.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(1);
  });

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

const seedDataBox = async () =>
  await seedStored(
    {
      fileName: "zprava.ZFO",
      mimeType: DATA_BOX_MESSAGE_MIME_TYPE,
      pdfFileId: null,
    },
    await zfoFile(),
  );

const seedCades = async (bytes?: Uint8Array) =>
  await seedStored(
    {
      fileName: "contratto.PDF.P7M",
      mimeType: CADES_FILE_FORMAT.mimeType,
      pdfFileId: null,
    },
    await wrapP7m(bytes ?? (await pdfBytes())),
  );

const legalFileContext = (
  fieldId: SafeId<"field">,
  scopedDb: ScopedDb,
  audit = recorderA(),
) =>
  createTestHandlerContext<Parameters<typeof cadesPreviewEndpoint.handler>[0]>({
    workspaceId: ids.wsA1,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    audit,
    scopedDb,
    safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    params: { workspaceId: ids.wsA1, fieldId },
  });

const seedAsic = async () =>
  await seedStored(
    { fileName: "toimik.BDOC", mimeType: "application/zip", pdfFileId: null },
    await makeAsicFixture({
      mimeType: ASIC_E_FILE_FORMAT.mimeType,
      members: [{ fileName: "lisa.txt", bytes: "Töölepingu lisa" }],
      signature: "xades",
    }),
  );

const UYAP_FIXTURE_TEXT = "İçtihat özeti";
const structuredFixtures = {
  uyap: {
    text: UYAP_FIXTURE_TEXT,
    bytes: async () => {
      const archive = new ZipArchive();
      archive.set(
        "content.xml",
        `<template format_id="1.8"><content><![CDATA[${UYAP_FIXTURE_TEXT}]]></content><elements><paragraph><content startOffset="0" length="${UYAP_FIXTURE_TEXT.length}"/></paragraph></elements></template>`,
      );
      return await archive.generate({ compression: "store" });
    },
  },
  ofd: {
    text: "你好呀，OFD Reader&Writer！",
    bytes: async () =>
      await Bun.file(
        new URL(
          "../../lib/files/fixtures/ofdrw/helloworld.ofd",
          import.meta.url,
        ),
      ).bytes(),
  },
};

describe.each(STRUCTURED_DOCUMENT_FORMATS)(
  "$label text delivery",
  ({ kind, label, auditFormat, extensions: [extension] }) => {
    // A generic ZIP MIME models an older upload recognized by its stored extension.
    const stored = {
      fileName: `record${extension.toUpperCase()}`,
      mimeType: "application/zip",
      pdfFileId: null,
    };
    const fixture = structuredFixtures[kind];
    const seed = async () => await seedStored(stored, await fixture.bytes());

    test("Files and the agent receive the same stored text and each read is audited", async () => {
      const { fieldId, entityId, entityVersionId } = await seed();
      await testDb
        .update(entities)
        .set({ currentVersionId: entityVersionId })
        .where(eq(entities.id, entityId));

      const preview = await structuredDocumentEndpoint.handler(
        legalFileContext(fieldId, scopedDbA()),
      );
      expect(preview).toEqual({ text: fixture.text, truncated: false });
      await expectOneContentRow(entityId, {
        action: "access",
        metadata: { fieldId, format: auditFormat, disposition: "inline" },
      });
      const agent = await LEGAL_FILE_READERS[kind]({
        fieldId,
        scopedDb: scopedDbA(),
        workspaceId: ids.wsA1,
        organizationId: ids.orgA,
        recordAuditEvent: recorderA(),
        purpose: "agent",
      });
      expect(agent.unwrap()).toEqual({
        text: fixture.text,
        attachments: [],
      });
      const rows = await auditRowsFor(entityId);
      expect(rows).toHaveLength(2);
      expect(rows.at(1)).toEqual(rows.at(0));
    });

    test("preview and agent reads cannot access another matter", async () => {
      const { fieldId, entityId } = await seedFile(stored, "b");
      expectStatus(
        await structuredDocumentEndpoint.handler(
          legalFileContext(fieldId, scopedDbA()),
        ),
        404,
      );
      const agent = await LEGAL_FILE_READERS[kind]({
        fieldId,
        scopedDb: scopedDbA(),
        workspaceId: ids.wsA1,
        organizationId: ids.orgA,
        recordAuditEvent: recorderA(),
        purpose: "agent",
      });
      expect(agent.isErr() && agent.error.status).toBe(404);
      expect(await auditRowsFor(entityId)).toEqual([]);
    });

    test("returns no text when its audit record fails", async () => {
      const { fieldId, entityId } = await seed();
      let auditAttempted = false;
      const rejectAudit: AuditRecorder = async (tx, event) => {
        auditAttempted = true;
        return await failingRecorder(tx, event);
      };
      expectStatus(
        await structuredDocumentEndpoint.handler(
          legalFileContext(fieldId, scopedDbA(), rejectAudit),
        ),
        500,
      );
      expect(auditAttempted).toBe(true);
      expect(await auditRowsFor(entityId)).toEqual([]);
    });

    test("discards parsed text when the source version is withdrawn", async () => {
      const { fieldId, entityId, entityVersionId } = await seed();
      expectStatus(
        await structuredDocumentEndpoint.handler(
          legalFileContext(fieldId, withdrawnAfterLookup(entityVersionId)),
        ),
        404,
      );
      expect(await auditRowsFor(entityId)).toEqual([]);
    });

    test(`${label} query cost stays bounded as the matter grows`, async () => {
      const { fieldId } = await seed();
      const context = legalFileContext(fieldId, scopedDbA());
      const measureWithAddedDocuments = async (count: number) => {
        const unrelated = Array.from({ length: count }, () => ({
          id: createSafeId<"entity">(),
          workspaceId: ids.wsA1,
          kind: "document" as const,
          name: "Docket entry",
        }));
        seededEntityIds.push(...unrelated.map(({ id }) => id));
        await testDb.insert(entities).values(unrelated);
        return await structuredDocumentScalingScenario.measure(context);
      };

      const small = await measureWithAddedDocuments(10);
      const large = await measureWithAddedDocuments(190);
      expect(small.statements).toBeGreaterThan(0);
      expect(small.rows).toBe(1);
      expect(readScalingViolations({ small, large })).toEqual([]);
    });
  },
);

describe("archive preview byte limits", () => {
  const oversized = DOCUMENT_ARCHIVE_MAX_BYTES + 1;
  const previews = [
    { format: ASIC_E_FILE_FORMAT, endpoint: asicPreviewEndpoint },
    { format: ASIC_S_FILE_FORMAT, endpoint: asicPreviewEndpoint },
    ...STRUCTURED_DOCUMENT_FORMATS.map((format) => ({
      format,
      endpoint: structuredDocumentEndpoint,
    })),
  ];

  const expectArchiveLimit = (response: unknown) =>
    expect(response).toMatchObject({
      code: 422,
      response: { code: PREVIEW_UNAVAILABLE_ERROR_CODE },
    });

  test.each(previews)(
    "$format.label rejects an oversized stored size without contacting S3",
    async ({ format, endpoint }) => {
      const { fieldId, entityId } = await seedFile({
        fileName: `record${format.extensions[0]}`,
        mimeType: "application/zip",
        pdfFileId: null,
        sizeBytes: oversized,
      });

      expectArchiveLimit(
        await endpoint.handler(legalFileContext(fieldId, scopedDbA())),
      );
      expect(fake.requests).toEqual([]);
      expect(await auditRowsFor(entityId)).toEqual([]);
    },
  );

  test.each(previews)(
    "$format.label checks the object size even when the stored size is stale",
    async ({ format, endpoint }) => {
      const { fieldId, entityId } = await seedFile({
        fileName: `record${format.extensions[0]}`,
        mimeType: "application/zip",
        pdfFileId: null,
        sizeBytes: 2048,
      });
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const response = await withTestFetch(
        asFetchMock(
          async () =>
            new Response(body, {
              headers: { "content-length": String(oversized) },
            }),
        ),
        async () =>
          await endpoint.handler(legalFileContext(fieldId, scopedDbA())),
      );
      expectArchiveLimit(response);
      expect(pulls).toBe(0);
      expect(cancelled).toBe(true);
      expect(await auditRowsFor(entityId)).toEqual([]);
    },
  );

  test("an archive stream cannot exceed its understated object size limit", async () => {
    const { fieldId, entityId } = await seedFile({
      fileName: "record.ofd",
      mimeType: "application/zip",
      pdfFileId: null,
    });
    const chunk = new Uint8Array(1024 * 1024);
    let transferred = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          transferred += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await withTestFetch(
      asFetchMock(
        async () =>
          new Response(body, { headers: { "content-length": "2048" } }),
      ),
      async () =>
        await structuredDocumentEndpoint.handler(
          legalFileContext(fieldId, scopedDbA()),
        ),
    );
    expectArchiveLimit(response);
    expect(transferred).toBe(DOCUMENT_ARCHIVE_MAX_BYTES + chunk.byteLength);
    expect(cancelled).toBe(true);
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("propagates unrelated storage failures", async () => {
    const mimeType = "application/zip";
    const { fieldId, fileId } = await seedFile({
      fileName: "record.ofd",
      mimeType,
      pdfFileId: null,
    });
    fake.failNext({
      method: "GET",
      status: 403,
      code: "AccessDenied",
      key: fileKeyFor(fileId, mimeType),
    });

    const failure = await rejectionOf(
      loadLegalFileSource(
        {
          fieldId,
          scopedDb: scopedDbA(),
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          recordAuditEvent: recorderA(),
        },
        ["ofd"],
      ),
    );
    expect(failure).toMatchObject({
      _tag: "S3ObjectReadError",
      status: 403,
      code: "AccessDenied",
    });
  });
});

describe("ASiC file delivery", () => {
  test("an existing generic ZIP upload exposes the same named document in Files and AI", async () => {
    const { fieldId, entityId, entityVersionId } = await seedAsic();
    await testDb
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));
    const view = await asicPreviewEndpoint.handler(
      legalFileContext(fieldId, scopedDbA()),
    );
    expect(view).toMatchObject({
      members: [
        { fileName: "lisa.txt", text: "Töölepingu lisa", status: "readable" },
      ],
    });
    await expectOneContentRow(entityId, {
      action: "access",
      metadata: { fieldId, format: "asic-e" },
    });
    const read = await LEGAL_FILE_READERS.asicE({
      fieldId,
      scopedDb: scopedDbA(),
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      recordAuditEvent: recorderA(),
      purpose: "agent",
    });
    const { text } = read.unwrap();
    expect(text).toContain("lisa.txt");
    expect(text).toContain("Töölepingu lisa");
    expect(text).toContain("unverified");
  });
  test("refuses an ASiC field in another matter", async () => {
    const { fieldId } = await seedFile(
      {
        fileName: "record.asics",
        mimeType: "application/zip",
        pdfFileId: null,
      },
      "b",
    );
    expect(
      answeredStatus(
        await asicPreviewEndpoint.handler(
          legalFileContext(fieldId, scopedDbA()),
        ),
      ),
    ).toBe(404);
  });
});

describe("CAdES file delivery", () => {
  test("serves the exact embedded PDF, scoped and audited", async () => {
    const bytes = await pdfBytes();
    const file = await seedCades(bytes);
    const response = await cadesContentEndpoint.handler(
      legalFileContext(file.fieldId, scopedDbA()),
    );
    if (!(response instanceof Response)) {
      panic("Expected a PDF response");
    }
    expect(response.headers.get("content-type")).toBe(PDF_MIME_TYPE);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(bytes),
    );
    await expectOneContentRow(file.entityId, {
      action: "access",
      metadata: { format: "cades", fieldId: file.fieldId },
    });
  });

  test("reads a stored generic-MIME signed file for the agent", async () => {
    const content = "Clausola terza";
    const { fieldId, entityId, entityVersionId } = await seedStored(
      {
        fileName: "contratto.txt.p7m",
        mimeType: "application/octet-stream",
        pdfFileId: null,
      },
      await wrapP7m(new TextEncoder().encode(content)),
    );
    await testDb
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));
    const read = await LEGAL_FILE_READERS.cades({
      fieldId,
      scopedDb: scopedDbA(),
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      recordAuditEvent: recorderA(),
      purpose: "agent",
    });
    expect(read.unwrap().text).toContain(content);
    expect(read.unwrap().text).toContain("unverified");
  });

  test("both endpoints refuse files from another matter", async () => {
    const { fieldId } = await seedFile(
      {
        fileName: "contratto.p7m",
        mimeType: CADES_FILE_FORMAT.mimeType,
        pdfFileId: null,
      },
      "b",
    );
    const context = legalFileContext(fieldId, scopedDbA());
    expect(answeredStatus(await cadesContentEndpoint.handler(context))).toBe(
      404,
    );
    expect(answeredStatus(await cadesPreviewEndpoint.handler(context))).toBe(
      404,
    );
  });

  test.each([
    { scenario: cadesContentScalingScenario, seed: seedCades },
    { scenario: cadesPreviewScalingScenario, seed: seedCades },
    { scenario: asicPreviewScalingScenario, seed: seedAsic },
  ])(
    "$scenario.name cost stays bounded as a matter grows",
    async ({ scenario: { measure }, seed }) => {
      const { fieldId } = await seed();
      const context = legalFileContext(fieldId, scopedDbA());
      const small = await measure(context);
      const unrelated = Array.from({ length: 80 }, () => ({
        id: createSafeId<"entity">(),
        name: "Docket entry",
        kind: "document" as const,
        workspaceId: ids.wsA1,
      }));
      seededEntityIds.push(...unrelated.map(({ id }) => id));
      await testDb.insert(entities).values(unrelated);
      const large = await measure(context);
      expect(small.statements).toBeGreaterThan(0);
      expect(small.rows).toBe(1);
      expect(readScalingViolations({ small, large })).toEqual([]);
    },
  );
});

const readDataBox = async (fieldId: SafeId<"field">, scopedDb: ScopedDb) =>
  await readDataBoxFile({
    fieldId,
    scopedDb,
    workspaceId: ids.wsA1,
    organizationId: ids.orgA,
    recordAuditEvent: recorderA(),
  });

// Unique per test: the matter is shared, and a digest finds any equal bytes.
const signedText = () =>
  new TextEncoder().encode(
    `Smlouva o dílo, podepsané znění ${Bun.randomUUIDv7()}`,
  );

/** A current matter document whose stored bytes are `bytes`. */
const seedCurrent = async (
  stored: StoredFile,
  bytes: Uint8Array,
  side: "a" | "b" = "a",
) => {
  const seeded =
    side === "a"
      ? await seedStored(
          {
            ...stored,
            sha256Hex: sha256Hex(bytes),
            sizeBytes: bytes.byteLength,
          },
          bytes,
        )
      : await seedFile(
          {
            ...stored,
            sha256Hex: sha256Hex(bytes),
            sizeBytes: bytes.byteLength,
          },
          "b",
        );
  await testDb
    .update(entities)
    .set({ currentVersionId: seeded.entityVersionId })
    .where(eq(entities.id, seeded.entityId));
  return seeded;
};

const seedEnvelopingXades = async () =>
  await seedStored(
    { fileName: "podanie.xml", mimeType: "text/xml", pdfFileId: null },
    await envelopingXades(await pdfBytes()),
  );

const signaturePreview = async (fieldId: SafeId<"field">) => {
  const preview = await signaturePreviewEndpoint.handler(
    legalFileContext(fieldId, scopedDbA()),
  );
  if (preview instanceof HttpStatusResponse) {
    return panic(`Expected a signature preview, got ${preview.code}`);
  }
  return preview;
};

describe("detached signature delivery", () => {
  test("names the signed document in the reader's matter, bound by digest", async () => {
    const SIGNED_TEXT = signedText();
    const signed = await seedCurrent(
      { fileName: "smlouva.pdf", mimeType: PDF_MIME_TYPE, pdfFileId: null },
      SIGNED_TEXT,
    );
    // The same name and bytes in a matter the reader cannot open.
    await seedCurrent(
      { fileName: "smlouva.pdf", mimeType: PDF_MIME_TYPE, pdfFileId: null },
      SIGNED_TEXT,
      "b",
    );
    const signature = await seedCurrent(
      {
        fileName: "smlouva.pdf.p7s",
        mimeType: "application/pkcs7-signature",
        pdfFileId: null,
      },
      await detachedCms(SIGNED_TEXT),
    );
    const preview = await signaturePreview(signature.fieldId);
    expect(preview).toMatchObject({
      type: "signature",
      standard: "cades",
      packaging: "detached",
      document: null,
      signedFiles: [
        {
          entityId: signed.entityId,
          fileName: "smlouva.pdf",
          binding: "digestMatches",
        },
      ],
    });
    await expectOneContentRow(signature.entityId, {
      action: "access",
      metadata: { fieldId: signature.fieldId, format: "cades-detached" },
    });
    // Reading the signature reads nothing of the signed document.
    expect(await auditRowsFor(signed.entityId)).toEqual([]);

    const agent = await LEGAL_FILE_READERS.cadesDetached({
      fieldId: signature.fieldId,
      scopedDb: scopedDbA(),
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      recordAuditEvent: recorderA(),
      purpose: "agent",
    });
    expect(agent.unwrap().text).toContain(
      "Document in this matter: smlouva.pdf (its stored bytes match the digest the signature states; this binds the bytes, it does not verify the signature)",
    );
  });

  test("tells a renamed signed copy from a changed file of the signed name", async () => {
    const SIGNED_TEXT = signedText();
    const renamed = await seedCurrent(
      { fileName: "sken 0042.pdf", mimeType: PDF_MIME_TYPE, pdfFileId: null },
      SIGNED_TEXT,
    );
    const changed = await seedCurrent(
      { fileName: "dodatek.pdf", mimeType: PDF_MIME_TYPE, pdfFileId: null },
      new TextEncoder().encode("Smlouva o dílo, změněné znění"),
    );
    const signature = await seedCurrent(
      {
        fileName: "dodatek.p7s",
        mimeType: "application/octet-stream",
        pdfFileId: null,
      },
      await detachedCms(SIGNED_TEXT),
    );
    const preview = await signaturePreview(signature.fieldId);
    expect(preview.type === "signature" && preview.signedFiles).toEqual([
      {
        entityId: renamed.entityId,
        fileName: "sken 0042.pdf",
        binding: "digestMatches",
      },
      {
        entityId: changed.entityId,
        fileName: "dodatek.pdf",
        binding: "digestDiffers",
      },
    ]);
  });

  test("compares a SHA-1 digest against the stored bytes of the named file", async () => {
    const SIGNED_TEXT = signedText();
    const signed = await seedCurrent(
      { fileName: "wniosek.pdf", mimeType: PDF_MIME_TYPE, pdfFileId: null },
      SIGNED_TEXT,
    );
    const signature = await seedCurrent(
      {
        fileName: "wniosek.pdf.sig",
        mimeType: "application/octet-stream",
        pdfFileId: null,
      },
      await detachedCms(SIGNED_TEXT, { digestAlgorithm: "SHA-1" }),
    );
    const preview = await signaturePreview(signature.fieldId);
    expect(preview.type === "signature" && preview.signedFiles).toEqual([
      {
        entityId: signed.entityId,
        fileName: "wniosek.pdf",
        binding: "digestMatches",
      },
    ]);
  });

  test("a plain .xml file is not a signature, and nothing is delivered", async () => {
    const plain = await seedStored(
      { fileName: "faktura.xml", mimeType: "text/xml", pdfFileId: null },
      new TextEncoder().encode("<faktura><castka>100</castka></faktura>"),
    );
    expect(await signaturePreview(plain.fieldId)).toEqual({
      type: "notSignature",
    });
    expect(await auditRowsFor(plain.entityId)).toEqual([]);
  });

  test("a file named as a signature that holds none is unreadable", async () => {
    const named = await seedStored(
      {
        fileName: "podpis.p7s",
        mimeType: "application/pkcs7-signature",
        pdfFileId: null,
      },
      new TextEncoder().encode("not a signature"),
    );
    expectStatus(
      await signaturePreviewEndpoint.handler(
        legalFileContext(named.fieldId, scopedDbA()),
      ),
      422,
    );
    expect(await auditRowsFor(named.entityId)).toEqual([]);
  });

  test("serves the exact PDF an enveloping XAdES .xml carries, audited", async () => {
    const bytes = await pdfBytes();
    const file = await seedStored(
      { fileName: "podanie.xml", mimeType: "text/xml", pdfFileId: null },
      await envelopingXades(bytes),
    );
    const response = await signatureContentEndpoint.handler(
      legalFileContext(file.fieldId, scopedDbA()),
    );
    if (!(response instanceof Response)) {
      panic("Expected a PDF response");
    }
    expect(response.headers.get("content-type")).toBe(PDF_MIME_TYPE);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(bytes),
    );
    await expectOneContentRow(file.entityId, {
      action: "access",
      metadata: { format: "xades", fieldId: file.fieldId },
    });
  });

  test("both endpoints refuse a signature in another matter", async () => {
    const { fieldId } = await seedFile(
      {
        fileName: "podpis.xades",
        mimeType: "application/octet-stream",
        pdfFileId: null,
      },
      "b",
    );
    const context = legalFileContext(fieldId, scopedDbA());
    expect(
      answeredStatus(await signaturePreviewEndpoint.handler(context)),
    ).toBe(404);
    expect(
      answeredStatus(await signatureContentEndpoint.handler(context)),
    ).toBe(404);
  });

  test.each([signatureContentScalingScenario, signaturePreviewScalingScenario])(
    "$name cost stays bounded as a matter grows",
    async ({ measure }) => {
      const { fieldId } = await seedEnvelopingXades();
      const context = legalFileContext(fieldId, scopedDbA());
      const small = await measure(context);
      const unrelated = Array.from({ length: 80 }, () => ({
        id: createSafeId<"entity">(),
        name: "Docket entry",
        kind: "document" as const,
        workspaceId: ids.wsA1,
      }));
      seededEntityIds.push(...unrelated.map(({ id }) => id));
      await testDb.insert(entities).values(unrelated);
      const large = await measure(context);
      expect(small.statements).toBeGreaterThan(0);
      expect(small.rows).toBe(1);
      expect(readScalingViolations({ small, large })).toEqual([]);
    },
  );

  test("a detached signature's matter lookup stays bounded as a matter grows", async () => {
    const SIGNED_TEXT = signedText();
    await seedCurrent(
      { fileName: "smlouva.pdf", mimeType: PDF_MIME_TYPE, pdfFileId: null },
      SIGNED_TEXT,
    );
    const signature = await seedCurrent(
      {
        fileName: "smlouva.pdf.p7s",
        mimeType: "application/pkcs7-signature",
        pdfFileId: null,
      },
      await detachedCms(SIGNED_TEXT),
    );
    const context = legalFileContext(signature.fieldId, scopedDbA());
    const small = await signaturePreviewScalingScenario.measure(context);
    const unrelated = Array.from({ length: 80 }, () => ({
      id: createSafeId<"entity">(),
      name: "Docket entry",
      kind: "document" as const,
      workspaceId: ids.wsA1,
    }));
    seededEntityIds.push(...unrelated.map(({ id }) => id));
    await testDb.insert(entities).values(unrelated);
    const large = await signaturePreviewScalingScenario.measure(context);
    expect(readScalingViolations({ small, large })).toEqual([]);
  });
});

describe("data-box file preview", () => {
  test("opens an unfiled source by field and audits the read", async () => {
    const file = await seedDataBox();
    const response = (await readDataBox(file.fieldId, scopedDbA())).unwrap();
    expect(response).toMatchObject({
      kind: "message",
      annotation: FIXTURE_MESSAGE.annotation,
      files: FIXTURE_MESSAGE.files.map(({ name }) => ({
        fileName: name,
        entityId: null,
      })),
      envelope: {
        messageId: FIXTURE_MESSAGE.messageId,
        seal: { status: "unverified" },
      },
    });
    expect(response.text).toContain(FIXTURE_MESSAGE.annotation);
    await expectOneContentRow(file.entityId, {
      action: "access",
      metadata: { fieldId: file.fieldId, format: "data-box" },
    });
  });

  test("links a filed attachment only while its current file matches the embedded bytes", async () => {
    const bytes = await zfoFile();
    const message = parseDataBoxMessage(bytes).unwrap();
    const identity = dataBoxPayloadIdentity(message);
    const attachment = message.files.at(0);
    expect(attachment).toBeDefined();
    if (!attachment) {
      return;
    }
    const source = await seedStored(
      {
        fileName: "zprava.zfo",
        mimeType: DATA_BOX_MESSAGE_MIME_TYPE,
        pdfFileId: null,
      },
      bytes,
    );
    const filed = await seedFile({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      pdfFileId: null,
      sha256Hex: sha256Hex(attachment.bytes),
    });
    const correspondenceId = createSafeId<"correspondence">();
    try {
      await testDb
        .update(entities)
        .set({ currentVersionId: filed.entityVersionId })
        .where(eq(entities.id, filed.entityId));
      // Inserting an uploaded correspondence registers its source via the
      // same trigger used when the upload is filed.
      await testDb.insert(correspondence).values({
        id: correspondenceId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        channel: "data_box",
        dataBox: message.envelope,
        direction: null,
        source: "upload",
        sourceEntityId: source.entityId,
        originalSignature: { status: "unverified" },
        messageId: message.envelope.messageId,
        contentHash: identity.contentHash,
        dedupKey: correspondenceId.replaceAll("-", "").repeat(2),
        from: { address: message.envelope.sender.boxId, name: null },
        to: [{ address: message.envelope.recipient.boxId, name: null }],
        cc: [],
        subject: message.annotation,
        receivedAt: new Date("2026-10-14T07:12:33.120Z"),
        references: [],
        bodyText: "",
      });
      await testDb.insert(correspondenceAttachments).values({
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        correspondenceId,
        entityId: filed.entityId,
        ordinal: 0,
        filename: attachment.fileName,
        mediaType: attachment.mimeType,
        byteSize: attachment.bytes.byteLength,
        scanVerdict: "clean",
      });

      const opened = (await readDataBox(source.fieldId, scopedDbA())).unwrap();
      expect(opened).toMatchObject({
        kind: "message",
        files: message.files.map(({ fileName }, index) => ({
          fileName,
          entityId: index === 0 ? filed.entityId : null,
        })),
      });

      const editedVersionId = createSafeId<"entityVersion">();
      const editedBytes = await pdfBytes();
      const editedHash = sha256Hex(editedBytes);
      expect(editedHash).not.toBe(sha256Hex(attachment.bytes));
      await testDb.insert(entityVersions).values({
        id: editedVersionId,
        workspaceId: ids.wsA1,
        entityId: filed.entityId,
        versionNumber: 2,
      });
      await testDb.insert(fields).values({
        id: createSafeId<"field">(),
        workspaceId: ids.wsA1,
        propertyId: ids.filePropertyA1,
        entityVersionId: editedVersionId,
        content: {
          version: 1,
          type: "file",
          id: Bun.randomUUIDv7(),
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: editedBytes.byteLength,
          encrypted: false,
          sha256Hex: editedHash,
          pdfFileId: null,
        },
      });
      await testDb
        .update(entities)
        .set({ currentVersionId: editedVersionId })
        .where(eq(entities.id, filed.entityId));

      const edited = (await readDataBox(source.fieldId, scopedDbA())).unwrap();
      expect(edited).toMatchObject({
        kind: "message",
        files: message.files.map(({ fileName }) => ({
          fileName,
          entityId: null,
        })),
      });
    } finally {
      await testDb
        .update(entities)
        .set({ currentVersionId: null })
        .where(eq(entities.id, filed.entityId));
      await testDb
        .delete(correspondence)
        .where(eq(correspondence.id, correspondenceId));
    }
  });

  test("a file in another matter cannot be previewed", async () => {
    const file = await seedFile(
      {
        fileName: "jiná.zfo",
        mimeType: DATA_BOX_MESSAGE_MIME_TYPE,
        pdfFileId: null,
      },
      "b",
    );
    const result = await readDataBox(file.fieldId, scopedDbA());
    expect(result.isErr() ? result.error.status : null).toBe(404);
  });

  test("preview query cost stays bounded as the matter grows", async () => {
    const file = await seedDataBox();
    const measure = async (added: number) => {
      const newRows = Array.from({ length: added }, () => ({
        id: createSafeId<"entity">(),
        name: "Docket entry",
        kind: "document" as const,
        workspaceId: ids.wsA1,
      }));
      seededEntityIds.push(...newRows.map(({ id }) => id));
      await testDb.insert(entities).values(newRows);
      return await dataBoxPreviewScalingScenario.measure(
        createTestHandlerContext<
          Parameters<typeof dataBoxPreviewScalingScenario.definition.handler>[0]
        >({
          workspaceId: ids.wsA1,
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
          audit: recorderA(),
          scopedDb: scopedDbA(),
          safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
          params: { workspaceId: ids.wsA1, fieldId: file.fieldId },
        }),
      );
    };
    const small = await measure(10);
    const large = await measure(190);
    expect(small.statements).toBeGreaterThan(0);
    expect(small.rows).toBe(FIXTURE_MESSAGE.files.length);
    expect(readScalingViolations({ small, large })).toEqual([]);
  });
});

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
    name: "a signature preview",
    seed: seedEnvelopingXades,
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await signaturePreviewEndpoint.handler(
          legalFileContext(fieldId, scopedDb),
        ),
      ),
  },
  {
    name: "a signature's PDF",
    seed: seedEnvelopingXades,
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await signatureContentEndpoint.handler(
          legalFileContext(fieldId, scopedDb),
        ),
      ),
  },
  {
    name: "an ASiC inventory",
    seed: seedAsic,
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await asicPreviewEndpoint.handler(legalFileContext(fieldId, scopedDb)),
      ),
  },
  {
    name: "a signed document preview",
    seed: seedCades,
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await cadesPreviewEndpoint.handler(legalFileContext(fieldId, scopedDb)),
      ),
  },
  {
    name: "a signed document's PDF",
    seed: seedCades,
    read: async ({ fieldId }, scopedDb) =>
      answeredStatus(
        await cadesContentEndpoint.handler(legalFileContext(fieldId, scopedDb)),
      ),
  },
  {
    name: "a data-box preview",
    seed: seedDataBox,
    read: async ({ fieldId }, scopedDb) => {
      const result = await readDataBox(fieldId, scopedDb);
      return result.isErr() ? result.error.status : 200;
    },
  },
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
