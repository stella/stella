/**
 * The review-decision read behind the report builder, against a real schema:
 * only completed runs count, the newest completed run wins per position, and
 * the limit bounds distinct (entity, position) rows rather than run history.
 */

import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  loadReviewDecisions,
  reviewDecisionKey,
} from "@/api/handlers/reports/build-report-data";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  DocumentReviewDecision,
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
  DocumentReviewRunStatus,
} from "@/api/lib/document-review/run-contract";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededRunIds: SafeId<"documentReviewRun">[] = [];

const FILE_FIELD_ID = toSafeId<"field">(Bun.randomUUIDv7());
// Sorted so the position outside the visible columns comes first under
// `ORDER BY position_id`: a missing position filter would spend the limit on it.
const HIDDEN_POSITION = "00000000-0000-4000-8000-000000000000";
const POSITION_LAW = "11111111-1111-4111-8111-111111111111";
const POSITION_TERM = "22222222-2222-4222-8222-222222222222";
const VISIBLE_POSITIONS = [POSITION_LAW, POSITION_TERM];

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
  references: [
    {
      workspaceId: toSafeId<"workspace">(Bun.randomUUIDv7()),
      workspaceName: "Precedent matter",
      entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
      contentSha256: "b".repeat(64),
      name: "Precedent",
    },
  ],
};

const playbookPayload = (positionId: string): DocumentReviewFindingPayload => ({
  finding: {
    positionId,
    issue: "Position",
    severity: "high",
    standardSource: "tiers",
    verdict: "deviation",
    delta: { kind: "language" },
    extracted: null,
    rationale: null,
    citations: [],
    fix: null,
  },
});

type SeedRunOptions = {
  status: DocumentReviewRunStatus;
  createdAt: Date;
  entityVersionId: SafeId<"entityVersion">;
  decisions: Record<string, DocumentReviewDecision>;
};

/** One run on `entityA1` with a playbook finding per position, each carrying
 *  the given decision. */
const seedRun = async ({
  status,
  createdAt,
  entityVersionId,
  decisions,
}: SeedRunOptions): Promise<void> => {
  const runId = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
  seededRunIds.push(runId);
  await testDb.insert(documentReviewRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    fileFieldId: FILE_FIELD_ID,
    entityVersionId,
    contentSha256: "a".repeat(64),
    basis,
    status,
    total: Object.keys(decisions).length,
    requestedBy: ids.userA1,
    createdAt,
    ...(status === "running" ? { startedAt: createdAt } : {}),
    ...(status === "completed" || status === "failed"
      ? { startedAt: createdAt, finishedAt: createdAt }
      : {}),
  });
  await testDb.insert(documentReviewFindings).values(
    Object.entries(decisions).map(([positionId, decision]) => ({
      id: toSafeId<"documentReviewFinding">(Bun.randomUUIDv7()),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      runId,
      entityId: ids.entityA1,
      fileFieldId: FILE_FIELD_ID,
      entityVersionId,
      positionId,
      positionTitle: "Position",
      outcome: "deviation",
      payload: playbookPayload(positionId),
      decision,
      decidedBy: decision === "open" ? null : ids.userA1,
      decidedAt: decision === "open" ? null : createdAt,
    })),
  );
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  safeDb = toSafeDbMock(asTestRaw<ScopedDb>(scoped));
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

describe("loadReviewDecisions", () => {
  test("reads the newest completed run per position, ignoring unfinished, failed and stale-version runs", async () => {
    const t0 = new Date("2026-07-01T10:00:00.000Z");
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    const staleVersionId = toSafeId<"entityVersion">(Bun.randomUUIDv7());

    // Oldest completed run: both positions decided, plus a hidden position.
    await seedRun({
      status: "completed",
      createdAt: at(0),
      entityVersionId: ids.entityVersionA1,
      decisions: {
        [HIDDEN_POSITION]: "accepted",
        [POSITION_LAW]: "accepted",
        [POSITION_TERM]: "dismissed",
      },
    });
    // Newer completed run re-decides the law position only.
    await seedRun({
      status: "completed",
      createdAt: at(1),
      entityVersionId: ids.entityVersionA1,
      decisions: { [POSITION_LAW]: "dismissed" },
    });
    // A completed run against a version that is no longer current.
    await seedRun({
      status: "completed",
      createdAt: at(2),
      entityVersionId: staleVersionId,
      decisions: { [POSITION_LAW]: "open", [POSITION_TERM]: "open" },
    });
    // A failed run that persisted findings before failing.
    await seedRun({
      status: "failed",
      createdAt: at(3),
      entityVersionId: ids.entityVersionA1,
      decisions: { [POSITION_LAW]: "open", [POSITION_TERM]: "open" },
    });
    // The newest run is still running: its fresh `open` rows must not win.
    await seedRun({
      status: "running",
      createdAt: at(4),
      entityVersionId: ids.entityVersionA1,
      decisions: { [POSITION_LAW]: "open", [POSITION_TERM]: "open" },
    });

    const loaded = await loadReviewDecisions({
      safeDb,
      workspaceId: ids.wsA1,
      entityIds: [ids.entityA1],
      positionIds: VISIBLE_POSITIONS,
    });
    expect(Result.isOk(loaded)).toBe(true);
    if (!Result.isOk(loaded)) {
      return;
    }
    expect(Object.fromEntries(loaded.value)).toEqual({
      [reviewDecisionKey(ids.entityA1, POSITION_LAW)]: "dismissed",
      [reviewDecisionKey(ids.entityA1, POSITION_TERM)]: "dismissed",
    });
  });
});
