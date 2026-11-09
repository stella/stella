/**
 * A review's fixes and the document's suggestion list are one thing, exercised
 * end to end against the real schema because the link that makes them one is a
 * foreign key and a unique index:
 *
 *  - completing a run stages exactly the findings that carry a fix,
 *  - re-completing it stages nothing (the partial unique key converges),
 *  - resolving the suggestion resolves the finding, and reverting reopens it.
 */

import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { DOCX_SUGGESTIONS_PENDING_MAX } from "@stll/api-contract";
import { WORKSPACE_STATUS } from "@stll/api-contract/workspace-status";

import type { Transaction } from "@/api/db/root";
import {
  documentReviewFindings,
  documentReviewRuns,
  docxSuggestions,
  entities,
  entityVersions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import resolveDocxSuggestion from "@/api/handlers/docx-suggestions/resolve";
import revertDocxSuggestion from "@/api/handlers/docx-suggestions/revert";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { REVIEW_FIX_STAGING } from "@/api/lib/document-review/review-suggestion-staging";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import {
  finalizeReviewRun,
  finalizeWorkerRun,
} from "@/api/lib/document-review/run-finalize";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  createRootMembershipScopedDb,
  createRootRunActor,
} from "@/api/lib/root-scoped-db";
import { brandPersistedDocumentReviewRunId } from "@/api/lib/safe-id-boundaries";
import { memberScopedDb } from "@/api/tests/helpers/application-role-db";
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
      scope: null,
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
  runBasis: DocumentReviewRunBasis = basis,
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
    basis: runBasis,
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
  await memberScopedDb(testDb, {
    organizationId: ids.orgA,
    workspaceIds: [ids.wsA1],
    userId: ids.userA1,
  })(
    async (tx) =>
      await finalizeReviewRun({
        tx,
        workspaceId: ids.wsA1,
        runId,
        entityId: target.entityId,
        fileFieldId: target.fileFieldId,
        executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
        fixStaging: {
          type: REVIEW_FIX_STAGING.stage,
          sourceDataWorkspaceIds: [],
        },
        expectedFindingCount,
      }),
  );

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
  memberRole: AuthorizedMemberRole;
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
  memberRole: sessionMemberRole("owner"),
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
      skippedForPendingLimit: 0,
      skippedForUnreadableReference: 0,
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
      skippedForPendingLimit: 0,
      skippedForUnreadableReference: 0,
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

type CappedReviewTarget = ReviewTarget & {
  pendingIds: SafeId<"docxSuggestion">[];
};

// A document of its own, filled to its pending cap, so the cap cannot crowd
// the other cases in this file.
const seedCappedTarget = async (): Promise<CappedReviewTarget> => {
  const entityId = toSafeId<"entity">(Bun.randomUUIDv7());
  const entityVersionId = toSafeId<"entityVersion">(Bun.randomUUIDv7());
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "document",
    name: "capped-review-document",
  });
  await testDb.insert(entityVersions).values({
    id: entityVersionId,
    workspaceId: ids.wsA1,
    entityId,
  });
  const pendingIds = Array.from({ length: DOCX_SUGGESTIONS_PENDING_MAX }, () =>
    toSafeId<"docxSuggestion">(Bun.randomUUIDv7()),
  );
  await testDb.insert(docxSuggestions).values(
    pendingIds.map((id, index) => ({
      id,
      workspaceId: ids.wsA1,
      entityId,
      opPayload: {
        id: `chat-${index}`,
        type: "replaceInBlock",
        blockId: "para-1",
        find: "before",
        replace: "after",
      },
      severity: "medium" as const,
      area: "chat",
      status: "pending" as const,
    })),
  );
  return {
    entityId,
    entityVersionId,
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    pendingIds,
  };
};

describe("a re-run after the reviewer dismissed a staged fix", () => {
  const basisWithRule = (ruleText: string): DocumentReviewRunBasis => ({
    ...basis,
    playbook: {
      ...basis.playbook,
      definitionSnapshot: {
        name: "Time bars",
        positions: {
          version: 3,
          items: [
            {
              mode: "graded",
              sourceId: FIXED_POSITION_ID,
              issue: FIXED_ISSUE,
              severity: "blocker",
              standard: {
                source: "tiers",
                tiers: {
                  acceptable: {
                    rules: [
                      {
                        id: "44444444-4444-4444-8444-444444444444",
                        text: ruleText,
                      },
                    ],
                  },
                  fallback: { entries: [] },
                  notAcceptable: { rules: [] },
                },
              },
              ask: { mode: "auto" },
              enabled: true,
            },
          ],
        },
        scope: null,
      },
    },
  });

  const rerun = async (priorRule: string, currentRule: string) => {
    const target = reviewTarget();
    const firstRun = await seedRunningRun(target, 1, basisWithRule(priorRule));
    const firstFinding = await seedFinding(firstRun, target, payloadWithFix);
    await finalize(firstRun, target, 1);
    await testDb
      .update(documentReviewFindings)
      .set({
        decision: "dismissed",
        decidedBy: ids.userA1,
        decidedAt: new Date("2026-01-15T10:00:00.000Z"),
      })
      .where(eq(documentReviewFindings.id, firstFinding));

    const secondRun = await seedRunningRun(
      target,
      1,
      basisWithRule(currentRule),
    );
    const secondFinding = await seedFinding(secondRun, target, payloadWithFix);
    const finalized = await finalize(secondRun, target, 1);
    return {
      finalized,
      state: await findingState(secondFinding),
      suggestions: await suggestionsFor(secondFinding),
    };
  };

  test("keeps the decision and stages nothing while the rules are unchanged", async () => {
    const { finalized, state, suggestions } = await rerun(
      "No longer than 6 months",
      "No longer than 6 months",
    );

    expect(finalized).toMatchObject({ carried: 1, staged: 0 });
    expect(state?.decision).toBe("dismissed");
    expect(suggestions).toHaveLength(0);
  });

  test("reopens the finding and stages its fix again when the rules changed", async () => {
    const { finalized, state, suggestions } = await rerun(
      "No longer than 6 months",
      "No longer than 3 months",
    );

    expect(finalized).toMatchObject({ carried: 0, staged: 1 });
    expect(state?.decision).toBe("open");
    expect(suggestions).toHaveLength(1);
  });
});

describe("review fixes and the document's pending suggestion cap", () => {
  test("a document at its cap leaves new fixes unstaged and reports them without failing the run", async () => {
    const target = await seedCappedTarget();
    const runId = await seedRunningRun(target, 1);
    const findingId = await seedFinding(runId, target, payloadWithFix);

    expect(await finalize(runId, target, 1)).toEqual({
      type: "completed",
      committed: 1,
      carried: 0,
      staged: 0,
      skippedForPendingLimit: 1,
      skippedForUnreadableReference: 0,
    });
    expect(await suggestionsFor(findingId)).toHaveLength(0);

    // Room frees up, and a redelivered completion stages the fix.
    const freedId =
      target.pendingIds.at(0) ?? panic("The seeded pending row is missing");
    await testDb
      .update(docxSuggestions)
      .set({ status: "rejected" })
      .where(eq(docxSuggestions.id, freedId));
    expect(await finalize(runId, target, 1)).toEqual({
      type: "completed",
      committed: 1,
      carried: 0,
      staged: 1,
      skippedForPendingLimit: 0,
      skippedForUnreadableReference: 0,
    });

    // At the cap again, the fix is already staged: it would insert nothing,
    // so it is not reported as skipped either.
    expect(await finalize(runId, target, 1)).toEqual({
      type: "completed",
      committed: 1,
      carried: 0,
      staged: 0,
      skippedForPendingLimit: 0,
      skippedForUnreadableReference: 0,
    });
    expect(await suggestionsFor(findingId)).toHaveLength(1);
  });
});

describe("a review whose reference text comes from another matter", () => {
  const database = () => asTestRaw<RlsDatabase<Transaction>>(testDb);

  const pinnedReference = (workspaceId: SafeId<"workspace">) => ({
    workspaceId,
    fileFieldId: ids.fieldA2,
    entityId: ids.entityA2,
    entityVersionId: ids.entityVersionA2,
    contentSha256: CONTENT_SHA256,
    workspaceName: "Reference matter",
    name: "Reference document",
  });

  const withReferences = (
    ...workspaceIds: SafeId<"workspace">[]
  ): DocumentReviewRunBasis => ({
    ...basis,
    references: workspaceIds.map(pinnedReference),
  });

  /** A playbook saved out of an earlier review: its positions quote another
   *  matter, and the run itself pins no references. */
  const withQuotedPosition = (
    workspaceId: SafeId<"workspace">,
    enabled = true,
  ): DocumentReviewRunBasis => ({
    ...basis,
    playbook: {
      ...basis.playbook,
      definitionSnapshot: {
        name: basis.playbook.definitionSnapshot.name,
        positions: {
          version: 3,
          items: [
            {
              mode: "graded",
              sourceId: FIXED_POSITION_ID,
              issue: FIXED_ISSUE,
              severity: "blocker",
              standard: {
                source: "reference",
                termKind: "parameter",
                passages: [
                  {
                    id: Bun.randomUUIDv7(),
                    workspaceId,
                    entityId: ids.entityA2,
                    fileFieldId: ids.fieldA2,
                    entityVersionId: ids.entityVersionA2,
                    blockId: "para-9",
                  },
                ],
              },
              ask: { mode: "auto" },
              enabled,
            },
          ],
        },
      },
    },
  });

  /** Completes through the worker's own handles, under the application role. */
  const finalizeAsWorker = async (runBasis: DocumentReviewRunBasis) => {
    const target = reviewTarget();
    const runId = await seedRunningRun(target, 1, runBasis);
    const findingId = await seedFinding(runId, target, payloadWithFix);
    const finish = async () =>
      await finalizeWorkerRun({
        actor: createRootRunActor(
          {
            organizationId: ids.orgA,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
            runId,
          },
          brandPersistedDocumentReviewRunId,
          database(),
        ),
        basis: runBasis,
        entityId: target.entityId,
        fileFieldId: target.fileFieldId,
        expectedFindingCount: 1,
      });
    return { runId, findingId, finish };
  };

  const stagedSources = async (
    findingId: SafeId<"documentReviewFinding">,
  ): Promise<string[][]> => {
    const rows = await testDb
      .select({ sources: docxSuggestions.sourceDataWorkspaceIds })
      .from(docxSuggestions)
      .where(eq(docxSuggestions.originReviewFindingId, findingId));
    return rows.map(({ sources }) => sources);
  };

  const runState = async (runId: SafeId<"documentReviewRun">) => {
    const rows = await testDb
      .select({
        status: documentReviewRuns.status,
        fixesWithheld: documentReviewRuns.fixesWithheld,
      })
      .from(documentReviewRuns)
      .where(eq(documentReviewRuns.id, runId));
    return rows.at(0);
  };

  const withoutReferenceMembership = async <T>(
    fn: () => Promise<T>,
  ): Promise<T> => {
    const removed = await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA2))
      .returning();
    try {
      return await fn();
    } finally {
      await testDb.insert(workspaceMembers).values(removed);
    }
  };

  const STAGED = {
    type: "completed" as const,
    committed: 1,
    carried: 0,
    staged: 1,
    skippedForPendingLimit: 0,
    skippedForUnreadableReference: 0,
  };
  const WITHHELD = {
    type: "completed" as const,
    committed: 1,
    carried: 0,
    staged: 0,
    skippedForPendingLimit: 0,
    skippedForUnreadableReference: 1,
  };

  afterEach(async () => {
    await testDb
      .delete(docxSuggestions)
      .where(isNotNull(docxSuggestions.originReviewFindingId));
  });

  test.each([
    ["a pinned reference", () => withReferences(ids.wsA2)],
    [
      "a position quoted by a saved playbook",
      () => withQuotedPosition(ids.wsA2),
    ],
  ])(
    "stages fixes that record %s's matter when the requester can open it",
    async (_label, runBasis) => {
      const { runId, findingId, finish } = await finalizeAsWorker(runBasis());

      expect(await finish()).toEqual(STAGED);
      expect(await runState(runId)).toEqual({
        status: "completed",
        fixesWithheld: 0,
      });
      expect(await stagedSources(findingId)).toEqual([[ids.wsA2]]);

      // A replay converges on the rows the first pass wrote.
      expect(await finish()).toEqual({ ...STAGED, staged: 0 });
      expect(await stagedSources(findingId)).toEqual([[ids.wsA2]]);
    },
  );

  test("a reference in the reviewed matter records no other source", async () => {
    const { findingId, finish } = await finalizeAsWorker(
      withReferences(ids.wsA1),
    );

    expect(await finish()).toEqual(STAGED);
    expect(await stagedSources(findingId)).toEqual([[]]);
  });

  test("withholds fixes and completes when the requester lost the reference matter", async () => {
    await withoutReferenceMembership(async () => {
      const { runId, findingId, finish } = await finalizeAsWorker(
        withReferences(ids.wsA2),
      );

      expect(await finish()).toEqual(WITHHELD);
      expect(await runState(runId)).toEqual({
        status: "completed",
        fixesWithheld: 1,
      });
      expect(await stagedSources(findingId)).toEqual([]);
      expect(await findingState(findingId)).toMatchObject({ decision: "open" });

      expect(await finish()).toEqual(WITHHELD);
      expect(await stagedSources(findingId)).toEqual([]);
    });
  });

  test("a disabled position's matter neither withholds fixes nor is recorded", async () => {
    // The requester cannot open wsB1, but the position quoting it is disabled.
    const { findingId, finish } = await finalizeAsWorker(
      withQuotedPosition(ids.wsB1, false),
    );

    expect(await finish()).toEqual(STAGED);
    expect(await stagedSources(findingId)).toEqual([[]]);
  });

  test("a replay that can stage withheld fixes clears the withheld count", async () => {
    const { runId, findingId, finish } = await finalizeAsWorker(
      withReferences(ids.wsA2),
    );
    await withoutReferenceMembership(async () => {
      expect(await finish()).toEqual(WITHHELD);
    });

    expect(await finish()).toEqual(STAGED);
    expect(await runState(runId)).toEqual({
      status: "completed",
      fixesWithheld: 0,
    });
    expect(await stagedSources(findingId)).toEqual([[ids.wsA2]]);
  });

  test("a replay after losing the reference matter does not count fixes already staged", async () => {
    const { runId, findingId, finish } = await finalizeAsWorker(
      withReferences(ids.wsA2),
    );
    expect(await finish()).toEqual(STAGED);

    await withoutReferenceMembership(async () => {
      expect(await finish()).toEqual({
        ...WITHHELD,
        skippedForUnreadableReference: 0,
      });
    });
    expect(await runState(runId)).toEqual({
      status: "completed",
      fixesWithheld: 0,
    });
    expect(await stagedSources(findingId)).toEqual([[ids.wsA2]]);
  });

  test("withholds every fix when only one of two reference matters is readable", async () => {
    // The requester is a member of wsB1, but it belongs to another organization.
    const { runId, findingId, finish } = await finalizeAsWorker(
      withReferences(ids.wsA2, ids.wsB1),
    );

    expect(await finish()).toEqual(WITHHELD);
    expect(await runState(runId)).toEqual({
      status: "completed",
      fixesWithheld: 1,
    });
    expect(await stagedSources(findingId)).toEqual([]);
  });

  test("withholds fixes when a reference matter is being deleted", async () => {
    const { runId, findingId, finish } = await finalizeAsWorker(
      withReferences(ids.wsA2),
    );
    await testDb
      .update(workspaces)
      .set({ status: WORKSPACE_STATUS.deleting })
      .where(eq(workspaces.id, ids.wsA2));
    try {
      expect(await finish()).toEqual(WITHHELD);
      expect(await runState(runId)).toEqual({
        status: "completed",
        fixesWithheld: 1,
      });
      expect(await stagedSources(findingId)).toEqual([]);
    } finally {
      await testDb
        .update(workspaces)
        .set({ status: WORKSPACE_STATUS.active })
        .where(eq(workspaces.id, ids.wsA2));
    }
  });

  test("a staged fix is readable only while its reader can open the source matter", async () => {
    const { findingId, finish } = await finalizeAsWorker(
      withReferences(ids.wsA2),
    );
    await finish();
    const readerSees = async () =>
      await createRootMembershipScopedDb(
        { organizationId: ids.orgA, userId: ids.userA1 },
        database(),
      )(
        async (tx) =>
          await tx
            .select({ id: docxSuggestions.id })
            .from(docxSuggestions)
            .where(
              and(
                eq(docxSuggestions.originReviewFindingId, findingId),
                eq(docxSuggestions.workspaceId, ids.wsA1),
              ),
            ),
      );

    expect(await readerSees()).toHaveLength(1);
    await withoutReferenceMembership(async () => {
      expect(await readerSees()).toHaveLength(0);
    });
  });
});
