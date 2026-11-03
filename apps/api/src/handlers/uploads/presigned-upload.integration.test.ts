import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import JSZip from "jszip";

import {
  API_FILE_SECURITY_REJECTED_ERROR_CODE,
  DOCUMENT_UPLOAD_PUT_TIMEOUT_MS,
  FILE_SECURITY_REMEDIATION,
} from "@stll/api-contract";
import type { ApiFileSecurityRejectionDetails } from "@stll/api-contract";
import {
  ATTACHED_TEMPLATE_SECURITY_RULE,
  writeZipEntry,
} from "@stll/docx-utils";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import {
  documentProcessingRuns,
  entityVersions,
  extractedContent,
  fields,
  pendingUploads,
  searchDocuments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId, type SafeId, toSafeId } from "@/api/lib/branded-types";
import { processDocumentProcessingRun } from "@/api/lib/document-processing-queue";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { UPLOAD_FINALIZE_ADMISSION } from "@/api/lib/uploads/finalize-admission";
import {
  FINALIZE_CLAIM_TIMEOUT_MS,
  legacyTmpUploadKey,
  PRESIGN_URL_EXPIRY_SECONDS,
} from "@/api/lib/uploads/runtime";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import { docxWithMarkers } from "@/api/tests/helpers/docx-with-markers";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { largeDocx } from "@/api/tests/helpers/large-ooxml";
import {
  executeRowsDatabase,
  executeRowsSafeDb,
  executeRowsScopedDb,
} from "@/api/tests/helpers/pglite-rows-scoped-db";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import presignUpload from "./create";
import abortUpload from "./delete";
import finalizeUpload from "./update";

setDefaultTimeout(120_000);

type PresignCtx = Parameters<typeof presignUpload.handler>[0];
type AbortCtx = Parameters<typeof abortUpload.handler>[0];
type FinalizeCtx = Parameters<typeof finalizeUpload.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
// The URL is signed by the real presigner and the bytes are PUT to the real
// store, so the key the API mints is the key the object lands under and the
// abort cleanup is observable in the store rather than on a spy.
let fake: FakeS3;

const seededUploadIds: SafeId<"pendingUpload">[] = [];
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ATTACHED_TEMPLATE_MESSAGE =
  "Document contains an external Word template link (potential template injection)";
const ATTACHED_TEMPLATE_REJECTION_MESSAGE = `File rejected by security rule ${ATTACHED_TEMPLATE_SECURITY_RULE}: ${ATTACHED_TEMPLATE_MESSAGE}`;

const makeAttachedTemplateDocx = async (): Promise<Uint8Array> => {
  const zip = new JSZip();
  writeZipEntry(
    zip,
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  writeZipEntry(
    zip,
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
  );
  writeZipEntry(
    zip,
    "word/settings.xml",
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:attachedTemplate r:id="rId1"/></w:settings>',
  );
  writeZipEntry(
    zip,
    "word/_rels/settings.xml.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" ' +
      'Target="file:///C:/Templates/Contract.dotx" TargetMode="External"/>' +
      "</Relationships>",
  );
  return await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
};

beforeAll(async () => {
  fake = startFakeS3();
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    fake.stop();
    if (seededUploadIds.length > 0) {
      await testDb
        .delete(pendingUploads)
        .where(inArray(pendingUploads.id, seededUploadIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("presigned upload mutation flow", () => {
  test("a DOCX uploaded through create and finalize is cited by chat after extraction", async () => {
    const bytes = await docxWithMarkers([
      "API upload citation proof: the renewal date is 20 October 2030",
    ]);
    const presignResult = await presignUpload.handler(
      asTestRaw<PresignCtx>(
        createContext({
          body: {
            purpose: "entity_version",
            entityId: ids.entityA1,
            name: "api-upload-citation-proof.docx",
            mimeType: DOCX_MIME,
            size: bytes.byteLength,
            sha256Hex: hashSha256Hex(bytes),
          },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );
    const uploadId = getUploadId(presignResult);
    seededUploadIds.push(uploadId);
    const grant = readPresignedUpload(presignResult);
    expect(
      await fetch(grant.url, {
        method: "PUT",
        body: bytes,
        headers: grant.headers,
      }),
    ).toMatchObject({ status: 200 });

    const finalized = await finalizeUpload.handler(
      asTestRaw<FinalizeCtx>(
        createContext({
          params: { workspaceId: ids.wsA1, uploadId },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );
    if (!("finalizedResult" in finalized)) {
      throw new Error(`Upload did not finalize: ${JSON.stringify(finalized)}`);
    }
    const result = finalized.finalizedResult;
    if (result.type !== "entity_version") {
      throw new Error(`Expected an entity version, received ${result.type}`);
    }

    const run = (
      await testDb
        .select({ id: documentProcessingRuns.id })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.entityId, ids.entityA1),
            eq(documentProcessingRuns.entityVersionId, result.entityVersionId),
          ),
        )
        .orderBy(desc(documentProcessingRuns.createdAt))
        .limit(1)
    ).at(0);
    expect(run).toBeDefined();
    await processDocumentProcessingRun(
      executeRowsDatabase(testDb),
      run!.id,
      new AbortController().signal,
    );
    expect(
      await testDb
        .select({ entityId: extractedContent.entityId })
        .from(extractedContent)
        .where(eq(extractedContent.entityId, ids.entityA1)),
    ).toEqual([{ entityId: ids.entityA1 }]);
    expect(
      (
        await testDb
          .select({ text: searchDocuments.searchableText })
          .from(searchDocuments)
          .where(eq(searchDocuments.entityId, ids.entityA1))
      ).at(0)?.text,
    ).toContain("API upload citation proof");

    const fileField = (
      await testDb
        .select({ id: fields.id })
        .from(fields)
        .where(eq(fields.entityVersionId, result.entityVersionId))
        .limit(1)
    ).at(0);
    expect(fileField).toBeDefined();
    const scopedDb = executeRowsScopedDb(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    );
    const safeDb = executeRowsSafeDb(
      createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    );
    const harness = createApprovalHarness({
      ids,
      safeDb,
      scopedDb,
      sources: { contextMatterIds: [ids.wsA1] },
      testDb,
    });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    try {
      harness.script(threadId, [
        {
          finishReason: "stop",
          text: "The renewal date is [20 October 2030](#folio:api-upload-citation-proof).",
          type: "text",
        },
      ]);
      expect(
        await harness.send(
          harness.sendContext({
            activeFile: {
              entityId: ids.entityA1,
              fileFieldId: fileField!.id,
              fileName: result.fileName,
              supportsDocxEdits: false,
            },
            message: {
              id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
              parts: [{ content: "When is the renewal date?", type: "text" }],
              role: "user",
            },
            runId: `run-${Bun.randomUUIDv7()}`,
            threadId,
          }),
          { readAfterSettling: true },
        ),
      ).toEqual({ status: "streamed" });
      const answer = await harness.lastAssistant(threadId);
      expect(
        answer.parts.some(
          (part) =>
            part.type === "text" &&
            part.content.includes("[20 October 2030](#folio:"),
        ),
      ).toBe(true);
    } finally {
      await harness.close();
    }
  });

  test("presigns an agent skill for an authorized owner", async () => {
    const presignResult = await presignUpload.handler(
      asTestRaw<PresignCtx>(
        createContext({
          body: {
            purpose: "agent_skill",
            scope: "private",
            name: "review.skill.md",
            mimeType: "text/markdown",
            size: 12,
            sha256Hex:
              "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );
    const uploadId = getUploadId(presignResult);
    seededUploadIds.push(uploadId);

    expect(
      await testDb.query.pendingUploads.findFirst({
        where: { id: { eq: uploadId } },
        columns: { purpose: true, purposeData: true, status: true },
      }),
    ).toEqual({
      purpose: "agent_skill",
      purposeData: { type: "agent_skill", scope: "private" },
      status: "pending",
    });
  });

  test("persists upload intent, aborts it, then replays the terminal rejection on finalize", async () => {
    const body = {
      purpose: "entity_version" as const,
      entityId: ids.entityA1,
      name: "evidence.pdf",
      mimeType: "application/pdf",
      size: 12,
      sha256Hex:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    const presignResult = await presignUpload.handler(
      asTestRaw<PresignCtx>(
        createContext({
          body,
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );
    const uploadId = getUploadId(presignResult);
    seededUploadIds.push(uploadId);

    expect(
      await testDb.query.pendingUploads.findFirst({
        where: { id: { eq: uploadId } },
        columns: {
          declaredName: true,
          purpose: true,
          status: true,
          workspaceId: true,
        },
      }),
    ).toMatchObject({
      declaredName: "evidence.pdf",
      purpose: "entity_version",
      status: "pending",
      workspaceId: ids.wsA1,
    });

    // Step 2 of the flow, against the real store: the client PUTs the bytes
    // to the URL the API signed, with the headers it committed to.
    const grant = readPresignedUpload(presignResult);
    const staged = await fetch(grant.url, {
      method: "PUT",
      body: new TextEncoder().encode("twelve bytes"),
      headers: grant.headers,
    });
    expect(staged.status).toBe(200);
    const stagedKey = new URL(grant.url).pathname.slice(
      `/${envBase.S3_BUCKET}/`.length,
    );
    expect(fake.objects.get(`${envBase.S3_BUCKET}/${stagedKey}`)).toMatchObject(
      { contentType: "application/pdf" },
    );
    // A pre-scoped-signing row would have staged under the legacy key; the
    // abort has to reclaim that slot too.
    fake.put(envBase.S3_BUCKET, legacyTmpUploadKey(uploadId), "stale bytes");

    const abortResult = await abortUpload.handler(
      asTestRaw<AbortCtx>(
        createContext({
          params: { workspaceId: ids.wsA1, uploadId },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );

    expect(abortResult).toEqual({ ok: true });
    expect(
      await testDb.query.pendingUploads.findFirst({
        where: { id: { eq: uploadId } },
        columns: { rejectReason: true, status: true },
      }),
    ).toEqual({
      rejectReason: "Aborted by client",
      status: "rejected",
    });
    // Both staging slots the upload could occupy are back.
    expect(
      [...fake.objects.keys()].filter((key) => key.includes(uploadId)),
    ).toEqual([]);

    const finalizeResult = await finalizeUpload.handler(
      asTestRaw<FinalizeCtx>(
        createContext({
          params: { workspaceId: ids.wsA1, uploadId },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );

    expect(finalizeResult).toEqual({
      code: 422,
      response: { message: "Aborted by client" },
    });
  });

  test("replays structured file-security rejection details after finalize", async () => {
    const bytes = await makeAttachedTemplateDocx();
    const presignResult = await presignUpload.handler(
      asTestRaw<PresignCtx>(
        createContext({
          body: {
            purpose: "entity_version",
            entityId: ids.entityA1,
            name: "attached-template.docx",
            mimeType: DOCX_MIME,
            size: bytes.byteLength,
            sha256Hex: hashSha256Hex(bytes),
          },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );
    const uploadId = getUploadId(presignResult);
    seededUploadIds.push(uploadId);

    const grant = readPresignedUpload(presignResult);
    const staged = await fetch(grant.url, {
      method: "PUT",
      body: bytes,
      headers: grant.headers,
    });
    expect(staged.status).toBe(200);

    const finalizeContext = () =>
      asTestRaw<FinalizeCtx>(
        createContext({
          params: { workspaceId: ids.wsA1, uploadId },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      );
    const firstFinalize = await finalizeUpload.handler(finalizeContext());
    const replayedFinalize = await finalizeUpload.handler(finalizeContext());
    const rejectionDetails = {
      code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
      hint: "Remove the attached Word template link and its source reference, then upload the sanitized copy.",
      issues: [
        {
          code: ATTACHED_TEMPLATE_SECURITY_RULE,
          message: ATTACHED_TEMPLATE_MESSAGE,
          path: "file",
          remediation: FILE_SECURITY_REMEDIATION.removeAttachedTemplate,
        },
      ],
    } satisfies ApiFileSecurityRejectionDetails;

    expect(firstFinalize).toEqual({
      code: 422,
      response: {
        message: ATTACHED_TEMPLATE_REJECTION_MESSAGE,
        ...rejectionDetails,
      },
    });
    expect(replayedFinalize).toEqual(firstFinalize);
    expect(
      await testDb.query.pendingUploads.findFirst({
        where: { id: { eq: uploadId } },
        columns: { rejectReason: true, rejectionDetails: true, status: true },
      }),
    ).toEqual({
      rejectReason: ATTACHED_TEMPLATE_REJECTION_MESSAGE,
      rejectionDetails,
      status: "rejected",
    });
    expect(
      [...fake.objects.keys()].filter((key) => key.includes(uploadId)),
    ).toEqual([]);
  });

  test("does not claim an upload while it waits for finalize admission", async () => {
    const recording = installRecordingLogger();
    try {
      const bytes = await makeAttachedTemplateDocx();
      const presignResult = await presignUpload.handler(
        asTestRaw<PresignCtx>(
          createContext({
            body: {
              purpose: "entity_version",
              entityId: ids.entityA1,
              name: "admission-wait.docx",
              mimeType: DOCX_MIME,
              size: bytes.byteLength,
              sha256Hex: hashSha256Hex(bytes),
            },
            workspaceId: ids.wsA1,
            organizationId: ids.orgA,
            userId: ids.userA1,
          }),
        ),
      );
      const uploadId = getUploadId(presignResult);
      seededUploadIds.push(uploadId);
      const grant = readPresignedUpload(presignResult);
      const staged = await fetch(grant.url, {
        method: "PUT",
        body: bytes,
        headers: grant.headers,
      });
      expect(staged.status).toBe(200);

      // Fill the whole budget so the finalization below has to wait.
      const holdBudget = await UPLOAD_FINALIZE_ADMISSION.acquire(
        LIMITS.uploadFinalizeInFlightBytes,
        0,
      );
      if (holdBudget === null) {
        throw new Error(
          "Expected the idle admission budget to admit the hold.",
        );
      }
      let finalizeSettled = false;
      const finalizing = finalizeUpload
        .handler(
          asTestRaw<FinalizeCtx>(
            createContext({
              params: { workspaceId: ids.wsA1, uploadId },
              workspaceId: ids.wsA1,
              organizationId: ids.orgA,
              userId: ids.userA1,
            }),
          ),
        )
        .finally(() => {
          finalizeSettled = true;
        });

      try {
        await Bun.sleep(200);
        expect(finalizeSettled).toBe(false);
        expect(
          recording.records.filter(
            ({ message }) => message === "uploads.finalize_admitted",
          ),
        ).toEqual([]);
        expect(
          await testDb.query.pendingUploads.findFirst({
            where: { id: { eq: uploadId } },
            columns: {
              claimedAt: true,
              claimedByRequestId: true,
              status: true,
            },
          }),
        ).toEqual({
          claimedAt: null,
          claimedByRequestId: null,
          status: "pending",
        });
      } finally {
        holdBudget();
      }

      const finalized = await finalizing;
      expect(finalized).toMatchObject({ code: 422 });
      expect(UPLOAD_FINALIZE_ADMISSION.inUseBytes()).toBe(0);
      expect(
        recording.records.filter(
          ({ message }) => message === "uploads.finalize_admitted",
        ),
      ).toEqual([
        {
          severityText: "INFO",
          message: "uploads.finalize_admitted",
          attributes: {
            declaredBytes: bytes.byteLength,
            inFlightBytes: bytes.byteLength,
          },
        },
      ]);

      // The stored result replays at once even while the budget is full.
      const holdAgain = await UPLOAD_FINALIZE_ADMISSION.acquire(
        LIMITS.uploadFinalizeInFlightBytes,
        0,
      );
      if (holdAgain === null) {
        throw new Error(
          "Expected the idle admission budget to admit the hold.",
        );
      }
      try {
        const startedAt = performance.now();
        const replayed = await finalizeUpload.handler(
          asTestRaw<FinalizeCtx>(
            createContext({
              params: { workspaceId: ids.wsA1, uploadId },
              workspaceId: ids.wsA1,
              organizationId: ids.orgA,
              userId: ids.userA1,
            }),
          ),
        );
        expect(replayed).toEqual(finalized);
        expect(
          recording.records.filter(
            ({ message }) => message === "uploads.finalize_admitted",
          ),
        ).toHaveLength(1);
        expect(performance.now() - startedAt).toBeLessThan(
          LIMITS.uploadFinalizeAdmissionWaitMs,
        );
      } finally {
        holdAgain();
      }
    } finally {
      recording.restore();
    }
  });

  test("rejects a rule match deep inside a large document and stores nothing", async () => {
    const bytes = await largeDocx({
      trailer:
        "<w:p><w:r><w:instrText>DDEAUTO marker</w:instrText></w:r></w:p>",
    });
    const presignResult = await presignUpload.handler(
      asTestRaw<PresignCtx>(
        createContext({
          body: {
            purpose: "entity_version",
            entityId: ids.entityA1,
            name: "large.docx",
            mimeType: DOCX_MIME,
            size: bytes.byteLength,
            sha256Hex: hashSha256Hex(bytes),
          },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );
    const uploadId = getUploadId(presignResult);
    seededUploadIds.push(uploadId);

    const grant = readPresignedUpload(presignResult);
    const staged = await fetch(grant.url, {
      method: "PUT",
      body: bytes,
      headers: grant.headers,
    });
    expect(staged.status).toBe(200);

    const finalized = await finalizeUpload.handler(
      asTestRaw<FinalizeCtx>(
        createContext({
          params: { workspaceId: ids.wsA1, uploadId },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );

    expect(finalized).toMatchObject({
      code: 422,
      response: {
        code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
        issues: [{ code: "ooxml_dde", path: "file" }],
      },
    });
    expect(
      await testDb.query.pendingUploads.findFirst({
        where: { id: { eq: uploadId } },
        columns: { status: true },
      }),
    ).toEqual({ status: "rejected" });
    expect(
      [...fake.objects.keys()].filter((key) => key.includes(uploadId)),
    ).toEqual([]);
  });

  test("does not let workspace A abort workspace B upload IDs", async () => {
    const uploadId = createSafeId<"pendingUpload">();
    await testDb.insert(pendingUploads).values({
      id: uploadId,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      userId: ids.userB1,
      purpose: "entity_version",
      purposeData: { type: "entity_version", entityId: ids.entityB1 },
      declaredName: "tenant-b.pdf",
      declaredMime: "application/pdf",
      declaredSize: 12,
      declaredSha256:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    seededUploadIds.push(uploadId);

    const result = await abortUpload.handler(
      asTestRaw<AbortCtx>(
        createContext({
          params: { workspaceId: ids.wsA1, uploadId },
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
        }),
      ),
    );

    expect(result).toEqual({
      code: 404,
      response: { message: "Upload not found" },
    });
    expect(
      await testDb
        .select({ status: pendingUploads.status })
        .from(pendingUploads)
        .where(eq(pendingUploads.id, uploadId)),
    ).toEqual([{ status: "pending" }]);
  });
});

describe("presigned upload finalize lifecycle", () => {
  test("finalizes an upload whose PUT ran from its URL's expiry to the longest client PUT", async () => {
    const { uploadId } = await stageDocxVersion("long-put.docx");
    // The PUT started just before the URL expired and ran for the full
    // client budget: shift the reservation back by exactly that much.
    const elapsedMs =
      PRESIGN_URL_EXPIRY_SECONDS * 1000 + DOCUMENT_UPLOAD_PUT_TIMEOUT_MS;
    await testDb
      .update(pendingUploads)
      .set({
        createdAt: sql`${pendingUploads.createdAt} - ${elapsedMs} * interval '1 millisecond'`,
        expiresAt: sql`${pendingUploads.expiresAt} - ${elapsedMs} * interval '1 millisecond'`,
      })
      .where(eq(pendingUploads.id, uploadId));

    const finalized = await finalizeAsOwner(uploadId);

    expect(finalized).toHaveProperty("finalizedResult.type", "entity_version");
    expect(await uploadStatus(uploadId)).toBe("finalized");
  });

  test("replays a finalized upload's result without creating another version", async () => {
    const { uploadId } = await stageDocxVersion("replayed.docx");
    const first = await finalizeAsOwner(uploadId);
    expect(first).toHaveProperty("finalizedResult.type", "entity_version");
    const versionsAfterFirst = await versionCount(ids.entityA1);

    const replayed = await finalizeAsOwner(uploadId);

    expect(replayed).toEqual(first);
    expect(await versionCount(ids.entityA1)).toBe(versionsAfterFirst);
  });

  test("a storage failure while reading the staged object leaves the upload retryable", async () => {
    const { uploadId, stagedKey } = await stageDocxVersion("head-outage.docx");
    // Expired credentials answer the HEAD; the store says nothing about
    // whether the object exists.
    fake.failNext({
      method: "HEAD",
      key: stagedKey,
      code: "AccessDenied",
      status: 403,
    });

    const failed = await finalizeAsOwner(uploadId);

    expect(failed).toMatchObject({ code: 500 });
    expect(await uploadStatus(uploadId)).toBe("failed");
    expect(fake.objects.has(`${envBase.S3_BUCKET}/${stagedKey}`)).toBe(true);

    // Past the claim cool-down the same upload finalizes from the kept bytes.
    await testDb
      .update(pendingUploads)
      .set({
        claimedAt: sql`now() - ${FINALIZE_CLAIM_TIMEOUT_MS + 1000} * interval '1 millisecond'`,
      })
      .where(eq(pendingUploads.id, uploadId));
    const retried = await finalizeAsOwner(uploadId);

    expect(retried).toHaveProperty("finalizedResult.type", "entity_version");
    expect(await uploadStatus(uploadId)).toBe("finalized");
  });

  test("rejects an upload whose staged object the store confirms is absent", async () => {
    const presignResult = await presignDocxVersion(
      "never-put.docx",
      await docxWithMarkers(["Never staged"]),
    );
    const uploadId = getUploadId(presignResult);

    const rejected = await finalizeAsOwner(uploadId);

    expect(rejected).toMatchObject({ code: 404 });
    expect(await uploadStatus(uploadId)).toBe("rejected");
  });

  test.each([
    {
      owner: "another workspace",
      seed: () => ({
        organizationId: ids.orgB,
        workspaceId: ids.wsB1,
        userId: ids.userB1,
        entityId: ids.entityB1,
      }),
    },
    {
      owner: "another user in the same workspace",
      seed: () => ({
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA2,
        entityId: ids.entityA1,
      }),
    },
  ])("does not finalize an upload that belongs to $owner", async ({ seed }) => {
    const owner = seed();
    const uploadId = createSafeId<"pendingUpload">();
    await testDb.insert(pendingUploads).values({
      id: uploadId,
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      purpose: "entity_version",
      purposeData: { type: "entity_version", entityId: owner.entityId },
      declaredName: "not-yours.pdf",
      declaredMime: "application/pdf",
      declaredSize: 12,
      declaredSha256:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    seededUploadIds.push(uploadId);

    const result = await finalizeAsOwner(uploadId);

    expect(result).toEqual({
      code: 404,
      response: { message: "Upload not found" },
    });
    expect(
      await testDb.query.pendingUploads.findFirst({
        where: { id: { eq: uploadId } },
        columns: { claimedAt: true, status: true },
      }),
    ).toEqual({ claimedAt: null, status: "pending" });
  });
});

const presignDocxVersion = async (
  name: string,
  bytes: Uint8Array,
): Promise<unknown> => {
  const presignResult = await presignUpload.handler(
    asTestRaw<PresignCtx>(
      createContext({
        body: {
          purpose: "entity_version",
          entityId: ids.entityA1,
          name,
          mimeType: DOCX_MIME,
          size: bytes.byteLength,
          sha256Hex: hashSha256Hex(bytes),
        },
        workspaceId: ids.wsA1,
        organizationId: ids.orgA,
        userId: ids.userA1,
      }),
    ),
  );
  seededUploadIds.push(getUploadId(presignResult));
  return presignResult;
};

/** Reserve a DOCX version upload for user A1 and PUT its bytes to the store. */
const stageDocxVersion = async (
  name: string,
): Promise<{ uploadId: SafeId<"pendingUpload">; stagedKey: string }> => {
  const bytes = await docxWithMarkers([`Staged for ${name}`]);
  const presignResult = await presignDocxVersion(name, bytes);
  const grant = readPresignedUpload(presignResult);
  const staged = await fetch(grant.url, {
    method: "PUT",
    body: bytes,
    headers: grant.headers,
  });
  expect(staged.status).toBe(200);
  return {
    uploadId: getUploadId(presignResult),
    stagedKey: new URL(grant.url).pathname.slice(
      `/${envBase.S3_BUCKET}/`.length,
    ),
  };
};

const finalizeAsOwner = async (
  uploadId: SafeId<"pendingUpload">,
): Promise<unknown> =>
  await finalizeUpload.handler(
    asTestRaw<FinalizeCtx>(
      createContext({
        params: { workspaceId: ids.wsA1, uploadId },
        workspaceId: ids.wsA1,
        organizationId: ids.orgA,
        userId: ids.userA1,
      }),
    ),
  );

const uploadStatus = async (
  uploadId: SafeId<"pendingUpload">,
): Promise<string | undefined> =>
  (
    await testDb.query.pendingUploads.findFirst({
      where: { id: { eq: uploadId } },
      columns: { status: true },
    })
  )?.status;

const versionCount = async (entityId: SafeId<"entity">): Promise<number> =>
  (
    await testDb
      .select({ value: count() })
      .from(entityVersions)
      .where(eq(entityVersions.entityId, entityId))
  ).at(0)?.value ?? 0;

type TestContextOptions = {
  body?: unknown;
  organizationId: SafeId<"organization">;
  params?: unknown;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const createContext = ({
  body,
  organizationId,
  params,
  userId,
  workspaceId,
}: TestContextOptions) => {
  const scopedDb = createScopedDb(
    testDb,
    [workspaceId],
    organizationId,
    userId,
  );
  const safeDb = createSafeDb(testDb, [workspaceId], organizationId, userId);

  return {
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [
      { id: workspaceId, status: "active" },
    ],
    getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
    body,
    createAuditRecorder: () => async () => undefined,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
    params,
    promptCachingEnabled: false,
    recordAuditEvent: async () => undefined,
    request: new Request(`https://example.test/workspaces/${workspaceId}`),
    route: "/v1/uploads/:workspaceId/presign" satisfies ApiRoutePath,
    safeDb,
    scopedDb,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  };
};

const getUploadId = (result: unknown): SafeId<"pendingUpload"> => {
  if (
    typeof result === "object" &&
    result !== null &&
    "uploadId" in result &&
    typeof result.uploadId === "string"
  ) {
    return toSafeId<"pendingUpload">(result.uploadId);
  }

  throw new Error("Expected presign result to include an uploadId.");
};

type PresignedUpload = {
  url: string;
  headers: Record<string, string>;
};

const isHeaderRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every((header) => typeof header === "string");

const readPresignedUpload = (result: unknown): PresignedUpload => {
  if (
    typeof result === "object" &&
    result !== null &&
    "url" in result &&
    typeof result.url === "string" &&
    "headers" in result &&
    isHeaderRecord(result.headers)
  ) {
    return { url: result.url, headers: result.headers };
  }

  throw new Error("Expected presign result to include a url and headers.");
};
