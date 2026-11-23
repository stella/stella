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
  FILE_PART_TEXT_PREVIEW_MAX_BYTES,
  parseFilePartId,
} from "@stll/api-contract/file-parts";
import {
  ASIC_E_FILE_FORMAT,
  ASIC_S_FILE_FORMAT,
  CADES_FILE_FORMAT,
  E_AKTA_FILE_FORMAT,
  ISDOC_FILE_FORMAT,
  ISDOCX_FILE_FORMAT,
  MBOX_FILE_FORMAT,
  XML_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";
import { SIGNED_DOSSIER_FORMATS } from "@stll/api-contract/signed-dossier-formats";
import { STRUCTURED_DOCUMENT_FORMATS } from "@stll/api-contract/structured-document-formats";
import { ZipArchive } from "@stll/docx-core/zip";
import { encodeDosCodePage } from "@stll/mojibake/dos-code-pages";
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
  organizationSettings,
  properties,
  syntheticSessionControl,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import asicPreviewEndpoint from "@/api/handlers/files/asic";
import { cadesPreviewEndpoint } from "@/api/handlers/files/cades";
import { readDocumentProperties } from "@/api/handlers/files/document-properties";
import { eInvoicePreviewEndpoint } from "@/api/handlers/files/e-invoice";
import emailReadingEndpoint from "@/api/handlers/files/email-reading";
import {
  printPdfHandler,
  readEmailHtmlPreviewHandler,
  stampedDownloadHandler,
} from "@/api/handlers/files/get";
import { mailboxPreviewEndpoint } from "@/api/handlers/files/mailbox";
import { readMarkedDownload } from "@/api/handlers/files/marked-download";
import { readFilePartListEndpoint } from "@/api/handlers/files/part-list";
import saveFilePartEndpoint from "@/api/handlers/files/part-save";
import { readScrubbedDownload } from "@/api/handlers/files/scrubbed-download";
import { signedDossierPreviewEndpoint } from "@/api/handlers/files/signed-dossier";
import structuredDocumentEndpoint from "@/api/handlers/files/structured-document";
import { zipArchivePreviewEndpoint } from "@/api/handlers/files/zip-archive";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "@/api/lib/desktop-edit-file-types";
import { dataBoxPayloadIdentity } from "@/api/lib/email/correspondence/data-box/payload-hash";
import { parseDataBoxMessage } from "@/api/lib/email/correspondence/data-box/zfo";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import { eInvoiceDocumentText } from "@/api/lib/files/e-invoice-text";
import {
  checkFileContentGrant,
  FILE_CONTENT_GRANT_TTL_MS,
} from "@/api/lib/files/file-content-grant";
import { loadLegalFileSource } from "@/api/lib/files/legal-file-source";
import { readDataBoxFile } from "@/api/lib/files/read-data-box-file";
import {
  readFileContentHandler,
  readFileHandler,
  readFilePartContentHandler,
  readFilePartUrlHandler,
} from "@/api/lib/files/read-file";
import { LEGAL_FILE_READERS } from "@/api/lib/files/read-legal-file";
import { createFileKey } from "@/api/lib/files/utils";
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
import {
  fatturaPaXml,
  isdocXml,
  isdocxPackage,
  plainXml,
  SAMPLE_ATTACHMENT_TEXT,
  xmlBytes,
} from "@/api/tests/fixtures/e-invoice";
import {
  mailMessage,
  MATTER_CORRESPONDENCE,
  writeMbox,
} from "@/api/tests/fixtures/mbox";
import { wrapP7m } from "@/api/tests/fixtures/p7m";
import {
  PEC_FIXTURE,
  PEC_SIGNER_NAME,
  pecMessage,
} from "@/api/tests/fixtures/pec";
import { makeEAktaFixture } from "@/api/tests/fixtures/signed-dossier";
import { FIXTURE_MESSAGE, zfoFile } from "@/api/tests/fixtures/zfo";
import { makeZipArchive } from "@/api/tests/fixtures/zip-archive";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { withTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock, asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { asicPreviewScalingScenario } from "@/api/tests/read-scaling/asic-preview";
import { cadesPreviewScalingScenario } from "@/api/tests/read-scaling/cades-preview";
import { dataBoxPreviewScalingScenario } from "@/api/tests/read-scaling/data-box-preview";
import { eInvoicePreviewScalingScenario } from "@/api/tests/read-scaling/e-invoice";
import { emailReadingScalingScenario } from "@/api/tests/read-scaling/email-reading";
import { filePartListScalingScenario } from "@/api/tests/read-scaling/file-part-list";
import { mailboxScalingScenario } from "@/api/tests/read-scaling/mailbox";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import { signedDossierPreviewScalingScenario } from "@/api/tests/read-scaling/signed-dossier";
import { structuredDocumentScalingScenario } from "@/api/tests/read-scaling/structured-document";
import { zipArchiveScalingScenario } from "@/api/tests/read-scaling/zip-archive";
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

const readPartUrl = async (
  fieldId: SafeId<"field">,
  partId: string,
  {
    purpose = "download",
    recordAuditEvent = recorderA(),
    scopedDb = scopedDbA(),
  }: {
    purpose?: "download" | "display";
    recordAuditEvent?: AuditRecorder;
    scopedDb?: ScopedDb;
  } = {},
) =>
  await readFilePartUrlHandler({
    part: parseFilePartId(partId) ?? panic(`Not a part address: ${partId}`),
    readSessionAuthority: async () => null,
    source: { kind: "request", sessionId: "fixture-session" },
    scopedDb,
    fieldId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    purpose,
    recordAuditEvent,
  });

/** Redeems a part link as `/file-content/:grant` does. */
const redeemPartUrl = async (presignedUrl: string) => {
  const checked = checkFileContentGrant({
    grant: contentGrantFromUrl(presignedUrl),
    now: await databaseClockMs("after"),
    secret: env.BETTER_AUTH_SECRET,
  });
  if (checked.status !== "valid" || checked.grant.part === null) {
    return panic("Expected a valid part grant");
  }
  const { grant } = checked;
  return await readFilePartContentHandler({
    fieldId: grant.fieldId,
    organizationId: grant.organizationId,
    part: grant.part ?? panic("Expected a part grant"),
    purpose: grant.purpose,
    scopedDb: scopedDbA(),
    workspaceId: grant.workspaceId,
  });
};

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

const seedEmail = async (eml: string = EMAIL_WITH_ATTACHMENT) => {
  const seeded = await seedFile({
    fileName: "smlouva.eml",
    mimeType: EML_MIME_TYPE,
    pdfFileId: null,
  });
  fake.put(
    envBase.S3_BUCKET,
    fileKeyFor(seeded.fileId, EML_MIME_TYPE),
    new TextEncoder().encode(eml),
    EML_MIME_TYPE,
  );
  return seeded;
};

/** An email whose text attachment is longer than a preview shows. */
const LONG_TEXT_ATTACHMENT_BYTES = FILE_PART_TEXT_PREVIEW_MAX_BYTES * 2;
const EMAIL_WITH_LONG_TEXT_ATTACHMENT = EMAIL_WITH_ATTACHMENT.replace(
  "Lhůta: 15. 10. 2026",
  () => "a".repeat(LONG_TEXT_ATTACHMENT_BYTES),
);

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

describe("email attachment", () => {
  test.each([
    ["display", "access", "inline"],
    ["download", "download", "attachment"],
  ] as const)(
    "a %s part link commits one %s row bound to the actor, matter and document",
    async (purpose, action, recorded) => {
      const seeded = await seedEmail();

      const issued = (
        await readPartUrl(seeded.fieldId, "attachment:0", { purpose })
      ).unwrap();

      expect(issued).toMatchObject({
        fileName: "poznamky.txt",
        mimeType: "text/plain",
      });
      await expectOneContentRow(seeded.entityId, {
        action,
        metadata: {
          disposition: recorded,
          fieldId: seeded.fieldId,
          format: "email",
          part: "attachment:0",
        },
      });
      const response = (await redeemPartUrl(issued.presignedUrl)).unwrap();
      expect(await response.text()).toContain("Lhůta");
    },
  );

  test.each(["display", "download"] as const)(
    "a %s part link is not issued when the audit row cannot be written",
    async (purpose) => {
      const seeded = await seedEmail();

      expect(
        await rejectionMessage(
          readPartUrl(seeded.fieldId, "attachment:0", {
            purpose,
            recordAuditEvent: failingRecorder,
          }),
        ),
      ).toBe("audit store unavailable");
      expect(await auditRowsFor(seeded.entityId)).toEqual([]);
    },
  );

  test("a display carries a long text part's preview and a download all of it", async () => {
    const seeded = await seedEmail(EMAIL_WITH_LONG_TEXT_ATTACHMENT);

    const delivered = async (purpose: "display" | "download") => {
      const issued = (
        await readPartUrl(seeded.fieldId, "attachment:0", { purpose })
      ).unwrap();
      const response = (await redeemPartUrl(issued.presignedUrl)).unwrap();
      return {
        contentLength: response.headers.get("content-length"),
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    };

    const display = await delivered("display");
    expect(display.bytes.byteLength).toBe(FILE_PART_TEXT_PREVIEW_MAX_BYTES + 1);
    expect(display.contentLength).toBe(
      String(FILE_PART_TEXT_PREVIEW_MAX_BYTES + 1),
    );
    const download = await delivered("download");
    expect(download.bytes.byteLength).toBe(LONG_TEXT_ATTACHMENT_BYTES);
    expect(download.contentLength).toBe(String(LONG_TEXT_ATTACHMENT_BYTES));
  });

  test("an attachment the email does not list is not found and records nothing", async () => {
    const seeded = await seedEmail();
    const read = await readPartUrl(seeded.fieldId, "attachment:1");
    expect(read.isErr() && read.error.status).toBe(404);
    expect(await auditRowsFor(seeded.entityId)).toEqual([]);
  });
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
    query: {},
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

/** A plain archive: a filing in a folder, a locked report, a forwarded email. */
const seedZip = async () =>
  await seedStored(
    {
      fileName: "podklady-ke-sporu.zip",
      mimeType: "application/x-zip-compressed",
      pdfFileId: null,
    },
    makeZipArchive([
      { name: "podání/vyjádření.txt", data: "Vyjádření žalovaného k žalobě" },
      { name: "znalecký posudek.pdf", data: "%PDF-1.7", flags: 0x00_01 },
      {
        name: "korespondence/podklady.eml",
        data: [
          "From: Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
          "To: Jitka Skořepová <skorepova@stavby-hradec.cz>",
          "Subject: Podklady k jednání",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="SPIS"',
          "",
          "--SPIS",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Dobrý den, v příloze posílám plnou moc.",
          "--SPIS",
          "Content-Type: text/plain; charset=utf-8",
          'Content-Disposition: attachment; filename="plna-moc.txt"',
          "",
          "Plná moc ze dne 2. 11. 2026",
          "--SPIS--",
          "",
        ].join("\r\n"),
      },
    ]),
  );

const POWER_OF_ATTORNEY = "Plná moc ze dne 2. 11. 2026";

/** A forwarded message, attached as an email file of its own. */
const FORWARDED = mailMessage(
  {
    from: "Jitka Skořepová <skorepova@stavby-hradec.cz>",
    to: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
    subject: "Fwd: Výzva k zaplacení",
    date: "Mon, 16 Nov 2026 16:40:00 +0100",
    body: "Přeposílám výzvu, kterou jsme obdrželi.",
  },
  "\r\n",
);

/**
 * A matter's mailbox as a mail client exports it (mboxrd): three messages,
 * then one with a power of attorney and a forwarded email attached.
 */
const MAILBOX = writeMbox(
  [
    ...MATTER_CORRESPONDENCE.map((message) => mailMessage(message)),
    mailMessage({
      from: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
      to: "Jitka Skořepová <skorepova@stavby-hradec.cz>",
      subject: "Plná moc a výzva",
      date: "Thu, 19 Nov 2026 10:15:00 +0100",
      body: "Dobrý den, v příloze posílám plnou moc.",
      attachments: [
        {
          fileName: "plna-moc.txt",
          mediaType: "text/plain; charset=utf-8",
          bytes: new TextEncoder().encode(POWER_OF_ATTORNEY),
        },
        {
          fileName: "vyzva.eml",
          mediaType: "message/rfc822",
          bytes: FORWARDED,
        },
      ],
    }),
  ],
  "mboxrd",
);

const seedMbox = async (tenant: "a" | "b" = "a") => {
  const stored = {
    fileName: "spis-23-C-118-2026.mbox",
    mimeType: "application/octet-stream",
    pdfFileId: null,
  };
  if (tenant === "b") {
    return await seedFile(stored, "b");
  }
  return await seedStored(stored, MAILBOX.bytes);
};

const partListContext = (
  fieldId: SafeId<"field">,
  part: string,
  scopedDb: ScopedDb,
  audit = recorderA(),
) =>
  createTestHandlerContext<
    Parameters<typeof readFilePartListEndpoint.handler>[0]
  >({
    workspaceId: ids.wsA1,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    audit,
    scopedDb,
    safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    params: { workspaceId: ids.wsA1, fieldId },
    query: { part },
  });

// A generic type models an older upload recognized by its stored extension.
const seedEAkta = async (pdf?: Uint8Array) =>
  await seedStored(
    {
      fileName: "kérelem.DOSSZIE",
      mimeType: "application/octet-stream",
      pdfFileId: null,
    },
    await makeEAktaFixture({
      documents: [
        { title: "kérelem.txt", extension: "txt", bytes: "Kérelem szövege" },
        {
          title: "végzés.pdf",
          extension: "pdf",
          bytes: pdf ?? (await pdfBytes()),
        },
      ],
      frameSigners: ["Example frame signer"],
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

const eInvoiceFixtures = [
  {
    format: ISDOC_FILE_FORMAT,
    // Browsers declare no type for an ISDOC file; its extension names it.
    stored: { fileName: "faktura.ISDOC", mimeType: "application/octet-stream" },
    bytes: async () => xmlBytes(isdocXml()),
    attachment: null,
  },
  {
    format: ISDOCX_FILE_FORMAT,
    stored: {
      fileName: "faktura.isdocx",
      mimeType: "application/octet-stream",
    },
    bytes: isdocxPackage,
    attachment: "delivery-note.txt",
  },
  {
    format: XML_FILE_FORMAT,
    stored: { fileName: "IT00000000001_00001.xml", mimeType: "text/xml" },
    bytes: async () => xmlBytes(fatturaPaXml()),
    attachment: "bolla.txt",
  },
] as const;

describe.each(eInvoiceFixtures)(
  "$format.label invoice delivery",
  ({ format, stored: file, bytes, attachment }) => {
    const stored = { ...file, pdfFileId: null };
    const seed = async () => await seedStored(stored, await bytes());

    test("Files and the agent receive the same invoice text and each read is audited", async () => {
      const { fieldId, entityId, entityVersionId } = await seed();
      await testDb
        .update(entities)
        .set({ currentVersionId: entityVersionId })
        .where(eq(entities.id, entityId));

      const preview = await eInvoicePreviewEndpoint.handler(
        legalFileContext(fieldId, scopedDbA()),
      );
      if (preview instanceof HttpStatusResponse) {
        panic("Expected a structured invoice preview");
      }
      expect(preview.invoices.length).toBeGreaterThan(0);
      await expectOneContentRow(entityId, {
        action: "access",
        metadata: {
          fieldId,
          format: format.auditFormat,
          disposition: "inline",
        },
      });
      const agent = await LEGAL_FILE_READERS[format.kind]({
        fieldId,
        scopedDb: scopedDbA(),
        workspaceId: ids.wsA1,
        organizationId: ids.orgA,
        recordAuditEvent: recorderA(),
        purpose: "agent",
      });
      expect(agent.unwrap()).toEqual({
        text: eInvoiceDocumentText(preview),
        attachments: [],
      });
      const rows = await auditRowsFor(entityId);
      expect(rows).toHaveLength(2);
      expect(rows.at(1)).toEqual(rows.at(0));
    });

    test("preview, attachment and agent reads cannot access another matter", async () => {
      const { fieldId, entityId } = await seedFile(stored, "b");
      expectStatus(
        await eInvoicePreviewEndpoint.handler(
          legalFileContext(fieldId, scopedDbA()),
        ),
        404,
      );
      const part = await readPartUrl(fieldId, "attachment:0");
      expect(part.isErr() && part.error.status).toBe(404);
      const agent = await LEGAL_FILE_READERS[format.kind]({
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

    test("returns no invoice when its audit record fails", async () => {
      const { fieldId, entityId } = await seed();
      let auditAttempted = false;
      const rejectAudit: AuditRecorder = async (tx, event) => {
        auditAttempted = true;
        return await failingRecorder(tx, event);
      };
      expectStatus(
        await eInvoicePreviewEndpoint.handler(
          legalFileContext(fieldId, scopedDbA(), rejectAudit),
        ),
        500,
      );
      expect(auditAttempted).toBe(true);
      expect(await auditRowsFor(entityId)).toEqual([]);
    });

    test("discards the parsed invoice when the source version is withdrawn", async () => {
      const { fieldId, entityId, entityVersionId } = await seed();
      expectStatus(
        await eInvoicePreviewEndpoint.handler(
          legalFileContext(fieldId, withdrawnAfterLookup(entityVersionId)),
        ),
        404,
      );
      expect(await auditRowsFor(entityId)).toEqual([]);
    });

    if (attachment !== null) {
      test("delivers an attachment through the part link as an audited download", async () => {
        const { fieldId, entityId } = await seed();
        const issued = (await readPartUrl(fieldId, "attachment:0")).unwrap();
        expect(issued.fileName).toBe(attachment);
        await expectOneContentRow(entityId, {
          action: "download",
          metadata: {
            fieldId,
            format: format.auditFormat,
            disposition: "attachment",
            part: "attachment:0",
          },
        });
        const response = (await redeemPartUrl(issued.presignedUrl)).unwrap();
        expect(response.headers.get("content-disposition")).toContain(
          "attachment",
        );
        expect(response.headers.get("content-disposition")).toContain(
          attachment,
        );
        expect(await response.text()).toBe(SAMPLE_ATTACHMENT_TEXT);
        const missing = await readPartUrl(fieldId, "attachment:1");
        expect(missing.isErr() && missing.error.status).toBe(404);
        expect(await auditRowsFor(entityId)).toHaveLength(1);
      });
    }

    test(`${format.label} preview query cost stays bounded as the matter grows`, async () => {
      const { fieldId } = await seed();
      const context = legalFileContext(fieldId, scopedDbA());
      const measureWithAddedDocuments = async (count: number) => {
        const unrelated = Array.from({ length: count }, () => ({
          id: createSafeId<"entity">(),
          workspaceId: ids.wsA1,
          kind: "document" as const,
          name: "Ledger entry",
        }));
        seededEntityIds.push(...unrelated.map(({ id }) => id));
        await testDb.insert(entities).values(unrelated);
        return await eInvoicePreviewScalingScenario.measure(context);
      };
      const small = await measureWithAddedDocuments(10);
      const large = await measureWithAddedDocuments(190);
      expect(small.statements).toBeGreaterThan(0);
      expect(readScalingViolations({ small, large })).toEqual([]);
    });
  },
);

test("plain XML is never read as an invoice and nothing is delivered", async () => {
  const { fieldId, entityId } = await seedStored(
    { fileName: "catalog.xml", mimeType: "application/xml", pdfFileId: null },
    xmlBytes(plainXml()),
  );
  expect(
    await eInvoicePreviewEndpoint.handler(
      legalFileContext(fieldId, scopedDbA()),
    ),
  ).toMatchObject({
    code: 422,
    response: { code: PREVIEW_UNAVAILABLE_ERROR_CODE },
  });
  expect(await auditRowsFor(entityId)).toEqual([]);
});

describe("email text reading", () => {
  const stored = {
    fileName: "posta-certificata.eml",
    mimeType: EML_MIME_TYPE,
    pdfFileId: null,
  };
  const seed = async () => await seedStored(stored, await pecMessage());

  test("returns a certified email's envelope, its original message and attachments, audited once", async () => {
    const { fieldId, entityId } = await seed();
    const read = await emailReadingEndpoint.handler(
      legalFileContext(fieldId, scopedDbA()),
    );
    expect(read).toMatchObject({
      certified: {
        system: "pec",
        kind: "transport",
        sender: PEC_FIXTURE.sender,
        messageId: PEC_FIXTURE.messageId,
        includesOriginal: true,
        signature: { status: "unverified", signerName: PEC_SIGNER_NAME },
      },
      subject: PEC_FIXTURE.subject,
      to: [PEC_FIXTURE.certifiedRecipient],
      attachments: [
        { part: "attachment:0", fileName: PEC_FIXTURE.attachmentName },
      ],
    });
    if (read instanceof HttpStatusResponse) {
      panic("Expected the certified email reading");
    }
    expect(read.from).toContain(PEC_FIXTURE.sender);
    expect(read.text).toContain(PEC_FIXTURE.body);
    await expectOneContentRow(entityId, {
      action: "access",
      metadata: {
        fieldId,
        format: "certified-email",
        disposition: "inline",
        mimeType: EML_MIME_TYPE,
      },
    });
  });

  test("an ordinary email is read with its header, body and attachments, audited once", async () => {
    const seeded = await seedEmail();
    const read = await emailReadingEndpoint.handler(
      legalFileContext(seeded.fieldId, scopedDbA()),
    );
    expect(read).toMatchObject({
      certified: null,
      subject: "Smlouva o dílo",
      to: ["kancelar@example.test"],
      cc: [],
      attachments: [
        {
          part: "attachment:0",
          fileName: "poznamky.txt",
          mediaType: "text/plain",
          sizeBytes: expect.any(Number),
        },
      ],
    });
    if (read instanceof HttpStatusResponse) {
      panic("Expected the email reading");
    }
    expect(read.from).toContain("jana@example.test");
    expect(read.date).not.toBeNull();
    // The header is returned as fields; the text is the body alone.
    expect(read.text).toContain("Dobrý den, v příloze posílám návrh smlouvy.");
    expect(read.text).not.toContain("Smlouva o dílo");
    expect(read.text).not.toContain("jana@example.test");
    await expectOneContentRow(seeded.entityId, {
      action: "access",
      metadata: {
        fieldId: seeded.fieldId,
        format: "email",
        disposition: "inline",
        mimeType: EML_MIME_TYPE,
      },
    });
  });

  test("a file that is not an email is refused as unavailable and records nothing", async () => {
    const { fieldId, entityId } = await seedFile({
      fileName: "smlouva-o-dilo.pdf",
      mimeType: "application/pdf",
      pdfFileId: null,
    });
    const read = await emailReadingEndpoint.handler(
      legalFileContext(fieldId, scopedDbA()),
    );
    expect(read).toMatchObject({
      code: 422,
      response: { code: PREVIEW_UNAVAILABLE_ERROR_CODE },
    });
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("another matter's certified email is not found and records nothing", async () => {
    const { fieldId, entityId } = await seedFile(stored, "b");
    expectStatus(
      await emailReadingEndpoint.handler(
        legalFileContext(fieldId, scopedDbA()),
      ),
      404,
    );
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("returns nothing when its audit record fails", async () => {
    const { fieldId, entityId } = await seed();
    expectStatus(
      await emailReadingEndpoint.handler(
        legalFileContext(fieldId, scopedDbA(), failingRecorder),
      ),
      500,
    );
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("discards the reading when the source version is withdrawn", async () => {
    const { fieldId, entityId, entityVersionId } = await seed();
    expectStatus(
      await emailReadingEndpoint.handler(
        legalFileContext(fieldId, withdrawnAfterLookup(entityVersionId)),
      ),
      404,
    );
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("query cost stays bounded as the matter grows", async () => {
    const { fieldId } = await seed();
    const context = legalFileContext(fieldId, scopedDbA());
    const measureWithAddedDocuments = async (count: number) => {
      const unrelated = Array.from({ length: count }, () => ({
        id: createSafeId<"entity">(),
        workspaceId: ids.wsA1,
        kind: "document" as const,
        name: "Ricevuta",
      }));
      seededEntityIds.push(...unrelated.map(({ id }) => id));
      await testDb.insert(entities).values(unrelated);
      return await emailReadingScalingScenario.measure(context);
    };

    const small = await measureWithAddedDocuments(10);
    const large = await measureWithAddedDocuments(190);
    expect(small.statements).toBeGreaterThan(0);
    expect(readScalingViolations({ small, large })).toEqual([]);
  });
});

const PART_CASES = [
  {
    name: "an ASiC member",
    seed: seedAsic,
    part: "member:0",
    format: "asic-e",
    fileName: "lisa.txt",
    text: "Töölepingu lisa",
  },
  {
    name: "a data-box file",
    seed: seedDataBox,
    part: "attachment:1",
    format: "data-box",
    fileName: "pouceni.txt",
    text: "Synthetic instructions.",
  },
  {
    name: "a certified email's attachment",
    seed: async () =>
      await seedStored(
        {
          fileName: "posta-certificata.eml",
          mimeType: EML_MIME_TYPE,
          pdfFileId: null,
        },
        await pecMessage(),
      ),
    part: "attachment:0",
    format: "email",
    fileName: PEC_FIXTURE.attachmentName,
    text: PEC_FIXTURE.attachmentText,
  },
] as const;

describe("file part links", () => {
  test.each(PART_CASES)(
    "$name opens through one audited link that reads it again when redeemed",
    async ({ seed, part, format, fileName, text }) => {
      const { fieldId, entityId } = await seed();
      const issued = (await readPartUrl(fieldId, part)).unwrap();
      expect(issued).toMatchObject({ fileName });
      expect(issued.presignedUrl).toContain("/v1/file-content/fc1.");
      await expectOneContentRow(entityId, {
        action: "download",
        metadata: { fieldId, part, format, disposition: "attachment" },
      });
      const response = (await redeemPartUrl(issued.presignedUrl)).unwrap();
      expect(response.headers.get("content-disposition")).toContain(
        "attachment",
      );
      expect(await response.text()).toBe(text);
      // Issuing the link recorded the delivery; redeeming it records nothing more.
      expect(await auditRowsFor(entityId)).toHaveLength(1);
    },
  );

  test("the document a signed envelope wraps opens as its PDF", async () => {
    const { fieldId, entityId } = await seedCades();
    const issued = (await readPartUrl(fieldId, "content:0")).unwrap();
    expect(issued).toMatchObject({
      fileName: "contratto.PDF",
      mimeType: PDF_MIME_TYPE,
    });
    const response = (await redeemPartUrl(issued.presignedUrl)).unwrap();
    expect(response.headers.get("content-type")).toBe(PDF_MIME_TYPE);
    expect((await response.bytes()).subarray(0, 5)).toEqual(
      new TextEncoder().encode("%PDF-"),
    );
    expect(await auditRowsFor(entityId)).toHaveLength(1);
  });

  test("a part the file does not have is not found and records nothing", async () => {
    const { fieldId, entityId } = await seedAsic();
    for (const part of ["member:5", "attachment:0", "document:0"]) {
      const read = await readPartUrl(fieldId, part);
      expect(read.isErr() && read.error.status).toBe(404);
    }
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("another matter's file part is not found and records nothing", async () => {
    const { fieldId, entityId } = await seedFile(
      { fileName: "toimik.BDOC", mimeType: "application/zip", pdfFileId: null },
      "b",
    );
    const read = await readPartUrl(fieldId, "member:0");
    expect(read.isErr() && read.error.status).toBe(404);
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("issues no link when the delivery cannot be recorded", async () => {
    const { fieldId, entityId } = await seedDataBox();
    expect(
      await rejectionMessage(
        readPartUrl(fieldId, "attachment:0", {
          recordAuditEvent: failingRecorder,
        }),
      ),
    ).toBe("audit store unavailable");
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("a part read while its version is withdrawn is not delivered", async () => {
    const { fieldId, entityId, entityVersionId } = await seedAsic();
    const read = await readPartUrl(fieldId, "member:0", {
      scopedDb: withdrawnAfterLookup(entityVersionId),
    });
    expect(read.isErr() && read.error.status).toBe(404);
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("a link redeemed after its version is withdrawn delivers nothing", async () => {
    const { fieldId, entityVersionId } = await seedAsic();
    const issued = (await readPartUrl(fieldId, "member:0")).unwrap();
    await testDb
      .update(entityVersions)
      .set({ deletedAt: new Date("2026-02-01T00:00:00.000Z") })
      .where(eq(entityVersions.id, entityVersionId));
    const redeemed = await redeemPartUrl(issued.presignedUrl);
    expect(redeemed.isErr() && redeemed.error.status).toBe(404);
  });

  test("part link query cost stays bounded as the matter grows", async () => {
    const { fieldId } = await seedDataBox();
    const measureWithAddedDocuments = async (count: number) => {
      const unrelated = Array.from({ length: count }, () => ({
        id: createSafeId<"entity">(),
        workspaceId: ids.wsA1,
        kind: "document" as const,
        name: "Spis",
      }));
      seededEntityIds.push(...unrelated.map(({ id }) => id));
      await testDb.insert(entities).values(unrelated);
      return await runWithMeasuredQueryCounter(async (counter) => {
        const issued = (await readPartUrl(fieldId, "attachment:0")).unwrap();
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(issued)),
          rows: 1,
        };
      });
    };
    const small = await measureWithAddedDocuments(10);
    const large = await measureWithAddedDocuments(190);
    expect(small.statements).toBeGreaterThan(0);
    expect(readScalingViolations({ small, large })).toEqual([]);
  });
});

describe("archive preview byte limits", () => {
  const oversized = DOCUMENT_ARCHIVE_MAX_BYTES + 1;
  const previews = [
    { format: ASIC_E_FILE_FORMAT, endpoint: asicPreviewEndpoint },
    { format: ASIC_S_FILE_FORMAT, endpoint: asicPreviewEndpoint },
    ...SIGNED_DOSSIER_FORMATS.map((format) => ({
      format,
      endpoint: signedDossierPreviewEndpoint,
    })),
    ...STRUCTURED_DOCUMENT_FORMATS.map((format) => ({
      format,
      endpoint: structuredDocumentEndpoint,
    })),
    { format: ISDOCX_FILE_FORMAT, endpoint: eInvoicePreviewEndpoint },
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

describe("ZIP archive delivery", () => {
  test("an archive shows the same files in Files and AI, a locked one with its reason", async () => {
    const { fieldId, entityId, entityVersionId } = await seedZip();
    await testDb
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));
    const view = await zipArchivePreviewEndpoint.handler(
      legalFileContext(fieldId, scopedDbA()),
    );
    expect(view).toMatchObject({
      files: [
        {
          fileName: "vyjádření.txt",
          folder: "podání",
          part: { part: "member:0", mediaType: "text/plain" },
          text: "Vyjádření žalovaného k žalobě",
          status: "readable",
        },
        {
          fileName: "znalecký posudek.pdf",
          part: null,
          unavailable: "encrypted",
        },
        {
          fileName: "podklady.eml",
          folder: "korespondence",
          part: { part: "member:2" },
        },
      ],
    });
    await expectOneContentRow(entityId, {
      action: "access",
      metadata: { fieldId, format: "zip" },
    });
    const read = await LEGAL_FILE_READERS.zip({
      fieldId,
      scopedDb: scopedDbA(),
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      recordAuditEvent: recorderA(),
      purpose: "agent",
    });
    const { text } = read.unwrap();
    expect(text).toContain("podání/vyjádření.txt");
    expect(text).toContain("Vyjádření žalovaného k žalobě");
    expect(text).toContain("The file is encrypted.");
  });

  test("an email in an archive lists its attachments, each opening by its path", async () => {
    const { fieldId, entityId } = await seedZip();
    const listed = await readFilePartListEndpoint.handler(
      partListContext(fieldId, "member:2", scopedDbA()),
    );
    expect(listed).toEqual({
      files: [
        {
          fileName: "plna-moc.txt",
          folder: null,
          sizeBytes: new TextEncoder().encode("Plná moc ze dne 2. 11. 2026")
            .byteLength,
          part: expect.objectContaining({
            part: "member:2/attachment:0",
            fileName: "plna-moc.txt",
          }),
          unavailable: null,
          charset: "utf-8",
        },
      ],
    });
    await expectOneContentRow(entityId, {
      action: "access",
      metadata: { fieldId, format: "zip", part: "member:2" },
    });
    const issued = (
      await readPartUrl(fieldId, "member:2/attachment:0")
    ).unwrap();
    expect(issued).toMatchObject({ fileName: "plna-moc.txt" });
    const response = (await redeemPartUrl(issued.presignedUrl)).unwrap();
    expect(await response.text()).toBe("Plná moc ze dne 2. 11. 2026");
  });

  test("a locked file and a file that holds no files open nothing, and record nothing", async () => {
    const { fieldId, entityId } = await seedZip();
    const locked = await readPartUrl(fieldId, "member:1");
    expect(locked.isErr() && locked.error.status).toBe(404);
    expect(
      answeredStatus(
        await readFilePartListEndpoint.handler(
          partListContext(fieldId, "member:0", scopedDbA()),
        ),
      ),
    ).toBe(404);
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("refuses another matter's archive and its parts", async () => {
    const { fieldId, entityId } = await seedFile(
      {
        fileName: "podklady-ke-sporu.zip",
        mimeType: "application/zip",
        pdfFileId: null,
      },
      "b",
    );
    expect(
      answeredStatus(
        await zipArchivePreviewEndpoint.handler(
          legalFileContext(fieldId, scopedDbA()),
        ),
      ),
    ).toBe(404);
    expect(
      answeredStatus(
        await readFilePartListEndpoint.handler(
          partListContext(fieldId, "member:2", scopedDbA()),
        ),
      ),
    ).toBe(404);
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("the files inside a part cost the same as a matter grows", async () => {
    const { fieldId } = await seedZip();
    const context = partListContext(fieldId, "member:2", scopedDbA());
    const small = await filePartListScalingScenario.measure(context);
    const unrelated = Array.from({ length: 80 }, () => ({
      id: createSafeId<"entity">(),
      name: "Docket entry",
      kind: "document" as const,
      workspaceId: ids.wsA1,
    }));
    seededEntityIds.push(...unrelated.map(({ id }) => id));
    await testDb.insert(entities).values(unrelated);
    const large = await filePartListScalingScenario.measure(context);
    expect(small.statements).toBeGreaterThan(0);
    expect(readScalingViolations({ small, large })).toEqual([]);
  });
});

describe("ZIP names in the organization's code page", () => {
  // "Důkazy.pdf" written by Windows set to code page 852, without the UTF-8
  // flag: its one byte above 0x7F is "ů" in 852 and "à" in 437, a tie.
  const TIED_NAME =
    encodeDosCodePage("Důkazy.pdf", "ibm852") ?? panic("852 writes the name");

  /** An archive holding the name, and an archive in it holding it too. */
  const seedTiedZip = async () =>
    await seedStored(
      {
        fileName: "dukazy-ke-sporu.zip",
        mimeType: "application/zip",
        pdfFileId: null,
      },
      makeZipArchive([
        { name: TIED_NAME, data: "%PDF-1.7", flags: 0 },
        {
          name: "spis.zip",
          data: makeZipArchive([
            { name: TIED_NAME, data: "%PDF-1.7", flags: 0 },
          ]),
          method: 0,
        },
      ]),
    );

  const practising = async (countryCode: string) =>
    await testDb
      .insert(organizationSettings)
      .values({
        organizationId: ids.orgA,
        practiceJurisdictions: [{ countryCode, isPrimary: true }],
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: { practiceJurisdictions: [{ countryCode, isPrimary: true }] },
      });

  /**
   * The tied name as the preview, the part list of the archive inside and
   * the text an agent reads all show it: `shown`, never `other`.
   */
  const expectShown = async (
    fieldId: SafeId<"field">,
    { shown, other }: { shown: string; other: string },
  ) => {
    expect(
      await zipArchivePreviewEndpoint.handler(
        legalFileContext(fieldId, scopedDbA()),
      ),
    ).toMatchObject({
      files: [{ fileName: shown }, { fileName: "spis.zip" }],
    });
    expect(
      await readFilePartListEndpoint.handler(
        partListContext(fieldId, "member:1", scopedDbA()),
      ),
    ).toMatchObject({ files: [{ fileName: shown }] });
    const { text } = (
      await LEGAL_FILE_READERS.zip({
        fieldId,
        scopedDb: scopedDbA(),
        workspaceId: ids.wsA1,
        organizationId: ids.orgA,
        recordAuditEvent: recorderA(),
        purpose: "agent",
      })
    ).unwrap();
    expect(text).toContain(shown);
    expect(text).not.toContain(other);
  };

  test("a tie reads in 852 for a Czech practice and in 437 for a German one", async () => {
    const before = await testDb.query.organizationSettings.findFirst({
      where: { organizationId: { eq: ids.orgA } },
      columns: { practiceJurisdictions: true },
    });
    const { fieldId, entityId, entityVersionId } = await seedTiedZip();
    await testDb
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));
    try {
      await practising("CZ");
      await expectShown(fieldId, { shown: "Důkazy.pdf", other: "Dàkazy.pdf" });
      await practising("DE");
      await expectShown(fieldId, { shown: "Dàkazy.pdf", other: "Důkazy.pdf" });
    } finally {
      await (before === undefined
        ? testDb
            .delete(organizationSettings)
            .where(eq(organizationSettings.organizationId, ids.orgA))
        : testDb
            .update(organizationSettings)
            .set({ practiceJurisdictions: before.practiceJurisdictions })
            .where(eq(organizationSettings.organizationId, ids.orgA)));
    }
  });
});

describe("mailbox delivery", () => {
  test("a mailbox lists its messages in Files and reads its text for AI", async () => {
    const { fieldId, entityId, entityVersionId } = await seedMbox();
    await testDb
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));
    const view = await mailboxPreviewEndpoint.handler(
      legalFileContext(fieldId, scopedDbA()),
    );
    expect(view).toMatchObject({
      truncated: false,
      messages: [
        {
          subject: "Spis 23 C 118/2026, podklady k jednání",
          from: expect.stringContaining("kalina@ak-kalina-vesela.cz"),
          // No folder header: the mailbox file is the folder.
          folder: "spis-23-C-118-2026",
          part: {
            part: "message:0",
            fileName: "Spis 23 C 118_2026, podklady k jednání.eml",
            mediaType: EML_MIME_TYPE,
          },
          unavailable: null,
        },
        { folder: "Spisy/23 C 118-2026,Důležité", part: { part: "message:1" } },
        { subject: "Vyjádření k žalobě", folder: "Spisy/Stavby Hradec" },
        { subject: "Plná moc a výzva", part: { part: "message:3" } },
      ],
    });
    await expectOneContentRow(entityId, {
      action: "access",
      metadata: { fieldId, format: MBOX_FILE_FORMAT.auditFormat },
    });
    const read = await LEGAL_FILE_READERS.mbox({
      fieldId,
      scopedDb: scopedDbA(),
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      recordAuditEvent: recorderA(),
      purpose: "agent",
    });
    const { text } = read.unwrap();
    expect(text).toStartWith("Mailbox.");
    expect(text).toContain("Subject: Vyjádření k žalobě");
    expect(text).toContain("From the court's summons");
    expect(text).toContain("Attachments: plna-moc.txt, vyzva.eml");
  });

  test("a message opens as an email, and its attachments by their paths", async () => {
    const { fieldId, entityId } = await seedMbox();
    const issued = (await readPartUrl(fieldId, "message:3")).unwrap();
    expect(issued).toMatchObject({
      fileName: "Plná moc a výzva.eml",
      mimeType: EML_MIME_TYPE,
    });
    const message = await (
      await redeemPartUrl(issued.presignedUrl)
    )
      .unwrap()
      .text();
    expect(message).toBe(new TextDecoder().decode(MAILBOX.expected[3]));
    // The message alone was read, by its range; the mailbox was streamed.
    const ranges = fake.requests.flatMap(({ method, range }) =>
      method === "GET" && range !== null ? [range] : [],
    );
    expect(ranges.length).toBeGreaterThan(0);
    expect(new Set(ranges).size).toBe(1);

    const listed = await readFilePartListEndpoint.handler(
      partListContext(fieldId, "message:3", scopedDbA()),
    );
    expect(listed).toMatchObject({
      files: [
        { fileName: "plna-moc.txt", part: { part: "message:3/attachment:0" } },
        { fileName: "vyzva.eml", part: { part: "message:3/attachment:1" } },
      ],
    });
    const attachment = (
      await readPartUrl(fieldId, "message:3/attachment:0")
    ).unwrap();
    expect(
      await (await redeemPartUrl(attachment.presignedUrl)).unwrap().text(),
    ).toBe(POWER_OF_ATTORNEY);

    const reading = await emailReadingEndpoint.handler({
      ...legalFileContext(fieldId, scopedDbA()),
      query: { part: "message:3" },
    });
    expect(reading).toMatchObject({
      subject: "Plná moc a výzva",
      text: expect.stringContaining("posílám plnou moc"),
      attachments: [
        { part: "message:3/attachment:0", fileName: "plna-moc.txt" },
        { part: "message:3/attachment:1", fileName: "vyzva.eml" },
      ],
    });
    const forwarded = await emailReadingEndpoint.handler({
      ...legalFileContext(fieldId, scopedDbA()),
      query: { part: "message:3/attachment:1" },
    });
    expect(forwarded).toMatchObject({ subject: "Fwd: Výzva k zaplacení" });
    expect(
      (await auditRowsFor(entityId)).map(({ metadata }) => metadata),
    ).toContainEqual(
      expect.objectContaining({ format: "mbox", part: "message:3" }),
    );
  });

  test("a message the mailbox does not have is not found and records nothing", async () => {
    const { fieldId, entityId } = await seedMbox();
    const missing = await readPartUrl(fieldId, "message:9");
    expect(missing.isErr() && missing.error.status).toBe(404);
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  test("refuses another matter's mailbox and its messages", async () => {
    const { fieldId, entityId } = await seedMbox("b");
    expect(
      answeredStatus(
        await mailboxPreviewEndpoint.handler(
          legalFileContext(fieldId, scopedDbA()),
        ),
      ),
    ).toBe(404);
    const message = await readPartUrl(fieldId, "message:0");
    expect(message.isErr() && message.error.status).toBe(404);
    expect(await auditRowsFor(entityId)).toEqual([]);
  });
});

describe("signed container delivery", () => {
  test("an existing generic upload shows the same documents and signers in Files and AI", async () => {
    const { fieldId, entityId, entityVersionId } = await seedEAkta();
    await testDb
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));
    const view = await signedDossierPreviewEndpoint.handler(
      legalFileContext(fieldId, scopedDbA()),
    );
    expect(view).toMatchObject({
      signers: [{ name: "Example frame signer" }],
      documents: [
        {
          fileName: "kérelem.txt",
          text: "Kérelem szövege",
          status: "readable",
          part: { part: "document:0", mediaType: "text/plain" },
        },
        {
          fileName: "végzés.pdf",
          part: { part: "document:1", mediaType: PDF_MIME_TYPE },
        },
      ],
    });
    await expectOneContentRow(entityId, {
      action: "access",
      metadata: { fieldId, format: E_AKTA_FILE_FORMAT.auditFormat },
    });
    const read = await LEGAL_FILE_READERS.eAkta({
      fieldId,
      scopedDb: scopedDbA(),
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      recordAuditEvent: recorderA(),
      purpose: "agent",
    });
    const { text } = read.unwrap();
    expect(text).toContain("kérelem.txt");
    expect(text).toContain("Kérelem szövege");
    expect(text).toContain("Example frame signer");
    expect(text).toContain("unverified");
  });

  test("serves the exact embedded PDF through the part link, scoped and audited", async () => {
    const pdf = await pdfBytes();
    const { fieldId, entityId } = await seedEAkta(pdf);
    const issued = (await readPartUrl(fieldId, "document:1")).unwrap();
    expect(issued).toMatchObject({
      fileName: "végzés.pdf",
      mimeType: PDF_MIME_TYPE,
    });
    const response = (await redeemPartUrl(issued.presignedUrl)).unwrap();
    expect(response.headers.get("content-type")).toBe(PDF_MIME_TYPE);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(pdf),
    );
    await expectOneContentRow(entityId, {
      action: "download",
      metadata: {
        fieldId,
        format: E_AKTA_FILE_FORMAT.auditFormat,
        part: "document:1",
      },
    });
  });

  test("serves a document of any type, as its preview lists it", async () => {
    const { fieldId } = await seedEAkta();
    const issued = (await readPartUrl(fieldId, "document:0")).unwrap();
    expect(issued).toMatchObject({
      fileName: "kérelem.txt",
      mimeType: "text/plain",
    });
    const response = (await redeemPartUrl(issued.presignedUrl)).unwrap();
    expect(await response.text()).toBe("Kérelem szövege");
  });

  test("the preview and the part link refuse a signed container in another matter", async () => {
    const { fieldId, entityId } = await seedFile(
      {
        fileName: "podanie.zep",
        mimeType: "application/zip",
        pdfFileId: null,
      },
      "b",
    );
    expect(
      answeredStatus(
        await signedDossierPreviewEndpoint.handler(
          legalFileContext(fieldId, scopedDbA()),
        ),
      ),
    ).toBe(404);
    const read = await readPartUrl(fieldId, "document:0");
    expect(read.isErr() && read.error.status).toBe(404);
    expect(await auditRowsFor(entityId)).toEqual([]);
  });

  const growMatter = async () => {
    const unrelated = Array.from({ length: 80 }, () => ({
      id: createSafeId<"entity">(),
      name: "Docket entry",
      kind: "document" as const,
      workspaceId: ids.wsA1,
    }));
    seededEntityIds.push(...unrelated.map(({ id }) => id));
    await testDb.insert(entities).values(unrelated);
  };

  test("preview cost stays bounded as a matter grows", async () => {
    const { fieldId } = await seedEAkta();
    const context = legalFileContext(fieldId, scopedDbA());
    const small = await signedDossierPreviewScalingScenario.measure(context);
    await growMatter();
    const large = await signedDossierPreviewScalingScenario.measure(context);
    expect(small.statements).toBeGreaterThan(0);
    expect(small.rows).toBe(2);
    expect(readScalingViolations({ small, large })).toEqual([]);
  });
});

describe("CAdES file delivery", () => {
  test("serves the exact embedded PDF through the part link, scoped and audited", async () => {
    const bytes = await pdfBytes();
    const file = await seedCades(bytes);
    const issued = (await readPartUrl(file.fieldId, "content:0")).unwrap();
    const response = (await redeemPartUrl(issued.presignedUrl)).unwrap();
    expect(response.headers.get("content-type")).toBe(PDF_MIME_TYPE);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(bytes),
    );
    await expectOneContentRow(file.entityId, {
      action: "download",
      metadata: { format: "cades", fieldId: file.fieldId, part: "content:0" },
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

  test("the preview and the part link refuse files from another matter", async () => {
    const { fieldId } = await seedFile(
      {
        fileName: "contratto.p7m",
        mimeType: CADES_FILE_FORMAT.mimeType,
        pdfFileId: null,
      },
      "b",
    );
    const context = legalFileContext(fieldId, scopedDbA());
    const read = await readPartUrl(fieldId, "content:0");
    expect(read.isErr() && read.error.status).toBe(404);
    expect(answeredStatus(await cadesPreviewEndpoint.handler(context))).toBe(
      404,
    );
  });

  test.each([
    { scenario: cadesPreviewScalingScenario, seed: seedCades },
    { scenario: asicPreviewScalingScenario, seed: seedAsic },
    { scenario: zipArchiveScalingScenario, seed: seedZip },
    { scenario: mailboxScalingScenario, seed: seedMbox },
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

const savePartContext = (fieldId: SafeId<"field">, part: string) =>
  createTestHandlerContext<Parameters<typeof saveFilePartEndpoint.handler>[0]>({
    workspaceId: ids.wsA1,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    audit: recorderA(),
    createAuditRecorder: ({
      workspaceId,
    }: { workspaceId?: SafeId<"workspace"> | null } = {}) =>
      createAuditRecorder({
        organizationId: ids.orgA,
        workspaceId: workspaceId ?? ids.wsA1,
        userId: ids.userA1,
        request: new Request("https://api.example.test/files"),
        server: null,
      }),
    getWorkspaceAccess: async (workspaceId) =>
      await Promise.resolve(
        workspaceId === ids.wsA1
          ? { id: workspaceId, status: "active" as const }
          : null,
      ),
    scopedDb: scopedDbA(),
    safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    params: { workspaceId: ids.wsA1, fieldId },
    body: { part, destinationWorkspaceId: ids.wsA1, parentId: null },
    server: null,
  });

const documentsInMatterA = async () =>
  (
    await testDb
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.workspaceId, ids.wsA1))
  ).length;

describe("saving a file part", () => {
  test("a listed part becomes a document whose creation records the part it came from", async () => {
    const source = await seedAsic();
    const saved = await saveFilePartEndpoint.handler(
      savePartContext(source.fieldId, "member:0"),
    );
    if (saved instanceof HttpStatusResponse) {
      panic(`Expected the part to be saved, got ${String(saved.code)}`);
    }
    seededEntityIds.push(saved.entityId);
    expect(saved.fileName).toBe("lisa.txt");
    const [created] = await testDb
      .select({ content: fields.content })
      .from(fields)
      .where(eq(fields.id, saved.fieldId));
    // Stored as the part link delivers it: its name, type and bytes.
    expect(created?.content).toMatchObject({
      type: "file",
      fileName: "lisa.txt",
      mimeType: "text/plain",
      sizeBytes: new TextEncoder().encode("Töölepingu lisa").byteLength,
    });
    expect(await auditRowsFor(saved.entityId)).toEqual([
      expect.objectContaining({
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        metadata: expect.objectContaining({
          provenance: {
            type: "file_part",
            part: "member:0",
            sourceEntityId: source.entityId,
            sourceFieldId: source.fieldId,
            sourceWorkspaceId: ids.wsA1,
          },
        }),
      }),
    ]);
    // The copy's creation is the record; the source logs no separate delivery.
    expect(await auditRowsFor(source.entityId)).toEqual([]);
  });

  test("a part the file's preview does not list is refused and nothing is created", async () => {
    const source = await seedAsic();
    const before = await documentsInMatterA();
    for (const part of ["member:1", "attachment:0", "content:0"]) {
      expectStatus(
        await saveFilePartEndpoint.handler(
          savePartContext(source.fieldId, part),
        ),
        404,
      );
    }
    expect(await documentsInMatterA()).toBe(before);
    expect(await auditRowsFor(source.entityId)).toEqual([]);
  });

  test("another matter's file part is not saved", async () => {
    const { fieldId, entityId } = await seedFile(
      { fileName: "toimik.BDOC", mimeType: "application/zip", pdfFileId: null },
      "b",
    );
    const before = await documentsInMatterA();
    expectStatus(
      await saveFilePartEndpoint.handler(savePartContext(fieldId, "member:0")),
      404,
    );
    expect(await documentsInMatterA()).toBe(before);
    expect(await auditRowsFor(entityId)).toEqual([]);
  });
});

const readDataBox = async (fieldId: SafeId<"field">, scopedDb: ScopedDb) =>
  await readDataBoxFile({
    fieldId,
    scopedDb,
    workspaceId: ids.wsA1,
    organizationId: ids.orgA,
    recordAuditEvent: recorderA(),
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
    name: "a signed document's content",
    seed: seedCades,
    read: async ({ fieldId }, scopedDb) => {
      const result = await readPartUrl(fieldId, "content:0", { scopedDb });
      return result.isErr() ? result.error.status : 200;
    },
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
    read: async ({ fieldId }, scopedDb) => {
      const result = await readPartUrl(fieldId, "attachment:0", { scopedDb });
      return result.isErr() ? result.error.status : 200;
    },
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
