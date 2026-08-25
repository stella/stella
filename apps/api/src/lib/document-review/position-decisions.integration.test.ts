/**
 * The decision overlay: what an organization has actually done with a position,
 * counted from the findings themselves.
 *
 * Exercised against the real schema because the whole point is one grouped
 * statement — the counts, the run denominator, and the pick of the latest
 * accepted fix text all come out of SQL, so nothing here is provable in memory.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readPositionDecisionOverlay } from "@/api/lib/document-review/position-decisions";
import type { ReviewFix } from "@/api/lib/document-review/review-grade";
import type {
  DocumentReviewDecision,
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

let testDb: TestDatabase;
let ids: TestIds;

const seededRunIds: SafeId<"documentReviewRun">[] = [];

const DECIDED_POSITION_ID = "66666666-6666-4666-8666-666666666666";
const UNTOUCHED_POSITION_ID = "77777777-7777-4777-8777-777777777777";
const CONTENT_SHA256 = "e".repeat(64);

const basis: DocumentReviewRunBasis = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Positions confirmed for this review",
      positions: { version: 3, items: [] },
    },
  },
  perspective: { type: "neutral" },
  references: [],
};

const payloadWith = (fix: ReviewFix | null): DocumentReviewFindingPayload => ({
  finding: {
    positionId: DECIDED_POSITION_ID,
    issue: "Leakage time bar",
    severity: "high",
    standardSource: "reference",
    verdict: "deviation",
    delta: { kind: "language" },
    extracted: null,
    rationale: null,
    citations: [],
    fix,
  },
});

const seedRun = async (
  organizationId: SafeId<"organization">,
  workspaceId: SafeId<"workspace">,
): Promise<SafeId<"documentReviewRun">> => {
  const runId = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
  seededRunIds.push(runId);
  await testDb.insert(documentReviewRuns).values({
    id: runId,
    organizationId,
    workspaceId,
    entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
    contentSha256: CONTENT_SHA256,
    basis,
    status: "completed",
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  return runId;
};

type SeedFindingArgs = {
  runId: SafeId<"documentReviewRun">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  decision: DocumentReviewDecision;
  decidedAt: Date | null;
  fix: ReviewFix | null;
};

const seedFinding = async ({
  runId,
  organizationId,
  workspaceId,
  decision,
  decidedAt,
  fix,
}: SeedFindingArgs): Promise<void> => {
  await testDb.insert(documentReviewFindings).values({
    id: toSafeId<"documentReviewFinding">(Bun.randomUUIDv7()),
    organizationId,
    workspaceId,
    runId,
    entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
    positionId: DECIDED_POSITION_ID,
    positionTitle: "Leakage time bar",
    outcome: "deviation",
    payload: payloadWith(fix),
    decision,
    ...(decidedAt === null ? {} : { decidedBy: null, decidedAt }),
  });
};

const overlay = async () =>
  await readPositionDecisionOverlay({
    tx: asTestRaw<Transaction>(testDb),
    organizationId: ids.orgA,
    positionIds: [DECIDED_POSITION_ID, UNTOUCHED_POSITION_ID],
  });

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (seededRunIds.length > 0) {
      await testDb
        .delete(documentReviewRuns)
        .where(inArray(documentReviewRuns.id, seededRunIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("position decision overlay", () => {
  test("counts decisions per position and keeps the latest accepted fix text", async () => {
    const first = await seedRun(ids.orgA, ids.wsA1);
    const second = await seedRun(ids.orgA, ids.wsA1);
    const third = await seedRun(ids.orgA, ids.wsA1);

    await seedFinding({
      runId: first,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      decision: "accepted",
      decidedAt: new Date("2026-08-01T10:00:00.000Z"),
      fix: {
        kind: "replaceBlock",
        blockId: "para-4",
        text: "Claims must be notified within 6 months of Completion.",
      },
    });
    // Newer, and a parameter fix: its text is the replacement term, not a block.
    await seedFinding({
      runId: second,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      decision: "accepted",
      decidedAt: new Date("2026-08-20T10:00:00.000Z"),
      fix: {
        kind: "replaceInBlock",
        blockId: "para-4",
        find: "12 months",
        replace: "6 months",
      },
    });
    await seedFinding({
      runId: third,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      decision: "dismissed",
      decidedAt: new Date("2026-08-22T10:00:00.000Z"),
      fix: null,
    });

    // Another tenant graded the same position id; the organization predicate is
    // what keeps its decisions out of this answer.
    const foreign = await seedRun(ids.orgB, ids.wsB1);
    await seedFinding({
      runId: foreign,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      decision: "accepted",
      decidedAt: new Date("2026-08-24T10:00:00.000Z"),
      fix: {
        kind: "replaceBlock",
        blockId: "para-4",
        text: "Another tenant's wording",
      },
    });

    expect(await overlay()).toEqual({
      [DECIDED_POSITION_ID]: {
        accepted: 2,
        dismissed: 1,
        runs: 3,
        latestAcceptedFixText: "6 months",
      },
    });
  });

  test("an undecided finding still counts as a run that graded the position", async () => {
    const runId = await seedRun(ids.orgA, ids.wsA1);
    await seedFinding({
      runId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      decision: "open",
      decidedAt: null,
      fix: null,
    });

    const summary = (await overlay())[DECIDED_POSITION_ID];
    expect(summary?.runs).toBe(4);
    expect(summary?.accepted).toBe(2);
    expect(summary?.dismissed).toBe(1);
  });

  test("a position no run has graded is absent rather than zeroed", async () => {
    expect(UNTOUCHED_POSITION_ID in (await overlay())).toBe(false);
  });

  test("asking about no positions asks the database nothing", async () => {
    expect(
      await readPositionDecisionOverlay({
        tx: asTestRaw<Transaction>({
          select: () => {
            throw new Error("unexpected query");
          },
        }),
        organizationId: ids.orgA,
        positionIds: [],
      }),
    ).toEqual({});
  });
});
