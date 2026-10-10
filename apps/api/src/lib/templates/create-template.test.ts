import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  bufferObjectCleanupIntents,
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
} from "@/api/db/schema";
import type { TemplateOrigin } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { scanUpload } from "@/api/lib/file-scan/scan-upload";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { docxWithMarkers } from "@/api/tests/helpers/docx-with-markers";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import { createStoredTemplate } from "./create-template";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
const originalFlag = env.FEATURE_FILE_USAGE_LIMITS;
const originalWorkerFlag =
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
beforeAll(async () => {
  fixture = await getRlsFixture();
  env.FEATURE_FILE_USAGE_LIMITS = false;
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = false;
});
afterAll(async () => {
  env.FEATURE_FILE_USAGE_LIMITS = originalFlag;
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = originalWorkerFlag;
  await releaseRlsFixture();
});
test("an exhausted scanned template write remains owned by recovery", async () => {
  const fake = startFakeS3();
  fake.failNext({
    method: "PUT",
    code: "AccessDenied",
    status: 403,
    times: 100,
  });
  try {
    const scanned = await scanUpload({
      bytes: await docxWithMarkers(["name"]),
      fileName: "created.docx",
      declaredMimeType: DOCX_MIME_TYPE,
    });
    if (Result.isError(scanned)) {
      throw scanned.error;
    }
    const result = await Result.tryPromise(
      async () =>
        await Result.gen(() =>
          createStoredTemplate({
            safeDb: asTestRaw<SafeDb>(
              createSafeDb(
                fixture.testDb,
                [],
                fixture.ids.orgA,
                fixture.ids.userA1,
              ),
            ),
            organizationId: fixture.ids.orgA,
            userId: fixture.ids.userA1,
            file: scanned.value,
            name: "Created",
            fileName: "created.docx",
            recordAuditEvent: async () => await Promise.resolve(),
          }),
        ),
    );
    expect(Result.isError(result) || Result.isError(result.value)).toBe(true);
    const key = fake.requests.find((request) => request.method === "PUT")?.key;
    if (!key) {
      throw new TypeError(
        `Template write did not reach store: ${JSON.stringify(result)}`,
      );
    }
    expect(key).toBeDefined();
    const intent = (
      await fixture.testDb
        .select()
        .from(bufferObjectCleanupIntents)
        .where(eq(bufferObjectCleanupIntents.objectKey, key))
    ).at(0);
    expect(intent?.status).toBe(BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING);
  } finally {
    fake.stop();
  }
});

test("a committed template refusal cleans its candidate and keeps the published template", async () => {
  const fake = startFakeS3();
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(fixture.testDb, [], fixture.ids.orgA, fixture.ids.userA1),
  );
  const scanned = await scanUpload({
    bytes: await docxWithMarkers(["name"]),
    fileName: "created.docx",
    declaredMimeType: DOCX_MIME_TYPE,
  });
  if (Result.isError(scanned)) {
    throw scanned.error;
  }
  const origin = {
    type: "bundled-pack",
    packId: `pack-${Bun.randomUUIDv7()}`,
    packVersion: "1",
    slug: "created",
    contentHash: "a".repeat(64),
    license: "MIT",
    authors: [],
  } as const satisfies TemplateOrigin;
  const create = async () =>
    await Result.gen(() =>
      createStoredTemplate({
        safeDb,
        organizationId: fixture.ids.orgA,
        userId: fixture.ids.userA1,
        file: scanned.value,
        name: "Created",
        fileName: "created.docx",
        recordAuditEvent: async () => await Promise.resolve(),
        origin,
      }),
    );
  try {
    const first = await create();
    if (Result.isError(first)) {
      throw first.error;
    }
    const publishedKey = fake.requests.find(
      (request) => request.method === "PUT",
    )?.key;
    if (publishedKey === undefined) {
      throw new Error("Expected the first create to publish its template");
    }
    const refused = await create();
    expect(Result.isError(refused)).toBe(true);
    if (Result.isError(refused)) {
      expect(refused.error.message).toBe(
        "This pack template is already installed",
      );
    }
    const candidateKey = fake.requests.findLast(
      (request) => request.method === "PUT",
    )?.key;
    if (candidateKey === undefined) {
      throw new Error("Expected the refused create to write its candidate");
    }
    expect(candidateKey).not.toBe(publishedKey);
    expect(fake.objects.has(`${envBase.S3_BUCKET}/${publishedKey}`)).toBe(true);
    expect(fake.objects.has(`${envBase.S3_BUCKET}/${candidateKey}`)).toBe(
      false,
    );
  } finally {
    fake.stop();
  }
});
