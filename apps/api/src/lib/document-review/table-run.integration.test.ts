/**
 * What a files-table review run owes the data, exercised against a real
 * PostgreSQL schema because the schema is what enforces it:
 *
 *  - a run per document, pinned to that document's own version and content
 *    hash, and never a second one for a document already under review,
 *  - opening runs writes no columns at all, which is the whole point of the
 *    unprojected run,
 *  - completion runs through the shared finalizer, so a table run inherits the
 *    decisions of the document's previous review exactly as a queued one does,
 *  - deleting a playbook, or the columns it materialized, leaves the recorded
 *    judgment standing.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, count, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  documentReviewFindings,
  documentReviewRuns,
  playbookDefinitions,
  properties,
  propertyDependencies,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewFindingPayload,
  PinnedPlaybook,
} from "@/api/lib/document-review/run-contract";
import { finalizeReviewRun } from "@/api/lib/document-review/run-finalize";
import { createPlaybookTableRuns } from "@/api/lib/document-review/table-run-create";
import {
  deletePlaybookColumns,
  deletePlaybookPositionColumns,
} from "@/api/lib/properties/delete-playbook-columns";
import type { Position } from "@/api/lib/workflow/playbook-positions";
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
// Tracked by kind, because that is what taking them down again requires: a
// verdict column's dependency edge restricts deleting the ASK column it reads.
const seededAskIds: SafeId<"property">[] = [];
const seededVerdictIds: SafeId<"property">[] = [];
const seededPlaybookIds: SafeId<"playbookDefinition">[] = [];

const POSITION_ID = "11111111-1111-4111-8111-111111111111";
/** The fixture's only DOCX document lives in wsA1 and hashes to this. */
const FIXTURE_CONTENT_SHA256 = "a".repeat(64);

/** The generated name of the ON DELETE RESTRICT edge from a dependency row to
 *  the column it reads. Named exactly as the migration created it: a rename
 *  fails this assertion rather than quietly leaving the rule untested. */
const DEPENDS_ON_RESTRICT_FK = "property_dependencies_zmwulDNP36AP_fkey";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const VIOLATION_FIELDS = ["message", "constraint", "detail"] as const;

/** Everything a failure says about which rule it broke, walked through
 *  `cause`, so "some error was thrown" cannot pass as proof. */
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

const rejectionOf = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(
    () => null,
    (error: unknown) => error,
  );

const gradedPosition: Position = {
  mode: "graded",
  sourceId: POSITION_ID,
  issue: "Termination notice",
  severity: "high",
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: [],
        ideal: { source: "inline", text: "Thirty days' written notice." },
      },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  ask: {
    mode: "manual",
    question: "What is the notice period?",
    content: { version: 1, type: "text" },
  },
  enabled: true,
};

const pinnedPlaybook = (
  definitionId: SafeId<"playbookDefinition">,
): PinnedPlaybook => ({
  definitionId,
  versionId: null,
  provenance: "draft",
  definitionSnapshot: {
    name: "Termination review",
    positions: { version: 3, items: [gradedPosition] },
  },
});

const playbookPayload: DocumentReviewFindingPayload = {
  finding: {
    positionId: POSITION_ID,
    issue: "Termination notice",
    severity: "high",
    standardSource: "tiers",
    verdict: "deviation",
    delta: { kind: "language" },
    extracted: { value: "14 days", text: "14 days" },
    rationale: "The period is shorter than the preferred position.",
    citations: [],
    fix: null,
  },
};

const seedPlaybookDefinition = async (): Promise<
  SafeId<"playbookDefinition">
> => {
  const definitionId = toSafeId<"playbookDefinition">(Bun.randomUUIDv7());
  seededPlaybookIds.push(definitionId);
  await testDb.insert(playbookDefinitions).values({
    id: definitionId,
    organizationId: ids.orgA,
    name: "Termination review",
    positions: { version: 3, items: [gradedPosition] },
  });
  return definitionId;
};

/** The ASK + verdict pair a projected run materializes, wired by the same
 *  dependency edge `materializePlaybookRun` writes. */
const seedMaterializedColumns = async (
  definitionId: SafeId<"playbookDefinition">,
): Promise<{ askId: SafeId<"property">; verdictId: SafeId<"property"> }> => {
  const askId = toSafeId<"property">(Bun.randomUUIDv7());
  const verdictId = toSafeId<"property">(Bun.randomUUIDv7());
  seededAskIds.push(askId);
  seededVerdictIds.push(verdictId);
  await testDb.insert(properties).values([
    {
      id: askId,
      workspaceId: ids.wsA1,
      name: "Termination notice",
      status: "stale",
      content: { version: 1, type: "text" },
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "What is the notice period?",
      },
      playbookSourceId: POSITION_ID,
      playbookDefinitionId: definitionId,
    },
    {
      id: verdictId,
      workspaceId: ids.wsA1,
      name: "Termination notice (verdict)",
      status: "stale",
      content: {
        version: 1,
        type: "single-select",
        options: [{ value: "deviation", color: "red" }],
        fallback: null,
      },
      tool: {
        version: 1,
        type: "playbook-verdict",
        askPropertyId: askId,
        rule: { kind: "positionMatch" },
        severity: "high",
        tiers: { fallbacks: [], acceptableRules: [], notAcceptableRules: [] },
      },
      playbookSourceId: POSITION_ID,
      playbookDefinitionId: definitionId,
    },
  ]);
  await testDb.insert(propertyDependencies).values({
    workspaceId: ids.wsA1,
    propertyId: verdictId,
    dependsOnPropertyId: askId,
    condition: null,
  });
  return { askId, verdictId };
};

const openTableRuns = async (definitionId: SafeId<"playbookDefinition">) => {
  const result = await createPlaybookTableRuns({
    tx: asTestRaw<Transaction>(testDb),
    workspaceId: ids.wsA1,
    organizationId: ids.orgA,
    userId: ids.userA1,
    playbook: pinnedPlaybook(definitionId),
    docTypeGate: null,
    projection: "none",
  });
  for (const run of result.runs) {
    seededRunIds.push(run.runId);
  }
  return result;
};

const seedFinding = async (
  runId: SafeId<"documentReviewRun">,
): Promise<SafeId<"documentReviewFinding">> => {
  const findingId = toSafeId<"documentReviewFinding">(Bun.randomUUIDv7());
  await testDb.insert(documentReviewFindings).values({
    id: findingId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    runId,
    entityId: ids.entityA1,
    fileFieldId: ids.fileFieldA1,
    entityVersionId: ids.entityVersionA1,
    positionId: POSITION_ID,
    positionTitle: "Termination notice",
    outcome: "deviation",
    payload: playbookPayload,
  });
  return findingId;
};

const propertyCount = async (): Promise<number> => {
  const rows = await testDb
    .select({ value: count() })
    .from(properties)
    .where(eq(properties.workspaceId, ids.wsA1));
  return rows.at(0)?.value ?? 0;
};

/**
 * Take materialized columns down the way the product does, through the helper
 * `materializePlaybookRun` uses. A single statement over both kinds violates
 * the dependency edge's RESTRICT, which is a fact about the schema the fixture
 * has to respect rather than work around.
 */
const removeColumns = async (
  verdictIds: readonly SafeId<"property">[],
  askIds: readonly SafeId<"property">[],
): Promise<void> => {
  await deletePlaybookColumns({
    tx: asTestRaw<Transaction>(testDb),
    workspaceId: ids.wsA1,
    verdictIds,
    askIds,
  });
};

const clearRuns = async (): Promise<void> => {
  if (seededRunIds.length === 0) {
    return;
  }
  await testDb
    .delete(documentReviewRuns)
    .where(inArray(documentReviewRuns.id, seededRunIds));
  seededRunIds.length = 0;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    await clearRuns();
    await removeColumns(seededVerdictIds, seededAskIds);
    if (seededPlaybookIds.length > 0) {
      await testDb
        .delete(playbookDefinitions)
        .where(inArray(playbookDefinitions.id, seededPlaybookIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("opening runs for a files table", () => {
  test("pins one run per document and materializes no columns", async () => {
    const definitionId = await seedPlaybookDefinition();
    const before = await propertyCount();

    const opened = await openTableRuns(definitionId);

    expect(opened.runs).toHaveLength(1);
    expect(opened.expectedFindingCount).toBe(1);
    expect(opened.uncoveredCount).toBe(0);

    const rows = await testDb
      .select({
        entityId: documentReviewRuns.entityId,
        entityVersionId: documentReviewRuns.entityVersionId,
        fileFieldId: documentReviewRuns.fileFieldId,
        contentSha256: documentReviewRuns.contentSha256,
        playbookDefinitionId: documentReviewRuns.playbookDefinitionId,
        status: documentReviewRuns.status,
        executor: documentReviewRuns.executor,
        total: documentReviewRuns.total,
      })
      .from(documentReviewRuns)
      .where(inArray(documentReviewRuns.id, seededRunIds));

    expect(rows).toEqual([
      {
        entityId: ids.entityA1,
        entityVersionId: ids.entityVersionA1,
        fileFieldId: ids.fileFieldA1,
        contentSha256: FIXTURE_CONTENT_SHA256,
        playbookDefinitionId: definitionId,
        // Unprojected: the review queue owns it, so it waits to be claimed.
        status: "queued",
        executor: "worker",
        total: 1,
      },
    ]);
    // The point of an unprojected run: not one column against the workspace's
    // column budget.
    expect(await propertyCount()).toBe(before);

    // A document already under review is left alone rather than reviewed twice.
    const second = await createPlaybookTableRuns({
      tx: asTestRaw<Transaction>(testDb),
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      userId: ids.userA1,
      playbook: pinnedPlaybook(definitionId),
      docTypeGate: null,
      projection: "none",
    });
    expect(second.runs).toEqual([]);
    expect(second.skippedActiveCount).toBe(1);

    await clearRuns();
  });

  test("a completed run hands its decisions to the next one", async () => {
    const definitionId = await seedPlaybookDefinition();

    const first = await openTableRuns(definitionId);
    const firstRunId = first.runs.at(0)?.runId;
    expect(firstRunId).toBeDefined();
    if (firstRunId === undefined) {
      return;
    }
    await testDb
      .update(documentReviewRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(documentReviewRuns.id, firstRunId));
    await seedFinding(firstRunId);

    const finalized = await finalizeReviewRun({
      tx: asTestRaw<Transaction>(testDb),
      workspaceId: ids.wsA1,
      runId: firstRunId,
      entityId: ids.entityA1,
      fileFieldId: ids.fileFieldA1,
      executor: DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE,
      expectedFindingCount: 1,
    });
    expect(finalized).toEqual({
      type: "completed",
      committed: 1,
      carried: 0,
      staged: 0,
    });

    const decidedAt = new Date();
    await testDb
      .update(documentReviewFindings)
      .set({ decision: "accepted", decidedBy: ids.userA1, decidedAt })
      .where(eq(documentReviewFindings.runId, firstRunId));

    // The re-run repeats the same judgment about the same evidence, so the
    // reading a lawyer already did moves onto it — through the one finalizer
    // both producers call.
    const second = await openTableRuns(definitionId);
    const secondRunId = second.runs.at(0)?.runId;
    expect(secondRunId).toBeDefined();
    if (secondRunId === undefined) {
      return;
    }
    await testDb
      .update(documentReviewRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(documentReviewRuns.id, secondRunId));
    await seedFinding(secondRunId);

    const refinalized = await finalizeReviewRun({
      tx: asTestRaw<Transaction>(testDb),
      workspaceId: ids.wsA1,
      runId: secondRunId,
      entityId: ids.entityA1,
      fileFieldId: ids.fileFieldA1,
      executor: DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE,
      expectedFindingCount: 1,
    });
    expect(refinalized).toEqual({
      type: "completed",
      committed: 1,
      carried: 1,
      staged: 0,
    });

    const carried = await testDb
      .select({
        decision: documentReviewFindings.decision,
        decidedBy: documentReviewFindings.decidedBy,
      })
      .from(documentReviewFindings)
      .where(eq(documentReviewFindings.runId, secondRunId));
    expect(carried).toEqual([{ decision: "accepted", decidedBy: ids.userA1 }]);

    await clearRuns();
  });
});

describe("deleting what a review was measured against", () => {
  test("deleting one visible playbook result removes its ASK and verdict rows", async () => {
    const definitionId = await seedPlaybookDefinition();
    const { askId, verdictId } = await seedMaterializedColumns(definitionId);

    await deletePlaybookPositionColumns({
      tx: asTestRaw<Transaction>(testDb),
      workspaceId: ids.wsA1,
      playbookSourceId: POSITION_ID,
    });

    const remaining = await testDb
      .select({ id: properties.id })
      .from(properties)
      .where(inArray(properties.id, [askId, verdictId]));
    expect(remaining).toEqual([]);
  });

  test("deleting the playbook orphans its columns and keeps the findings", async () => {
    const definitionId = await seedPlaybookDefinition();
    const { askId, verdictId } = await seedMaterializedColumns(definitionId);
    const opened = await openTableRuns(definitionId);
    const runId = opened.runs.at(0)?.runId;
    expect(runId).toBeDefined();
    if (runId === undefined) {
      return;
    }
    const findingId = await seedFinding(runId);

    await testDb
      .delete(playbookDefinitions)
      .where(eq(playbookDefinitions.id, definitionId));

    const columns = await testDb
      .select({
        id: properties.id,
        playbookDefinitionId: properties.playbookDefinitionId,
        playbookSourceId: properties.playbookSourceId,
      })
      .from(properties)
      .where(inArray(properties.id, [askId, verdictId]));
    expect(columns).toHaveLength(2);
    // Orphaned, not dropped: the reference nulls, and the sourceId that lets a
    // recreated playbook re-adopt the column survives.
    expect(
      columns.every((column) => column.playbookDefinitionId === null),
    ).toBe(true);
    expect(
      columns.every((column) => column.playbookSourceId === POSITION_ID),
    ).toBe(true);

    const findings = await testDb
      .select({ id: documentReviewFindings.id })
      .from(documentReviewFindings)
      .where(eq(documentReviewFindings.id, findingId));
    expect(findings).toEqual([{ id: findingId }]);

    await clearRuns();
  });

  test("deleting the columns keeps the findings, and honors the dependency edge", async () => {
    const definitionId = await seedPlaybookDefinition();
    const { askId, verdictId } = await seedMaterializedColumns(definitionId);
    const opened = await openTableRuns(definitionId);
    const runId = opened.runs.at(0)?.runId;
    expect(runId).toBeDefined();
    if (runId === undefined) {
      return;
    }
    const findingId = await seedFinding(runId);

    // The verdict column reads the ASK column, so the ASK cannot go first.
    // This is the rule `handlers/properties/delete.ts` answers 400 for when a
    // reviewer tries to delete one column on its own.
    expect(
      violationText(await rejectionOf(removeColumns([], [askId]))),
    ).toContain(DEPENDS_ON_RESTRICT_FK);

    // Taken down through the same helper `materializePlaybookRun` uses, so the
    // fixture cannot drift from the order the product deletes in.
    await removeColumns([verdictId], [askId]);

    const remaining = await testDb
      .select({ id: properties.id })
      .from(properties)
      .where(inArray(properties.id, [askId, verdictId]));
    expect(remaining).toEqual([]);

    // The judgment never referenced a column, so losing both leaves it whole.
    const findings = await testDb
      .select({
        id: documentReviewFindings.id,
        outcome: documentReviewFindings.outcome,
        payload: documentReviewFindings.payload,
      })
      .from(documentReviewFindings)
      .where(
        and(
          eq(documentReviewFindings.id, findingId),
          eq(documentReviewFindings.workspaceId, ids.wsA1),
        ),
      );
    expect(findings).toEqual([
      { id: findingId, outcome: "deviation", payload: playbookPayload },
    ]);

    await clearRuns();
  });
});
