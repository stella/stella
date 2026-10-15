/**
 * A document translation reads its source under its requester's current
 * access, so nothing from a matter the requester can no longer open reaches
 * the model. Driven against a real (PGlite) database and an in-process object
 * store; the model and the output document write are fakes.
 */

import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  documentTranslationRuns,
  documentTranslationUnits,
  workspaceMembers,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import {
  DD_REPORT_KEY,
  getBuiltinReportTemplate,
  initBuiltinReportTemplates,
} from "@/api/handlers/reports/builtin-templates";
import * as aiConfigLoader from "@/api/lib/ai-config-loader";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import * as translationAI from "@/api/lib/document-translation/ai";
import { processDocumentTranslationRun } from "@/api/lib/document-translation/run-queue";
import * as entityWriter from "@/api/lib/entities/create-from-buffer";
import { createFileKey } from "@/api/lib/files/utils";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedDocumentTranslationRunId } from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

setDefaultTimeout(120_000);

const BUCKET = process.env["S3_BUCKET"] ?? "stella";

await initBuiltinReportTemplates();
const { testDb, ids } = await getRlsFixture();
const database = asTestRaw<RlsDatabase<Transaction>>(testDb);
const fakeS3 = startFakeS3();

const originalOrganizationMember = (
  await testDb
    .select()
    .from(member)
    .where(eq(member.id, ids.memberA1org))
    .limit(1)
).at(0);
// Leaving the organization also ends every matter membership in it, so the
// restore covers all of them, not only the one a test removes directly.
const originalMatterMembers = await testDb.query.workspaceMembers.findMany({
  where: {
    userId: { eq: ids.userA1 },
    workspaceId: { in: [ids.wsA1, ids.wsA2] },
  },
});
const sourceDocument = getBuiltinReportTemplate(DD_REPORT_KEY);
if (
  !originalOrganizationMember ||
  originalMatterMembers.length === 0 ||
  sourceDocument?.kind !== "docx"
) {
  panic("Translation run fixture is incomplete");
}
const sourceKey = createFileKey({
  organizationId: ids.orgA,
  workspaceId: ids.wsA1,
  fileId: ids.fileObjectA1,
  mimeType: DOCX_MIME_TYPE,
});
fakeS3.put(
  BUCKET,
  sourceKey,
  new Uint8Array(await sourceDocument.loadBuffer()),
  DOCX_MIME_TYPE,
);

const runId = createSafeId<"documentTranslationRun">();
const actor = createRootRunActor(
  {
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    runId,
  },
  brandPersistedDocumentTranslationRunId,
  database,
);
const outputEntityId = createSafeId<"entity">();

const settingsSpy = spyOn(aiConfigLoader, "loadOrgAISettings");
const translateSpy = spyOn(translationAI, "translateTaggedSegments");
const writeSpy = spyOn(entityWriter, "createEntityFromBuffer");

const readRun = async () =>
  (
    await testDb
      .select()
      .from(documentTranslationRuns)
      .where(eq(documentTranslationRuns.id, runId))
      .limit(1)
  ).at(0);

const sourceReads = () =>
  fakeS3.requests.filter(
    (request) => request.method === "GET" && request.key === sourceKey,
  );

beforeEach(async () => {
  settingsSpy.mockReset();
  translateSpy.mockReset();
  writeSpy.mockReset();
  settingsSpy.mockImplementation(async () =>
    Result.ok({
      orgAIConfig: null,
      promptCachingEnabled: false,
      managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
    }),
  );
  translateSpy.mockImplementation(
    async ({ segments }) =>
      new Map(segments.map((segment) => [segment.id, segment.taggedText])),
  );
  writeSpy.mockImplementation(async (input) => {
    const created = {
      entityId: outputEntityId,
      entityVersionId: createSafeId<"entityVersion">(),
      fieldId: createSafeId<"field">(),
      fileName: input.fileName,
      renamed: false,
    };
    await input.scopedDb(async (tx) => await input.afterCreate?.(tx, created));
    return Result.ok(created);
  });
  fakeS3.requests.length = 0;
  await testDb.insert(documentTranslationRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    fileFieldId: ids.fileFieldA1,
    entityVersionId: ids.entityVersionA1,
    sourceFileId: toSafeId<"userFile">(ids.fileObjectA1),
    sourceFileName: "agreement-a.docx",
    sourceMimeType: DOCX_MIME_TYPE,
    output: "translated",
    engine: "ai",
    sourceLang: "en",
    targetLang: "cs",
    status: "queued",
    requestedBy: ids.userA1,
  });
});

afterEach(async () => {
  await testDb
    .delete(documentTranslationUnits)
    .where(eq(documentTranslationUnits.runId, runId));
  await testDb
    .delete(documentTranslationRuns)
    .where(eq(documentTranslationRuns.id, runId));
  await testDb
    .insert(member)
    .values(originalOrganizationMember)
    .onConflictDoNothing();
  await testDb
    .insert(workspaceMembers)
    .values(originalMatterMembers)
    .onConflictDoNothing();
});

afterAll(async () => {
  settingsSpy.mockRestore();
  translateSpy.mockRestore();
  writeSpy.mockRestore();
  fakeS3.stop();
  await releaseRlsFixture();
});

const expectStoppedBeforeReading = async () => {
  await processDocumentTranslationRun(
    actor,
    testModelAdmission(actor.organizationId),
  );
  const run = await readRun();
  expect(run).toMatchObject({
    status: "failed",
    errorCode: "document_unresolved",
    outputEntityId: null,
  });
  expect(run?.finishedAt).not.toBeNull();
  expect(sourceReads()).toEqual([]);
  expect(translateSpy).not.toHaveBeenCalled();
  expect(writeSpy).not.toHaveBeenCalled();
};

describe("document translation run", () => {
  test("a run stops when its requester no longer has access to the matter", async () => {
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA1));
    await expectStoppedBeforeReading();
  });

  test("a run stops when its requester has left the organization", async () => {
    await testDb.delete(member).where(eq(member.id, ids.memberA1org));
    await expectStoppedBeforeReading();
  });

  test("a run completes while its requester keeps access", async () => {
    await processDocumentTranslationRun(
      actor,
      testModelAdmission(actor.organizationId),
    );
    expect(await readRun()).toMatchObject({
      status: "completed",
      errorCode: null,
      outputEntityId,
    });
    expect(sourceReads()).toHaveLength(1);
    expect(translateSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
