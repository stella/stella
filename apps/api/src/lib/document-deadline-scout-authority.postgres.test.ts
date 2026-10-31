import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import type { rootDb, Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  extractedContent,
  signals,
  workspaceMembers,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import * as contentEncryption from "@/api/lib/content-encryption";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { runDocumentDeadlineScout } from "@/api/lib/scouts/document-deadlines";
import * as modelTransport from "@/api/lib/tanstack-ai-generate";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: The RLS fixture migrates a real PostgreSQL database before the first case.
setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await releaseTestDb();
});

test("matter removal before model dispatch cancels deadline extraction", async () => {
  const runId = toSafeId<"documentProcessingRun">(Bun.randomUUIDv7());
  const quote = "The response is due by 2099-01-15.";
  const text = `${quote} ${"Synthetic clause text. ".repeat(40)}`;
  const encrypted = await contentEncryption.encryptContent(ids.orgA, text);
  const fixtureExtraction = await testDb
    .delete(extractedContent)
    .where(eq(extractedContent.entityId, ids.entityA1))
    .returning();
  await testDb.insert(documentProcessingRuns).values({
    id: runId,
    entityId: ids.entityA1,
    entityVersionId: ids.entityVersionA1,
    fieldId: ids.fileFieldA1,
    kind: "ocr",
    organizationId: ids.orgA,
    processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
    requestedBy: ids.userA1,
    requestSource: "upload",
    sourceFileId: ids.fileObjectA1,
    sourceSha256Hex: "c".repeat(64),
    workspaceId: ids.wsA1,
    status: "succeeded",
    finishedAt: new Date(),
    deadlineScoutStatus: "pending",
  });
  await testDb.insert(extractedContent).values({
    charCount: text.length,
    ciphertext: encrypted.ciphertext,
    entityId: ids.entityA1,
    extractedAt: new Date(),
    iv: encrypted.iv,
    ocrPayloadCiphertext: Buffer.from("synthetic-ocr-payload"),
    ocrPayloadIv: Buffer.from("synthetic-ocr-iv"),
    ocrProcessorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
    ocrRunId: runId,
    organizationId: ids.orgA,
    sourceEntityVersionId: ids.entityVersionA1,
    sourceFieldId: ids.fileFieldA1,
    sourceFileId: ids.fileObjectA1,
    sourceSha256Hex: "c".repeat(64),
    workspaceId: ids.wsA1,
  });

  const originalDecrypt = contentEncryption.decryptContent;
  let removedMemberships: (typeof workspaceMembers.$inferSelect)[] = [];
  const decryptSpy = spyOn(
    contentEncryption,
    "decryptContent",
  ).mockImplementation(async (organizationId, ciphertext, iv) => {
    removedMemberships = await testDb
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ids.wsA1),
          eq(workspaceMembers.userId, ids.userA1),
        ),
      )
      .returning();
    return await originalDecrypt(organizationId, ciphertext, iv);
  });
  const modelSpy = spyOn(
    modelTransport,
    "generateTanStackObjectForTask",
  ).mockImplementation(
    asTestRaw<typeof modelTransport.generateTanStackObjectForTask>(
      async () => ({
        deadlines: [
          {
            confidence: 0.99,
            dueDate: "2099-01-15",
            label: "Synthetic response",
            quote,
          },
        ],
      }),
    ),
  );

  try {
    await Result.tryPromise(
      async () =>
        await runDocumentDeadlineScout({
          db: asTestRaw<typeof rootDb>(testDb),
          database: asTestRaw<RlsDatabase<Transaction>>(testDb),
          sourceRunId: runId,
          admit: async ({ run }) =>
            await Result.tryPromise({
              try: async () =>
                await run(new AbortController().signal, {
                  reservePeriod: async () =>
                    await Promise.resolve(Result.ok(undefined)),
                }),
              catch: (cause: unknown) => cause,
            }),
        }),
    );

    expect(removedMemberships).toHaveLength(1);
    expect(modelSpy).not.toHaveBeenCalled();
    expect(
      await testDb
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.title, "Synthetic response due 2099-01-15")),
    ).toEqual([]);
  } finally {
    decryptSpy.mockRestore();
    modelSpy.mockRestore();
    if (removedMemberships.length > 0) {
      await testDb.insert(workspaceMembers).values(removedMemberships);
    }
    await testDb
      .delete(extractedContent)
      .where(eq(extractedContent.entityId, ids.entityA1));
    if (fixtureExtraction.length > 0) {
      await testDb.insert(extractedContent).values(fixtureExtraction);
    }
    await testDb
      .delete(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, runId));
  }
});
