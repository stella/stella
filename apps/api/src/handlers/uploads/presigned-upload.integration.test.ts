import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { pendingUploads } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { createSafeId, toSafeId, type SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const deleteObjectMock = mock(async () => undefined);

const realS3 = await import("@/api/lib/s3");

void mock.module("@/api/lib/s3", () => ({
  ...realS3,
  getS3: () => ({
    delete: deleteObjectMock,
    file: () => ({
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  }),
}));

const { default: abortUpload } = await import("./abort");
const { default: finalizeUpload } = await import("./finalize");
const { default: presignUpload } = await import("./presign");

setDefaultTimeout(120_000);

type PresignCtx = Parameters<typeof presignUpload.handler>[0];
type AbortCtx = Parameters<typeof abortUpload.handler>[0];
type FinalizeCtx = Parameters<typeof finalizeUpload.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

const seededUploadIds: SafeId<"pendingUpload">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
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
    activeWorkspaceIds: [workspaceId],
    accessibleWorkspaces: [{ id: workspaceId, status: "active" }],
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
