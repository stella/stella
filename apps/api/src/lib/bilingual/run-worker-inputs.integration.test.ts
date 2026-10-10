/**
 * A bilingual run reads the document it fills under its requester's current
 * access, so nothing from a matter the requester can no longer open reaches
 * the model. Driven against a real (PGlite) database and an in-process object
 * store; the model and the version write are fakes.
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
  bilingualTranslationRows,
  bilingualTranslationRuns,
  workspaceMembers,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import {
  DD_REPORT_KEY,
  getBuiltinReportTemplate,
  initBuiltinReportTemplates,
} from "@/api/handlers/reports/builtin-templates";
import * as aiConfigLoader from "@/api/lib/ai-config-loader";
import * as bilingualAI from "@/api/lib/bilingual/ai";
import { processBilingualRun } from "@/api/lib/bilingual/run-queue";
import { createSafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import * as versionWriter from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import { createFileKey } from "@/api/lib/files/utils";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedBilingualTranslationRunId } from "@/api/lib/safe-id-boundaries";
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
  panic("Bilingual run fixture is incomplete");
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

const runId = createSafeId<"bilingualTranslationRun">();
const actor = createRootRunActor(
  {
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    runId,
  },
  brandPersistedBilingualTranslationRunId,
  database,
);
const outputVersionId = createSafeId<"entityVersion">();

const settingsSpy = spyOn(aiConfigLoader, "loadOrgAISettings");
const translateSpy = spyOn(bilingualAI, "translateBatch");
const writeSpy = spyOn(versionWriter, "createEntityVersionFromBuffer");

const readRun = async () =>
  (
    await testDb
      .select()
      .from(bilingualTranslationRuns)
      .where(eq(bilingualTranslationRuns.id, runId))
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
    async ({ batch }) =>
      new Map(batch.map((row) => [row.ordinal, `[target] ${row.sourceText}`])),
  );
  writeSpy.mockImplementation(async (input) =>
    Result.ok({
      entityId: input.entityId,
      entityVersionId: outputVersionId,
      fieldId: createSafeId<"field">(),
      fileName: input.fileName,
      versionNumber: 2,
    }),
  );
  fakeS3.requests.length = 0;
  await testDb.insert(bilingualTranslationRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    fileFieldId: ids.fileFieldA1,
    entityVersionId: ids.entityVersionA1,
    sourceLang: "en",
    targetLang: "cs",
    glossary: [],
    status: "queued",
    total: 1,
    requestedBy: ids.userA1,
  });
  await testDb.insert(bilingualTranslationRows).values({
    id: createSafeId<"bilingualTranslationRow">(),
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    runId,
    rowId: "row-1",
    ordinal: 0,
    kind: "paragraph",
    disposition: "translate",
    dispositionOrigin: "default",
    sourceText: "The parties agree.",
    status: "pending",
  });
});

afterEach(async () => {
  await testDb
    .delete(bilingualTranslationRows)
    .where(eq(bilingualTranslationRows.runId, runId));
  await testDb
    .delete(bilingualTranslationRuns)
    .where(eq(bilingualTranslationRuns.id, runId));
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
  await processBilingualRun(actor, testModelAdmission(actor.organizationId));
  const run = await readRun();
  expect(run).toMatchObject({
    status: "failed",
    errorCode: "document_unresolved",
    outputEntityVersionId: null,
  });
  expect(run?.finishedAt).not.toBeNull();
  expect(sourceReads()).toEqual([]);
  expect(translateSpy).not.toHaveBeenCalled();
  expect(writeSpy).not.toHaveBeenCalled();
};

describe("bilingual run", () => {
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
    await processBilingualRun(actor, testModelAdmission(actor.organizationId));
    expect(await readRun()).toMatchObject({
      status: "completed",
      errorCode: null,
      outputEntityVersionId: outputVersionId,
    });
    expect(sourceReads()).toHaveLength(1);
    expect(translateSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
