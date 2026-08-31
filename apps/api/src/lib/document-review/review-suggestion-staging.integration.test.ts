/**
 * A review's fixes and the document's suggestion list are one thing, exercised
 * end to end against the real schema because the link that makes them one is a
 * foreign key and a unique index:
 *
 *  - completing a run stages exactly the findings that carry a fix,
 *  - re-completing it stages nothing (the partial unique key converges),
 *  - resolving the suggestion resolves the finding, and reverting reopens it.
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

import type { Transaction } from "@/api/db/root";
import {
  docxSuggestions,
  documentReviewFindings,
  documentReviewRuns,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import resolveDocxSuggestion from "@/api/handlers/docx-suggestions/resolve";
import revertDocxSuggestion from "@/api/handlers/docx-suggestions/revert";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import { finalizeReviewRun } from "@/api/lib/document-review/run-finalize";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const seededRunIds: SafeId<"documentReviewRun">[] = [];

const FIXED_POSITION_ID = "22222222-2222-4222-8222-222222222222";
const OPEN_POSITION_ID = "33333333-3333-4333-8333-333333333333";
const CONTENT_SHA256 = "c".repeat(64);
const FIXED_ISSUE = "Leakage time bar";

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
  perspective: { type: "party", role: "Purchaser", name: null },
  references: [],
};

/** A finding whose delta produced a grounded, substring-anchored redline. */
const payloadWithFix: DocumentReviewFindingPayload = {
  finding: {
    positionId: FIXED_POSITION_ID,
    issue: FIXED_ISSUE,
    severity: "blocker",
    standardSource: "reference",
    verdict: "deviation",
    delta: {
      kind: "parameter",
      target: {
        text: "12 months",
        value: 12,
        unit: "months",
        citation: { blockId: "para-4", text: "within 12 months of Completion" },
      },
      standard: {
        text: "6 months",
        value: 6,
        unit: "months",
        citation: { blockId: "para-9", text: "within 6 months of Completion" },
      },
    },
    extracted: null,
    rationale: null,
    citations: [{ blockId: "para-4", text: "within 12 months of Completion" }],
    fix: {
      kind: "replaceInBlock",
      blockId: "para-4",
      find: "12 months",
      replace: "6 months",
    },
  },
};

/** A finding the engine could not ground a fix for; it must stage nothing. */
const payloadWithoutFix: DocumentReviewFindingPayload = {
  finding: {
    positionId: OPEN_POSITION_ID,
    issue: "Governing law",
    severity: "medium",
    standardSource: "tiers",
    verdict: "compliant",
    delta: { kind: "language" },
    extracted: null,
    rationale: null,
    citations: [],
    fix: null,
  },
};

type ReviewTarget = {
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
};

/**
 * Every case reviews the seeded entity — `docx_suggestions` is bound to
 * `(entity_id, workspace_id)` by a composite foreign key — but claims its own
 * file field, so the one-active-run-per-document index cannot make two cases
 * collide.
 */
const reviewTarget = (): ReviewTarget => ({
  entityId: ids.entityA1,
  fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
  entityVersionId: ids.entityVersionA1,
});

const seedRunningRun = async (
  target: ReviewTarget,
  total: number,
): Promise<SafeId<"documentReviewRun">> => {
  const runId = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
  seededRunIds.push(runId);
  await testDb.insert(documentReviewRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: target.entityId,
    fileFieldId: target.fileFieldId,
    entityVersionId: target.entityVersionId,
    contentSha256: CONTENT_SHA256,
    basis,
    status: "running",
    startedAt: new Date(),
    total,
    requestedBy: ids.userA1,
    executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
  });
  return runId;
};

const seedFinding = async (
  runId: SafeId<"documentReviewRun">,
  target: ReviewTarget,
  payload: DocumentReviewFindingPayload,
): Promise<SafeId<"documentReviewFinding">> => {
  const findingId = toSafeId<"documentReviewFinding">(Bun.randomUUIDv7());
  await testDb.insert(documentReviewFindings).values({
    id: findingId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    runId,
    entityId: target.entityId,
    fileFieldId: target.fileFieldId,
    entityVersionId: target.entityVersionId,
    positionId: payload.finding.positionId,
    positionTitle: payload.finding.issue,
    outcome: payload.finding.verdict,
    payload,
  });
  return findingId;
};

const finalize = async (
  runId: SafeId<"documentReviewRun">,
  target: ReviewTarget,
  expectedFindingCount: number,
) =>
  await finalizeReviewRun({
    tx: asTestRaw<Transaction>(testDb),
    workspaceId: ids.wsA1,
    runId,
    entityId: target.entityId,
    fileFieldId: target.fileFieldId,
    executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
    expectedFindingCount,
  });

const suggestionsFor = async (findingId: SafeId<"documentReviewFinding">) =>
  await testDb
    .select({
      id: docxSuggestions.id,
      opPayload: docxSuggestions.opPayload,
      comment: docxSuggestions.comment,
      severity: docxSuggestions.severity,
      area: docxSuggestions.area,
      status: docxSuggestions.status,
      originThreadId: docxSuggestions.originThreadId,
    })
    .from(docxSuggestions)
    .where(eq(docxSuggestions.originReviewFindingId, findingId));

const findingState = async (findingId: SafeId<"documentReviewFinding">) => {
  const rows = await testDb
    .select({
      decision: documentReviewFindings.decision,
      decidedBy: documentReviewFindings.decidedBy,
      applicationStatus: documentReviewFindings.applicationStatus,
      appliedBy: documentReviewFindings.appliedBy,
    })
    .from(documentReviewFindings)
    .where(eq(documentReviewFindings.id, findingId));
  return rows.at(0);
};

const auditEvents: AuditEvent[] = [];
const recordAuditEvent: AuditRecorder = async (_tx, event) => {
  auditEvents.push(...(Array.isArray(event) ? event : [event]));
};

type WorkspaceTestContext = {
  memberRole: { role: "owner" };
  recordAuditEvent: AuditRecorder;
  request: Request;
  route: string;
  safeDb: ReturnType<typeof createSafeDb<TestDatabaseTransaction>>;
  scopedDb: ReturnType<typeof createScopedDb<TestDatabaseTransaction>>;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
  workspaceId: SafeId<"workspace">;
};

const workspaceContext = (): WorkspaceTestContext => ({
  memberRole: { role: "owner" },
  recordAuditEvent,
  request: new Request("https://example.test/docx-suggestions"),
  route: "/document-review/suggestion-staging",
  safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
  workspaceId: ids.wsA1,
});

const runHandler = async (
  endpoint: { handler: (context: never) => Promise<unknown> },
  requestShape: Record<string, unknown>,
): Promise<unknown> => {
  try {
    return await endpoint.handler(
      asTestRaw<never>({ ...workspaceContext(), ...requestShape }),
    );
  } catch (error) {
    return error;
  }
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

describe("review fixes staged as folio suggestions", () => {
  test("completing a run stages one suggestion per grounded fix, and only once", async () => {
    const target = reviewTarget();
    const runId = await seedRunningRun(target, 2);
    const fixedFindingId = await seedFinding(runId, target, payloadWithFix);
    const openFindingId = await seedFinding(runId, target, payloadWithoutFix);

    const finalized = await finalize(runId, target, 2);
    expect(finalized).toEqual({
      type: "completed",
      committed: 2,
      carried: 0,
      staged: 1,
    });

    const staged = await suggestionsFor(fixedFindingId);
    expect(staged).toHaveLength(1);
    const suggestion = staged.at(0);
    expect(suggestion?.opPayload).toEqual({
      id: fixedFindingId,
      type: "replaceInBlock",
      blockId: "para-4",
      find: "12 months",
      replace: "6 months",
    });
    // `blocker` maps onto the editor's top severity; the area is the position's
    // own issue; and the comment is never the rationale or a reference quote.
    expect(suggestion?.severity).toBe("high");
    expect(suggestion?.area).toBe(FIXED_ISSUE);
    expect(suggestion?.comment).toBeNull();
    expect(suggestion?.status).toBe("pending");
    expect(suggestion?.originThreadId).toBeNull();

    // A finding the engine could not ground stages nothing at all.
    expect(await suggestionsFor(openFindingId)).toHaveLength(0);

    // A redelivered completion converges on the row it already wrote.
    const refinalized = await finalize(runId, target, 2);
    expect(refinalized).toEqual({
      type: "completed",
      committed: 2,
      carried: 0,
      staged: 0,
    });
    expect(await suggestionsFor(fixedFindingId)).toHaveLength(1);
  });

  test("resolving the staged suggestion resolves the finding it came from", async () => {
    const target = reviewTarget();
    const runId = await seedRunningRun(target, 1);
    const findingId = await seedFinding(runId, target, payloadWithFix);
    await finalize(runId, target, 1);
    const suggestionId = (await suggestionsFor(findingId)).at(0)?.id;
    expect(suggestionId).toBeDefined();
    if (suggestionId === undefined) {
      return;
    }

    auditEvents.length = 0;
    const accepted = await runHandler(resolveDocxSuggestion, {
      params: {
        workspaceId: ids.wsA1,
        entityId: target.entityId,
        suggestionId,
      },
      body: { status: "accepted", appliedMode: "suggested" },
    });
    expect(accepted).toEqual({ updated: true });

    // Accepting is both halves at once: the reviewer's decision and the durable
    // application of the edit.
    expect(await findingState(findingId)).toEqual({
      decision: "accepted",
      decidedBy: ids.userA1,
      applicationStatus: "applied",
      appliedBy: ids.userA1,
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents.at(0)?.resourceId).toBe(runId);

    // Reverting withdraws both, leaving the finding as the engine produced it.
    const reverted = await runHandler(revertDocxSuggestion, {
      params: {
        workspaceId: ids.wsA1,
        entityId: target.entityId,
        suggestionId,
      },
    });
    expect(reverted).toEqual({ updated: true });
    expect(await findingState(findingId)).toEqual({
      decision: "open",
      decidedBy: null,
      applicationStatus: "pending",
      appliedBy: null,
    });
  });

  test("rejecting the staged suggestion dismisses the finding without applying it", async () => {
    const target = reviewTarget();
    const runId = await seedRunningRun(target, 1);
    const findingId = await seedFinding(runId, target, payloadWithFix);
    await finalize(runId, target, 1);
    const suggestionId = (await suggestionsFor(findingId)).at(0)?.id;
    expect(suggestionId).toBeDefined();
    if (suggestionId === undefined) {
      return;
    }

    const rejected = await runHandler(resolveDocxSuggestion, {
      params: {
        workspaceId: ids.wsA1,
        entityId: target.entityId,
        suggestionId,
      },
      body: { status: "rejected" },
    });
    expect(rejected).toEqual({ updated: true });

    expect(await findingState(findingId)).toEqual({
      decision: "dismissed",
      decidedBy: ids.userA1,
      applicationStatus: "pending",
      appliedBy: null,
    });
  });
});
