import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  pendingUploads,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { finalizeEntityVersion } from "@/api/handlers/uploads/entity-version";
import { createSafeId } from "@/api/lib/branded-types";
import { scanUpload } from "@/api/lib/file-scan/scan-upload";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import { finalizeEntityCreate } from "./entity-create";
import { promoteTmpObjectWithUsage } from "./promote-tmp-object";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
const originalFlag = envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
beforeAll(async () => {
  fixture = await getRlsFixture();
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = false;
});
afterAll(async () => {
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = originalFlag;
  await releaseRlsFixture();
});

test.each(["copy", "write"] as const)(
  "an exhausted %s promotion retains cleanup ownership for its exact final key",
  async (promotion) => {
    const fake = startFakeS3();
    const finalKey = `${fixture.ids.orgA}/${fixture.ids.wsA1}/promotion-${Bun.randomUUIDv7()}.txt`;
    fake.failNext({
      method: promotion === "copy" ? "COPY" : "PUT",
      key: finalKey,
      code: "AccessDenied",
      status: 403,
      times: 100,
    });
    fake.put(envBase.S3_BUCKET, "tmp/source", "final bytes", "text/plain");
    try {
      const result = await promoteTmpObjectWithUsage({
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(
            fixture.testDb,
            [fixture.ids.wsA1],
            fixture.ids.orgA,
            fixture.ids.userA1,
          ),
        ),
        organizationId: fixture.ids.orgA,
        workspaceId: fixture.ids.wsA1,
        tmpKey: "tmp/source",
        finalKey,
        storedBytes: new TextEncoder().encode("final bytes"),
        declaredMime: "text/plain",
        promotion,
      });
      expect(Result.isError(result)).toBe(true);
      expect(
        fake.requests.some(
          (request) =>
            request.method === (promotion === "copy" ? "COPY" : "PUT") &&
            request.key === finalKey,
        ),
      ).toBe(true);
      const intent = (
        await fixture.testDb
          .select()
          .from(bufferObjectCleanupIntents)
          .where(eq(bufferObjectCleanupIntents.objectKey, finalKey))
      ).at(0);
      expect(intent?.status).toBe(
        BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
      );
      expect(intent?.attemptCount).toBe(0);
    } finally {
      fake.stop();
    }
  },
);

test.each([
  ["copy", "entity_create"],
  ["copy", "entity_version"],
  ["write", "entity_create"],
  ["write", "entity_version"],
] as const)(
  "a %s promotion retires ownership only with %s publication",
  async (promotion, purpose) => {
    const fake = startFakeS3();
    const { ids, testDb } = fixture;
    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    );
    const uploadId = createSafeId<"pendingUpload">();
    const requestId = Bun.randomUUIDv7();
    const bytes = new TextEncoder().encode("final bytes");
    const scanned = await scanUpload({
      bytes,
      fileName: "final.txt",
      declaredMimeType: "text/plain",
    });
    if (Result.isError(scanned)) {
      throw scanned.error;
    }
    await testDb.insert(pendingUploads).values({
      id: uploadId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      purpose,
      purposeData:
        purpose === "entity_create"
          ? { type: purpose, propertyId: ids.filePropertyA1 }
          : { type: purpose, entityId: ids.entityA1 },
      declaredName: "final.txt",
      declaredMime: "text/plain",
      declaredSize: bytes.byteLength,
      declaredSha256: "a".repeat(64),
      status: "scanning",
      claimedByRequestId: requestId,
      claimedAt: new Date(),
      expiresAt: new Date(Date.now() + 300_000),
    });
    const tmpKey = `${ids.orgA}/${ids.wsA1}/tmp/${uploadId}`;
    fake.put(envBase.S3_BUCKET, tmpKey, bytes, "text/plain");
    let finalKey: string | undefined;
    const domainArgs = {
      safeDb,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      recordAuditEvent: async () => await Promise.resolve(),
      declaredName: "final.txt",
      declaredMime: "text/plain",
      declaredSize: bytes.byteLength,
      declaredSha256Hex: "a".repeat(64),
      scanWarnings: undefined,
      uploadId,
      claimRequestId: requestId,
      promoteTmpObject: async (key: string) => {
        finalKey = key;
        return await promoteTmpObjectWithUsage({
          safeDb,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          tmpKey,
          finalKey: key,
          storedBytes: bytes,
          declaredMime: "text/plain",
          promotion,
        });
      },
    };
    try {
      const result = await Result.gen(async function* () {
        if (purpose === "entity_create") {
          return yield* finalizeEntityCreate({
            ...domainArgs,
            scanned: scanned.value,
            purposeData: {
              type: purpose,
              propertyId: ids.filePropertyA1,
              parentId: null,
            },
          });
        }
        return yield* finalizeEntityVersion({
          ...domainArgs,
          scanned: scanned.value,
          fileBuffer: bytes.buffer,
          purposeData: { type: purpose, entityId: ids.entityA1 },
        });
      });
      if (Result.isError(result)) {
        throw result.error;
      }
      expect(result.value.finalizedResult.type).toBe(purpose);
      expect(finalKey).toBeDefined();
      if (!finalKey) {
        throw new TypeError("Promotion must allocate a final key");
      }
      expect(fake.objects.has(`${envBase.S3_BUCKET}/${finalKey}`)).toBe(true);
      expect(
        await testDb
          .select()
          .from(bufferObjectCleanupIntents)
          .where(eq(bufferObjectCleanupIntents.objectKey, finalKey)),
      ).toEqual([]);
      expect(
        fake.requests.some(
          (request) => request.method === "DELETE" && request.key === finalKey,
        ),
      ).toBe(false);
    } finally {
      fake.stop();
    }
  },
);
