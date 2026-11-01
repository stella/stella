import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  bilingualTranslationRows,
  bilingualTranslationRuns,
  documentReviewFindings,
  documentReviewRuns,
  entities,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: The RLS fixture migrates a real PostgreSQL database before the first case.
setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const basis: DocumentReviewRunBasis = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Deletion ownership fixture",
      positions: { version: 3, items: [] },
    },
  },
  perspective: { type: "neutral" },
  references: [],
};

const findingPayload: DocumentReviewFindingPayload = {
  finding: {
    positionId: "11111111-1111-4111-8111-111111111111",
    issue: "Deletion ownership",
    severity: "high",
    standardSource: "tiers",
    verdict: "deviation",
    delta: { kind: "language" },
    extracted: null,
    rationale: "Privileged review text",
    citations: [{ blockId: "paragraph-1", text: "Privileged source clause" }],
    fix: null,
  },
};

const rejectionText = async (operation: Promise<unknown>): Promise<string> => {
  const rejected = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = rejected;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    for (const key of ["message", "constraint", "detail"] as const) {
      const value = Reflect.get(current, key);
      if (typeof value === "string") {
        parts.push(value);
      }
    }
    current = Reflect.get(current, "cause");
  }
  return parts.join(" | ");
};

test("permanent entity deletion cascades every copied document derivative", async () => {
  const entityId = createSafeId<"entity">();
  const bilingualRunId = createSafeId<"bilingualTranslationRun">();
  const reviewRunId = createSafeId<"documentReviewRun">();

  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    name: "Deletion ownership fixture",
    createdBy: ids.userA1,
  });
  await testDb.insert(bilingualTranslationRuns).values({
    id: bilingualRunId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId,
    fileFieldId: createSafeId<"field">(),
    entityVersionId: createSafeId<"entityVersion">(),
    sourceLang: "en",
    targetLang: "cs",
    glossary: [],
    status: "completed",
    total: 1,
    completed: 1,
    requestedBy: ids.userA1,
    finishedAt: new Date(),
  });
  await testDb.insert(bilingualTranslationRows).values({
    id: createSafeId<"bilingualTranslationRow">(),
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    runId: bilingualRunId,
    rowId: "paragraph-1",
    ordinal: 0,
    kind: "paragraph",
    disposition: "translate",
    dispositionOrigin: "user",
    sourceText: "Privileged source clause",
    targetText: "Privileged translated clause",
    status: "translated",
  });
  await testDb.insert(documentReviewRuns).values({
    id: reviewRunId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId,
    fileFieldId: createSafeId<"field">(),
    entityVersionId: createSafeId<"entityVersion">(),
    contentSha256: "a".repeat(64),
    basis,
    status: "completed",
    total: 1,
    completed: 1,
    requestedBy: ids.userA1,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  await testDb.insert(documentReviewFindings).values({
    id: createSafeId<"documentReviewFinding">(),
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    runId: reviewRunId,
    entityId,
    fileFieldId: createSafeId<"field">(),
    entityVersionId: createSafeId<"entityVersion">(),
    positionId: "11111111-1111-4111-8111-111111111111",
    positionTitle: "Deletion ownership",
    outcome: "deviation",
    payload: findingPayload,
  });

  await testDb.delete(entities).where(eq(entities.id, entityId));

  expect(
    await testDb
      .select({ id: bilingualTranslationRuns.id })
      .from(bilingualTranslationRuns)
      .where(eq(bilingualTranslationRuns.id, bilingualRunId)),
  ).toEqual([]);
  expect(
    await testDb
      .select({ id: bilingualTranslationRows.id })
      .from(bilingualTranslationRows)
      .where(eq(bilingualTranslationRows.runId, bilingualRunId)),
  ).toEqual([]);
  expect(
    await testDb
      .select({ id: documentReviewRuns.id })
      .from(documentReviewRuns)
      .where(eq(documentReviewRuns.id, reviewRunId)),
  ).toEqual([]);
  expect(
    await testDb
      .select({ id: documentReviewFindings.id })
      .from(documentReviewFindings)
      .where(eq(documentReviewFindings.runId, reviewRunId)),
  ).toEqual([]);

  expect(
    await rejectionText(
      testDb.insert(bilingualTranslationRuns).values({
        id: createSafeId<"bilingualTranslationRun">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        entityId,
        fileFieldId: createSafeId<"field">(),
        entityVersionId: createSafeId<"entityVersion">(),
        sourceLang: "en",
        targetLang: "cs",
        glossary: [],
        total: 1,
        requestedBy: ids.userA1,
      }),
    ),
  ).toContain("bilingual_translation_runs_entity_workspace_fk");
  expect(
    await rejectionText(
      testDb.insert(documentReviewRuns).values({
        id: createSafeId<"documentReviewRun">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        entityId,
        fileFieldId: createSafeId<"field">(),
        entityVersionId: createSafeId<"entityVersion">(),
        contentSha256: "b".repeat(64),
        basis,
        total: 1,
        requestedBy: ids.userA1,
      }),
    ),
  ).toContain("document_review_runs_entity_workspace_fk");
});
