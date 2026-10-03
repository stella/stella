import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewRuns, fields, workspaceMembers } from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import type { RlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import * as preparation from "@/api/lib/document-review/prepare-review-files";
import {
  DOCUMENT_REVIEW_RUN_EXECUTOR,
  PLAYBOOK_PIN_PROVENANCE,
} from "@/api/lib/document-review/run-contract";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import { resolveDocumentReviewRunInputs } from "@/api/lib/document-review/run-inputs";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import { processDocumentReviewRun } from "@/api/lib/document-review/run-queue";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  createRootMembershipScopedDb,
  createRootRunActor,
} from "@/api/lib/root-scoped-db";
import { brandPersistedDocumentReviewRunId } from "@/api/lib/safe-id-boundaries";
import * as modelTransport from "@/api/lib/tanstack-ai-generate";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();
const database = asTestRaw<RlsDatabase<Transaction>>(testDb);
const scope = { organizationId: ids.orgA, userId: ids.userA1 };
const inputDb = createRootMembershipScopedDb(scope, database);
const runId = createSafeId<"documentReviewRun">();
const originalField = await testDb.query.fields.findFirst({
  where: { id: { eq: ids.fieldA2 } },
});
const originalMembership = await testDb.query.workspaceMembers.findFirst({
  where: { id: { eq: ids.memberA1wsA2 } },
});
if (!originalField || !originalMembership) {
  panic("Review worker fixture is incomplete");
}

const targetPin = {
  workspaceId: ids.wsA1,
  fileFieldId: ids.fileFieldA1,
  entityVersionId: ids.entityVersionA1,
  contentSha256: "a".repeat(64),
};
const referencePin = {
  workspaceId: ids.wsA2,
  fileFieldId: ids.fieldA2,
  entityVersionId: ids.entityVersionA2,
  contentSha256: "c".repeat(64),
};
const basis = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: PLAYBOOK_PIN_PROVENANCE.EPHEMERAL,
    definitionSnapshot: {
      name: "Review fixture",
      positions: {
        version: 3,
        items: [
          {
            mode: "extract",
            sourceId: Bun.randomUUIDv7(),
            issue: "Notice period",
            ask: {
              question: "What is the notice period?",
              content: { version: 1, type: "text" },
            },
            enabled: true,
          },
        ],
      },
    },
  },
  references: [
    {
      ...referencePin,
      entityId: ids.entityA2,
      workspaceName: "Reference matter",
      name: "Reference document",
    },
  ],
  perspective: NEUTRAL_PERSPECTIVE,
} satisfies DocumentReviewRunBasis;

const actor = createRootRunActor(
  { ...scope, runId, workspaceId: ids.wsA1 },
  brandPersistedDocumentReviewRunId,
  database,
);

const preparationSpy = spyOn(preparation, "fetchAndPrepareReviewFiles");
const modelSpy = spyOn(modelTransport, "generateTanStackTextForRole");
const fetchPreconnect = globalThis.fetch.preconnect;
const fetchSpy = spyOn(globalThis, "fetch");
const analytics = installRecordingAnalytics();

beforeEach(async () => {
  preparationSpy.mockClear();
  modelSpy.mockClear();
  fetchSpy.mockClear();
  fetchSpy.mockImplementation(
    Object.assign(async () => panic("Unexpected review transport call"), {
      preconnect: fetchPreconnect,
    }),
  );
  analytics.events.length = 0;
  await testDb
    .update(fields)
    .set({
      content: {
        version: 1,
        type: "file",
        id: Bun.randomUUIDv7(),
        fileName: "reference.docx",
        mimeType: DOCX_MIME_TYPE,
        sizeBytes: 1024,
        encrypted: false,
        sha256Hex: referencePin.contentSha256,
        pdfFileId: null,
      },
    })
    .where(eq(fields.id, ids.fieldA2));
  expect(
    await resolveDocumentReviewRunInputs(inputDb, {
      pins: [targetPin, referencePin],
      passageIds: [],
    }),
  ).toMatchObject({ type: "resolved" });
  expect(
    planReviewRun({ basis, executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER })
      .expectedFindingCount,
  ).toBe(1);
  await testDb.insert(documentReviewRuns).values({
    id: runId,
    organizationId: ids.orgA,
    ...targetPin,
    entityId: ids.entityA1,
    basis,
    executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
    requestedBy: ids.userA1,
    status: "queued",
  });
});

afterEach(async () => {
  await testDb
    .delete(documentReviewRuns)
    .where(eq(documentReviewRuns.id, runId));
  await testDb
    .insert(workspaceMembers)
    .values(originalMembership)
    .onConflictDoNothing();
  await testDb
    .update(fields)
    .set({ content: originalField.content })
    .where(eq(fields.id, ids.fieldA2));
});

afterAll(async () => {
  preparationSpy.mockRestore();
  modelSpy.mockRestore();
  fetchSpy.mockRestore();
  analytics.restore();
  await releaseRlsFixture();
});

describe("document review input readiness", () => {
  test("records unavailable inputs before preparing documents", async () => {
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA2));
    await processDocumentReviewRun(actor);
    const run = (
      await testDb
        .select()
        .from(documentReviewRuns)
        .where(eq(documentReviewRuns.id, runId))
        .limit(1)
    ).at(0);
    expect(run).toMatchObject({
      status: "failed",
      errorCode: "pin_unresolved",
    });
    expect(run?.finishedAt).not.toBeNull();
    expect(preparationSpy).not.toHaveBeenCalled();
    expect(modelSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("records an input transaction failure before preparing documents", async () => {
    const failure = new DatabaseError({
      message: "Review input transaction unavailable",
    });
    const failingDatabase = markRlsDatabase({
      transaction: async () => {
        throw failure;
      },
    });
    await processDocumentReviewRun({
      ...actor,
      inputDb: createRootMembershipScopedDb(
        scope,
        asTestRaw<RlsDatabase<Transaction>>(failingDatabase),
      ),
    });
    const run = (
      await testDb
        .select()
        .from(documentReviewRuns)
        .where(eq(documentReviewRuns.id, runId))
        .limit(1)
    ).at(0);
    expect(run).toMatchObject({ status: "failed", errorCode: "internal" });
    expect(run?.finishedAt).not.toBeNull();
    expect(analytics.exceptions()).toHaveLength(1);
    expect(preparationSpy).not.toHaveBeenCalled();
    expect(modelSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
