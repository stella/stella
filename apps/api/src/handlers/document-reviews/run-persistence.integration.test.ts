/**
 * The persistence invariants a durable review depends on, exercised against a
 * real PostgreSQL schema because the schema is what enforces them:
 *
 *  - one unfinished run per document (the 409 the create endpoint returns is a
 *    friendly restatement of this index, not the guarantee itself),
 *  - `(runId, topicId, checkKind)` convergence, so a redelivered job overwrites
 *    the judgment it already wrote instead of adding a second one,
 *  - the per-kind outcome vocabularies staying unmerged.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
  DocumentReviewRunStatus,
} from "@/api/lib/document-review/run-contract";
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

const TOPIC_ID = "44444444-4444-4444-8444-444444444444";
const POSITION_ID = "11111111-1111-4111-8111-111111111111";
const CONTENT_SHA256 = "a".repeat(64);

/** The reviewed document a case owns. Runs pin these by value (no foreign
 *  keys), so each case can claim its own document without seeding entities. */
type ReviewTarget = {
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
};

const reviewTarget = (): ReviewTarget => ({
  entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
  fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
  entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
});

const referenceBasis: DocumentReviewRunBasis = {
  type: "references",
  references: [
    {
      entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
      contentSha256: "b".repeat(64),
      name: "Precedent SPA",
    },
  ],
};

/** Each fixture is pinned to its own member of the payload union rather than
 *  to the union itself, so a shape that drifts from the engine's finding type
 *  fails here instead of being widened away. */
type ReferenceFindingPayload = Extract<
  DocumentReviewFindingPayload,
  { checkKind: "reference" }
>;
type PlaybookFindingPayload = Extract<
  DocumentReviewFindingPayload,
  { checkKind: "playbook" }
>;

/** bun-types declares `.rejects.toThrow` as void, so awaiting it trips
 *  type-aware lint; capture the rejection explicitly instead. */
const rejectionOf = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(
    () => null,
    (error: unknown) => error,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The pg error fields that name the rule a statement broke. */
const VIOLATION_FIELDS = ["message", "constraint", "detail"] as const;

/**
 * Everything a failure says about which rule it broke: the message chain plus
 * the `constraint` field the driver exposes, walked through `cause` so it does
 * not matter whether drizzle wraps the underlying error.
 *
 * Asserting on this rather than on "some error was thrown" is what stops a
 * missing relation, a bad column, or a foreign-key failure from passing as
 * proof that the constraint under test fired.
 */
const violationText = (error: unknown): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    for (const field of VIOLATION_FIELDS) {
      const value = current[field];
      if (typeof value === "string") {
        parts.push(value);
      }
    }
    current = current["cause"];
  }
  return parts.join(" | ");
};

// The exact objects under test, named as `db/schema/document-reviews.ts`
// declares them. A rename there fails these assertions rather than quietly
// leaving the constraint untested.
const ACTIVE_RUN_INDEX = "document_review_runs_active_document_uidx";
const FINDING_OUTCOME_CHECK = "document_review_findings_outcome_check";

const referencePayload = (text: string): ReferenceFindingPayload => ({
  checkKind: "reference",
  finding: {
    findingId: `reference-${TOPIC_ID}`,
    topicId: TOPIC_ID,
    issue: "Governing law",
    assessment: "different",
    consensus: "single",
    explanation: { type: "comparison", text },
    targetCitations: [],
    referenceCitations: [],
    fix: null,
  },
});

const playbookPayload: PlaybookFindingPayload = {
  checkKind: "playbook",
  finding: {
    positionId: POSITION_ID,
    issue: "Governing law",
    severity: "high",
    verdict: "compliant",
    extracted: null,
    rationale: null,
    citations: [],
    fix: null,
  },
};

const seedRun = async ({
  runId,
  status,
  target,
}: {
  runId: SafeId<"documentReviewRun">;
  status: DocumentReviewRunStatus;
  target: ReviewTarget;
}): Promise<void> => {
  seededRunIds.push(runId);
  await testDb.insert(documentReviewRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: target.entityId,
    fileFieldId: target.fileFieldId,
    entityVersionId: target.entityVersionId,
    contentSha256: CONTENT_SHA256,
    basis: referenceBasis,
    topics: [
      {
        type: "reference",
        topicId: TOPIC_ID,
        title: "Governing law",
        context: "",
        included: true,
      },
    ],
    status,
    total: 1,
    requestedBy: ids.userA1,
    ...(status === "running" ? { startedAt: new Date() } : {}),
  });
};

const upsertReferenceFinding = async (
  runId: SafeId<"documentReviewRun">,
  target: ReviewTarget,
  text: string,
): Promise<void> => {
  const payload = referencePayload(text);
  await testDb
    .insert(documentReviewFindings)
    .values({
      id: toSafeId<"documentReviewFinding">(Bun.randomUUIDv7()),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      runId,
      entityId: target.entityId,
      fileFieldId: target.fileFieldId,
      entityVersionId: target.entityVersionId,
      topicId: TOPIC_ID,
      topicTitle: "Governing law",
      checkKind: "reference",
      positionId: null,
      outcome: payload.finding.assessment,
      payload,
    })
    .onConflictDoUpdate({
      target: [
        documentReviewFindings.runId,
        documentReviewFindings.topicId,
        documentReviewFindings.checkKind,
      ],
      set: { payload, outcome: payload.finding.assessment },
    });
};

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

describe("document review run persistence", () => {
  test("refuses a second unfinished run for the same document", async () => {
    const target = reviewTarget();
    const first = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
    await seedRun({ runId: first, status: "queued", target });

    const second = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
    expect(
      violationText(
        await rejectionOf(seedRun({ runId: second, status: "queued", target })),
      ),
    ).toContain(ACTIVE_RUN_INDEX);

    // A claimed run still occupies the document: the guard covers the whole
    // active window, not just the queued moment.
    await testDb
      .update(documentReviewRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(documentReviewRuns.id, first));
    const third = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
    expect(
      violationText(
        await rejectionOf(seedRun({ runId: third, status: "queued", target })),
      ),
    ).toContain(ACTIVE_RUN_INDEX);
  });

  test("allows a new run once the previous one is terminal", async () => {
    const target = reviewTarget();
    const previous = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
    await seedRun({ runId: previous, status: "queued", target });
    await testDb
      .update(documentReviewRuns)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(documentReviewRuns.id, previous));

    const next = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
    await seedRun({ runId: next, status: "queued", target });

    const rows = await testDb
      .select({ id: documentReviewRuns.id })
      .from(documentReviewRuns)
      .where(
        and(
          eq(documentReviewRuns.workspaceId, ids.wsA1),
          eq(documentReviewRuns.entityId, target.entityId),
        ),
      );
    expect(rows.map(({ id }) => id).toSorted()).toEqual(
      [previous, next].toSorted(),
    );
  });

  test("converges on one finding per topic per kind when a job replays", async () => {
    const target = reviewTarget();
    const runId = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
    await seedRun({ runId, status: "running", target });

    await upsertReferenceFinding(runId, target, "First pass");
    await upsertReferenceFinding(runId, target, "Replayed pass");
    await upsertReferenceFinding(runId, target, "Replayed pass");

    const rows = await testDb
      .select({ payload: documentReviewFindings.payload })
      .from(documentReviewFindings)
      .where(eq(documentReviewFindings.runId, runId));

    expect(rows.length).toBe(1);
    const stored = rows.at(0)?.payload;
    expect(stored?.checkKind).toBe("reference");
    if (stored?.checkKind === "reference") {
      expect(stored.finding.explanation).toEqual({
        type: "comparison",
        text: "Replayed pass",
      });
    }
  });

  test("keeps the two outcome vocabularies apart", async () => {
    const target = reviewTarget();
    const runId = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
    await seedRun({ runId, status: "running", target });

    const insertOutcome = async ({
      checkKind,
      outcome,
      positionId,
    }: {
      checkKind: "playbook" | "reference";
      outcome: string;
      positionId: string | null;
    }): Promise<void> => {
      await testDb.insert(documentReviewFindings).values({
        id: toSafeId<"documentReviewFinding">(Bun.randomUUIDv7()),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        runId,
        entityId: target.entityId,
        fileFieldId: target.fileFieldId,
        entityVersionId: target.entityVersionId,
        topicId: Bun.randomUUIDv7(),
        topicTitle: "Governing law",
        checkKind,
        positionId,
        outcome,
        payload:
          checkKind === "playbook"
            ? playbookPayload
            : referencePayload("vocabulary probe"),
      });
    };

    // A verdict tier is not a comparison assessment, and vice versa.
    expect(
      violationText(
        await rejectionOf(
          insertOutcome({
            checkKind: "reference",
            outcome: "compliant",
            positionId: null,
          }),
        ),
      ),
    ).toContain(FINDING_OUTCOME_CHECK);
    expect(
      violationText(
        await rejectionOf(
          insertOutcome({
            checkKind: "playbook",
            outcome: "different",
            positionId: POSITION_ID,
          }),
        ),
      ),
    ).toContain(FINDING_OUTCOME_CHECK);
    // Only a playbook-kind row grades a position.
    expect(
      violationText(
        await rejectionOf(
          insertOutcome({
            checkKind: "reference",
            outcome: "aligned",
            positionId: POSITION_ID,
          }),
        ),
      ),
    ).toContain(FINDING_OUTCOME_CHECK);

    await insertOutcome({
      checkKind: "playbook",
      outcome: "compliant",
      positionId: POSITION_ID,
    });
    await insertOutcome({
      checkKind: "reference",
      outcome: "aligned",
      positionId: null,
    });
  });
});
