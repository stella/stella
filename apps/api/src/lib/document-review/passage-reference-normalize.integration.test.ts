/**
 * `passage-reference-normalize.ts`: rows written before passages were
 * addressed by id are reduced to the ids the current schema stores, and a
 * second run changes nothing.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  PASSAGE_REFERENCE_STEPS,
  PASSAGES_BY_ID_FUNCTION,
  POSITION_ITEMS_BY_ID_FUNCTION,
} from "@/api/lib/document-review/passage-reference-normalize";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

// Larger than every seeded table, so one batch per step drains it.
const BATCH = 1000;

const runSteps = async (
  steps: readonly (typeof PASSAGE_REFERENCE_STEPS)[number][],
): Promise<void> => {
  const [current, ...rest] = steps;
  if (current === undefined) {
    return;
  }
  await testDb.execute(current.rewrite(BATCH));
  await runSteps(rest);
};

const normalize = async () => {
  await testDb.execute(PASSAGES_BY_ID_FUNCTION);
  await testDb.execute(POSITION_ITEMS_BY_ID_FUNCTION);
  await runSteps(PASSAGE_REFERENCE_STEPS);
};

const POSITION_ID = "88888888-8888-4888-8888-888888888888";
const PASSAGE_ID = "99999999-9999-4999-8999-999999999999";
const FILE_FIELD_ID = "44444444-4444-4444-8444-444444444444";
const PASSAGE_WORDS = "Claims must be notified within 6 (six) months.";

let testDb: TestDatabase;
let ids: TestIds;
const runId = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
const findingId = toSafeId<"documentReviewFinding">(Bun.randomUUIDv7());

const passage = {
  id: PASSAGE_ID,
  workspaceId: "",
  entityId: "55555555-5555-4555-8555-555555555555",
  fileFieldId: FILE_FIELD_ID,
  entityVersionId: "33333333-3333-4333-8333-333333333333",
  blockId: "r-9",
};

// Written in the older shape on purpose: passages and citations still carry
// their words, which the current types no longer admit.
const olderBasis = () =>
  asTestRaw<DocumentReviewRunBasis>({
    playbook: {
      definitionId: null,
      versionId: null,
      provenance: "ephemeral",
      definitionSnapshot: {
        name: "Positions confirmed for this review",
        positions: {
          version: 3,
          items: [
            {
              sourceId: POSITION_ID,
              mode: "graded",
              standard: {
                source: "reference",
                termKind: "parameter",
                passages: [
                  {
                    ...passage,
                    workspaceId: ids.wsA2,
                    text: PASSAGE_WORDS,
                  },
                ],
              },
            },
          ],
        },
      },
    },
    perspective: { type: "neutral" },
    references: [],
  });

const olderPayload = () =>
  asTestRaw<DocumentReviewFindingPayload>({
    finding: {
      positionId: POSITION_ID,
      issue: "Notification period",
      severity: "high",
      standardSource: "reference",
      verdict: "deviation",
      delta: {
        kind: "parameter",
        target: null,
        standard: {
          text: "6 (six) months",
          value: 6,
          unit: "months",
          citation: { blockId: "r-9", text: PASSAGE_WORDS },
        },
      },
      extracted: null,
      rationale: null,
      citations: [],
      referenceCitations: [
        {
          fileFieldId: FILE_FIELD_ID,
          passages: [{ id: PASSAGE_ID, blockId: "r-9", text: PASSAGE_WORDS }],
        },
      ],
      fix: null,
    },
  });

const storedRows = async () => {
  const run = await testDb
    .select({ basis: documentReviewRuns.basis })
    .from(documentReviewRuns)
    .where(eq(documentReviewRuns.id, runId));
  const finding = await testDb
    .select({ payload: documentReviewFindings.payload })
    .from(documentReviewFindings)
    .where(eq(documentReviewFindings.id, findingId));
  return { basis: run.at(0)?.basis, payload: finding.at(0)?.payload };
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb.insert(documentReviewRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
    contentSha256: "e".repeat(64),
    basis: olderBasis(),
    status: "completed",
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  await testDb.insert(documentReviewFindings).values({
    id: findingId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    runId,
    entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
    positionId: POSITION_ID,
    positionTitle: "Notification period",
    outcome: "deviation",
    payload: olderPayload(),
    decision: "open",
  });

  await normalize();
});

afterAll(async () => {
  try {
    const seededRuns: SafeId<"documentReviewRun">[] = [runId];
    await testDb
      .delete(documentReviewRuns)
      .where(inArray(documentReviewRuns.id, seededRuns));
  } finally {
    await releaseRlsFixture();
  }
});

describe("passage references by id", () => {
  test("stored findings keep the term and ids, not the passage words", async () => {
    const { payload } = await storedRows();
    const finding = asTestRaw<Record<string, unknown>>(payload?.finding);

    expect(finding["delta"]).toEqual({
      kind: "parameter",
      target: null,
      standard: {
        text: "6 (six) months",
        value: 6,
        unit: "months",
        citation: { blockId: "r-9", text: "" },
      },
    });
    expect(finding["referenceCitations"]).toEqual([
      {
        fileFieldId: FILE_FIELD_ID,
        passages: [{ id: PASSAGE_ID, blockId: "r-9" }],
      },
    ]);
  });

  test("run snapshots keep every passage key but the words", async () => {
    const { basis } = await storedRows();
    const items = asTestRaw<{ standard: { passages: unknown[] } }[]>(
      basis?.playbook.definitionSnapshot.positions.items,
    );

    expect(items.at(0)?.standard.passages).toEqual([
      { ...passage, workspaceId: ids.wsA2 },
    ]);
  });

  test("a second run changes nothing", async () => {
    const before = await storedRows();
    await normalize();

    expect(await storedRows()).toEqual(before);
  });
});
