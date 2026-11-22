import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { dbClock } from "@stll/test-kit/db";

import type { rootDb, Transaction } from "@/api/db/root";
import {
  documentNamingRuns,
  documentProcessingRuns,
  entities,
  extractedContent,
  organizationSettings,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import {
  DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
  DOCUMENT_OCR_PROCESSOR_VERSION,
} from "@/api/lib/document-processing-contract";
import * as modelTransport from "@/api/lib/tanstack-ai-generate";
import { dispatchDocumentNaming } from "@/api/lib/uploads/document-naming/dispatch";
import { runDocumentNaming } from "@/api/lib/uploads/document-naming/document-naming";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: The RLS fixture migrates a database before the first case.
setDefaultTimeout(120_000);

const UPLOADED_NAME = "scan 0042.pdf";
const TEXT = `Share purchase agreement between Alpha s.r.o. and Beta a.s. ${"Clause text. ".repeat(20)}`;

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  const encrypted = await encryptContent(ids.orgA, TEXT);
  await testDb
    .delete(extractedContent)
    .where(eq(extractedContent.entityId, ids.entityA1));
  await testDb.insert(extractedContent).values({
    charCount: TEXT.length,
    ciphertext: encrypted.ciphertext,
    entityId: ids.entityA1,
    extractedAt: dbClock.now(),
    iv: encrypted.iv,
    organizationId: ids.orgA,
    sourceEntityVersionId: ids.entityVersionA1,
    sourceFieldId: ids.fileFieldA1,
    sourceFileId: ids.fileObjectA1,
    sourceSha256Hex: "c".repeat(64),
    workspaceId: ids.wsA1,
  });
});

afterAll(async () => {
  await releaseTestDb();
});

const runs: ReturnType<typeof toSafeId<"documentProcessingRun">>[] = [];

const completedRun = async (
  kind: "native-extraction" | "ocr" = "native-extraction",
) => {
  const id = toSafeId<"documentProcessingRun">(Bun.randomUUIDv7());
  runs.push(id);
  await testDb.insert(documentProcessingRuns).values({
    entityId: ids.entityA1,
    entityVersionId: ids.entityVersionA1,
    fieldId: ids.fileFieldA1,
    finishedAt: dbClock.now(),
    id,
    kind,
    organizationId: ids.orgA,
    processorVersion:
      kind === "ocr"
        ? DOCUMENT_OCR_PROCESSOR_VERSION
        : DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
    requestedBy: ids.userA1,
    requestSource: "upload",
    sourceFileId: ids.fileObjectA1,
    sourceSha256Hex: "c".repeat(64),
    status: "succeeded",
    workspaceId: ids.wsA1,
  });
  return {
    entityId: ids.entityA1,
    entityVersionId: ids.entityVersionA1,
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
  };
};

const optIn = async (pattern: string | null, enabled: boolean) => {
  await testDb
    .update(organizationSettings)
    .set({ documentNamePattern: pattern })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  await testDb
    .update(workspaces)
    .set({ documentNamingEnabled: enabled })
    .where(eq(workspaces.id, ids.wsA1));
};

const nameOf = async () =>
  (
    await testDb
      .select({ name: entities.name })
      .from(entities)
      .where(eq(entities.id, ids.entityA1))
  ).at(0)?.name;

const namingStatus = async (id: string) =>
  (
    await testDb
      .select({ status: documentNamingRuns.status })
      .from(documentNamingRuns)
      .where(eq(documentNamingRuns.id, toSafeId<"documentProcessingRun">(id)))
  ).at(0)?.status;

const admit: Parameters<typeof runDocumentNaming>[0]["admit"] = async ({
  run,
}) =>
  await Result.tryPromise({
    try: async () =>
      await run(new AbortController().signal, {
        reservePeriod: async () => await Promise.resolve(Result.ok(undefined)),
      }),
    catch: (cause: unknown) => cause,
  });

const run = async (
  sourceRunId: ReturnType<typeof toSafeId<"documentProcessingRun">>,
) => {
  const outcome = await runDocumentNaming({
    db: asTestRaw<typeof rootDb>(testDb),
    database: asTestRaw<RlsDatabase<Transaction>>(testDb),
    sourceRunId,
    admit,
  });
  expect(Result.isOk(outcome)).toBe(true);
};

let modelSpy: ReturnType<
  typeof spyOn<typeof modelTransport, "generateTanStackObjectForTask">
>;

beforeEach(async () => {
  await testDb
    .update(entities)
    .set({ name: UPLOADED_NAME })
    .where(eq(entities.id, ids.entityA1));
  modelSpy = spyOn(
    modelTransport,
    "generateTanStackObjectForTask",
  ).mockImplementation(
    asTestRaw<typeof modelTransport.generateTanStackObjectForTask>(
      async () => ({
        date: "2026-03-14",
        docType: "Contract",
        title: "Share purchase agreement",
      }),
    ),
  );
});

afterEach(async () => {
  mock.restore();
  for (const id of runs.splice(0)) {
    await testDb
      .delete(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, id));
  }
});

test("a matter that has not opted in gets no naming run", async () => {
  await optIn("{date}_{title}", false);
  expect(
    await dispatchDocumentNaming(
      asTestRaw<typeof rootDb>(testDb),
      await completedRun(),
    ),
  ).toBe(false);
});

test("an organization without a pattern gets no naming run", async () => {
  await optIn(null, true);
  expect(
    await dispatchDocumentNaming(
      asTestRaw<typeof rootDb>(testDb),
      await completedRun(),
    ),
  ).toBe(false);
});

test("a new upload is renamed to the pattern once", async () => {
  await optIn("{date}_{matterNumber}_{docType}_{title}", true);
  const source = await completedRun();
  const db = asTestRaw<typeof rootDb>(testDb);
  expect(await dispatchDocumentNaming(db, source)).toBe(true);
  // A later OCR run of the same version does not name it again.
  expect(await dispatchDocumentNaming(db, await completedRun("ocr"))).toBe(
    false,
  );

  await run(source.id);

  expect(await nameOf()).toBe(
    "2026-03-14_REF-A1_Contract_Share purchase agreement.pdf",
  );
  expect(await namingStatus(source.id)).toBe("succeeded");
});

test("a rename since the upload wins", async () => {
  await optIn("{date}_{title}", true);
  const source = await completedRun();
  expect(
    await dispatchDocumentNaming(asTestRaw<typeof rootDb>(testDb), source),
  ).toBe(true);
  await testDb
    .update(entities)
    .set({ name: "Signed SPA.pdf" })
    .where(eq(entities.id, ids.entityA1));

  await run(source.id);

  expect(await nameOf()).toBe("Signed SPA.pdf");
  expect(await namingStatus(source.id)).toBe("cancelled");
});

test("a matter that opted out before the run keeps the uploaded name", async () => {
  await optIn("{date}_{title}", true);
  const source = await completedRun();
  expect(
    await dispatchDocumentNaming(asTestRaw<typeof rootDb>(testDb), source),
  ).toBe(true);
  await optIn("{date}_{title}", false);

  await run(source.id);

  expect(modelSpy).not.toHaveBeenCalled();
  expect(await nameOf()).toBe(UPLOADED_NAME);
  expect(await namingStatus(source.id)).toBe("cancelled");
});
