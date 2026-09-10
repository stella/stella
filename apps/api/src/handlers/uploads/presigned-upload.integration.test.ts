import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import JSZip from "jszip";

import {
  API_FILE_SECURITY_REJECTED_ERROR_CODE,
  FILE_SECURITY_REMEDIATION,
} from "@stll/api-contract";
import type { ApiFileSecurityRejectionDetails } from "@stll/api-contract";
import { ATTACHED_TEMPLATE_SECURITY_RULE } from "@stll/docx-utils";

import { pendingUploads } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { createSafeId, toSafeId, type SafeId } from "@/api/lib/branded-types";
import { legacyTmpUploadKey } from "@/api/lib/uploads/runtime";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
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
  "Document contains an external Word template link " +
  "(potential template injection)";
const ATTACHED_TEMPLATE_REJECTION_MESSAGE =
  `File rejected by security rule ${ATTACHED_TEMPLATE_SECURITY_RULE}: ` +
  ATTACHED_TEMPLATE_MESSAGE;

const makeAttachedTemplateDocx = async (): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
  );
  zip.file(
    "word/settings.xml",
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:attachedTemplate r:id="rId1"/></w:settings>',
  );
  zip.file(
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
            sha256Hex: new Bun.CryptoHasher("sha256")
              .update(bytes)
              .digest("hex"),
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
    memberRole: { role: "owner" },
    orgAIConfig: null,
    params,
    promptCachingEnabled: false,
    recordAuditEvent: async () => undefined,
    request: new Request(`https://example.test/workspaces/${workspaceId}`),
    route: "/test/uploads",
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
