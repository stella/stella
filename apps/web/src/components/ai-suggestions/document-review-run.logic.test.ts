import { describe, expect, test } from "bun:test";

import type {
  DecidedReviewFinding,
  DocumentReviewDecision,
  DocumentReviewFindingRow,
  DocumentReviewRunDetail,
} from "@/components/ai-suggestions/document-review-queries";
import {
  applyFindingDecisions,
  documentReviewRunPollInterval,
  resolveReviewRunFreshness,
  resolveReviewRunRestore,
  resolveRunConflictAttachment,
  reviewDecisionProgress,
} from "@/components/ai-suggestions/document-review-run.logic";
import type { ReviewRunHistoryEntry } from "@/components/ai-suggestions/document-review-run.logic";
import { toSafeId } from "@/lib/safe-id";

const ACTIVE_RUN_ID = "0198f2c4-6a55-7c31-9a10-3b1d2f4c5e60";
const NEWER_COMPLETED_RUN_ID = "0198f2c4-5a11-7c31-9a10-3b1d2f4c5e61";
const OLDER_COMPLETED_RUN_ID = "0198f2c4-4b22-7c31-9a10-3b1d2f4c5e62";
const FAILED_RUN_ID = "0198f2c4-3c33-7c31-9a10-3b1d2f4c5e63";
const CANCELLED_RUN_ID = "0198f2c4-2d44-7c31-9a10-3b1d2f4c5e64";

const historyEntry = (
  id: string,
  status: ReviewRunHistoryEntry["status"],
  errorCode: ReviewRunHistoryEntry["errorCode"] = null,
): ReviewRunHistoryEntry => ({
  id: toSafeId<"documentReviewRun">(id),
  status,
  errorCode,
});

// The list endpoint answers newest first; every fixture below keeps that order.
describe("restoring a document's review", () => {
  test("attaches to the run still executing rather than an older result", () => {
    expect(
      resolveReviewRunRestore([
        historyEntry(ACTIVE_RUN_ID, "running"),
        historyEntry(NEWER_COMPLETED_RUN_ID, "completed"),
      ]),
    ).toEqual({ type: "active", runId: ACTIVE_RUN_ID });
  });

  test("a queued run counts as executing", () => {
    expect(
      resolveReviewRunRestore([historyEntry(ACTIVE_RUN_ID, "queued")]),
    ).toEqual({ type: "active", runId: ACTIVE_RUN_ID });
  });

  test("restores the latest completed run, past a later failure", () => {
    expect(
      resolveReviewRunRestore([
        historyEntry(FAILED_RUN_ID, "failed", "ai_unavailable"),
        historyEntry(NEWER_COMPLETED_RUN_ID, "completed"),
        historyEntry(OLDER_COMPLETED_RUN_ID, "completed"),
      ]),
    ).toEqual({ type: "completed", runId: NEWER_COMPLETED_RUN_ID });
  });

  test("reports the failure when the document has never completed a review", () => {
    expect(
      resolveReviewRunRestore([
        historyEntry(FAILED_RUN_ID, "failed", "pin_content_changed"),
      ]),
    ).toEqual({
      type: "failed",
      runId: FAILED_RUN_ID,
      errorCode: "pin_content_changed",
    });
  });

  test("offers the launcher for a document with no runs to show", () => {
    expect(resolveReviewRunRestore([])).toEqual({ type: "none" });
    expect(
      resolveReviewRunRestore([historyEntry(CANCELLED_RUN_ID, "cancelled")]),
    ).toEqual({ type: "none" });
  });
});

describe("a create that lost the race to an active run", () => {
  test("attaches to the run the server refused to duplicate", () => {
    expect(
      resolveRunConflictAttachment([
        historyEntry(ACTIVE_RUN_ID, "running"),
        historyEntry(OLDER_COMPLETED_RUN_ID, "completed"),
      ]),
    ).toBe(ACTIVE_RUN_ID);
  });

  test("attaches to the run that settled while the conflict was resolved", () => {
    expect(
      resolveRunConflictAttachment([
        historyEntry(NEWER_COMPLETED_RUN_ID, "completed"),
      ]),
    ).toBe(NEWER_COMPLETED_RUN_ID);
  });

  test("attaches to nothing when no run can be watched or read", () => {
    expect(resolveRunConflictAttachment([])).toBeNull();
    expect(
      resolveRunConflictAttachment([
        historyEntry(FAILED_RUN_ID, "failed", "internal"),
      ]),
    ).toBeNull();
  });
});

describe("polling a run", () => {
  test("polls while the run is unfinished and stops on every terminal status", () => {
    expect(documentReviewRunPollInterval("queued")).toBeGreaterThan(0);
    expect(documentReviewRunPollInterval("running")).toBeGreaterThan(0);
    expect(documentReviewRunPollInterval("completed")).toBe(false);
    expect(documentReviewRunPollInterval("failed")).toBe(false);
    expect(documentReviewRunPollInterval("cancelled")).toBe(false);
  });
});

// Every fixture below is the shape the endpoints actually answer with, so a
// renamed or re-typed field fails here rather than at runtime.
const COMPLETED_RUN_ID = toSafeId<"documentReviewRun">(
  "0198f2c4-1e55-7c31-9a10-3b1d2f4c5e65",
);
const OTHER_RUN_ID = toSafeId<"documentReviewRun">(
  "0198f2c4-1e55-7c31-9a10-3b1d2f4c5e66",
);
const FIRST_FINDING_ID = toSafeId<"documentReviewFinding">(
  "0198f2c4-1e55-7c31-9a10-3b1d2f4c5e70",
);
const SECOND_FINDING_ID = toSafeId<"documentReviewFinding">(
  "0198f2c4-1e55-7c31-9a10-3b1d2f4c5e71",
);
const REVIEWER_ID = toSafeId<"user">("0198f2c4-1e55-7c31-9a10-3b1d2f4c5e80");
const TOPIC_ID = "0198f2c4-1e55-7c31-9a10-3b1d2f4c5e90";
const REVIEWED_VERSION_ID = toSafeId<"entityVersion">(
  "0198f2c4-1e55-7c31-9a10-3b1d2f4c5ea0",
);
const CURRENT_VERSION_ID = toSafeId<"entityVersion">(
  "0198f2c4-1e55-7c31-9a10-3b1d2f4c5ea1",
);
const CONTENT_SHA256 =
  "9f2c1d7c4b6a58e30f1d2c3b4a5968770e1d2c3b4a5968779f2c1d7c4b6a58e3";

const finding = (
  id: DocumentReviewFindingRow["id"],
  decision: DocumentReviewDecision,
): DocumentReviewFindingRow => ({
  id,
  topicId: TOPIC_ID,
  topicTitle: "Notice period",
  checkKind: "reference",
  positionId: null,
  outcome: "different",
  payload: {
    checkKind: "reference",
    finding: {
      findingId: `reference-${TOPIC_ID}`,
      topicId: TOPIC_ID,
      issue: "Notice period",
      assessment: "different",
      consensus: "single",
      explanation: {
        type: "comparison",
        text: "The reference uses a longer period.",
      },
      targetCitations: [],
      referenceCitations: [],
      fix: null,
    },
  },
  decision,
  decidedBy: null,
  decidedAt: null,
  applicationStatus: "pending",
  appliedBy: null,
  appliedAt: null,
});

const cachedRun = (
  findings: readonly DocumentReviewFindingRow[],
): DocumentReviewRunDetail => ({
  run: {
    id: COMPLETED_RUN_ID,
    status: "completed",
    errorCode: null,
    entityId: toSafeId<"entity">("0198f2c4-1e55-7c31-9a10-3b1d2f4c5eb0"),
    fileFieldId: toSafeId<"field">("0198f2c4-1e55-7c31-9a10-3b1d2f4c5eb1"),
    entityVersionId: REVIEWED_VERSION_ID,
    contentSha256: CONTENT_SHA256,
    basis: {
      type: "references",
      perspective: { type: "party", role: "Buyer", name: null },
      references: [
        {
          workspaceId: toSafeId<"workspace">(
            "0198f2c4-1e55-7c31-9a10-3b1d2f4c5eb5",
          ),
          workspaceName: "Precedent matter",
          entityId: toSafeId<"entity">("0198f2c4-1e55-7c31-9a10-3b1d2f4c5eb2"),
          fileFieldId: toSafeId<"field">(
            "0198f2c4-1e55-7c31-9a10-3b1d2f4c5eb3",
          ),
          entityVersionId: toSafeId<"entityVersion">(
            "0198f2c4-1e55-7c31-9a10-3b1d2f4c5eb4",
          ),
          contentSha256: CONTENT_SHA256,
          name: "Master agreement",
        },
      ],
    },
    topics: [
      {
        type: "reference",
        topicId: TOPIC_ID,
        title: "Notice period",
        context: "",
        included: true,
      },
    ],
    total: findings.length,
    completed: findings.length,
    pipelineVersion: 1,
    createdAt: "2026-08-12T08:00:00.000Z",
    startedAt: "2026-08-12T08:00:01.000Z",
    finishedAt: "2026-08-12T08:00:30.000Z",
    playbookStale: false,
    playbookMissing: false,
    // Deliberately the counts the run was read with: the mapper recounts them
    // from the rows, so a seeded tally cannot be what makes a test pass.
    decisionCounts: { open: findings.length, accepted: 0, dismissed: 0 },
  },
  findings: [...findings],
});

const decided = (
  id: DecidedReviewFinding["id"],
  decision: DocumentReviewDecision,
  runId: DecidedReviewFinding["runId"] = COMPLETED_RUN_ID,
): DecidedReviewFinding => ({
  id,
  runId,
  decision,
  decidedBy: decision === "open" ? null : REVIEWER_ID,
  decidedAt: decision === "open" ? null : "2026-08-12T09:00:00.000Z",
  applicationStatus: "pending",
  appliedBy: null,
  appliedAt: null,
});

describe("recording a decision in the cached run", () => {
  test("writes the decided row and recounts the run's decisions", () => {
    const updated = applyFindingDecisions(
      cachedRun([
        finding(FIRST_FINDING_ID, "open"),
        finding(SECOND_FINDING_ID, "open"),
      ]),
      [decided(FIRST_FINDING_ID, "accepted")],
    );

    expect(updated?.findings.map((row) => row.decision)).toEqual([
      "accepted",
      "open",
    ]);
    expect(updated?.findings.at(0)?.decidedBy).toBe(REVIEWER_ID);
    expect(updated?.findings.at(0)?.decidedAt).toBe("2026-08-12T09:00:00.000Z");
    expect(updated?.run.decisionCounts).toEqual({
      open: 1,
      accepted: 1,
      dismissed: 0,
    });
  });

  test("decides every finding behind one card in a single write", () => {
    const updated = applyFindingDecisions(
      cachedRun([
        finding(FIRST_FINDING_ID, "open"),
        finding(SECOND_FINDING_ID, "open"),
      ]),
      [
        decided(FIRST_FINDING_ID, "dismissed"),
        decided(SECOND_FINDING_ID, "dismissed"),
      ],
    );

    expect(updated?.run.decisionCounts).toEqual({
      open: 0,
      accepted: 0,
      dismissed: 2,
    });
  });

  test("reopening withdraws the decider and the moment", () => {
    const reopened = applyFindingDecisions(
      cachedRun([finding(FIRST_FINDING_ID, "accepted")]),
      [decided(FIRST_FINDING_ID, "open")],
    );

    const reopenedFinding = reopened?.findings.at(0);
    expect(reopenedFinding?.decision).toBe("open");
    expect(reopenedFinding?.decidedBy).toBeNull();
    expect(reopenedFinding?.decidedAt).toBeNull();
    expect(reopened?.run.decisionCounts).toEqual({
      open: 1,
      accepted: 0,
      dismissed: 0,
    });
  });

  test("ignores a decision recorded against another run", () => {
    const cached = cachedRun([finding(FIRST_FINDING_ID, "open")]);
    const updated = applyFindingDecisions(cached, [
      decided(FIRST_FINDING_ID, "accepted", OTHER_RUN_ID),
    ]);

    expect(updated?.findings.at(0)?.decision).toBe("open");
    expect(updated?.run.decisionCounts).toEqual({
      open: 1,
      accepted: 0,
      dismissed: 0,
    });
  });

  test("leaves an empty cache entry empty rather than inventing a run", () => {
    expect(
      applyFindingDecisions(undefined, [decided(FIRST_FINDING_ID, "accepted")]),
    ).toBeUndefined();
  });
});

describe("how far the reviewer has worked through a run", () => {
  test("counts every decision taken against every finding", () => {
    expect(
      reviewDecisionProgress({ open: 3, accepted: 2, dismissed: 1 }),
    ).toEqual({ decided: 3, total: 6 });
    expect(
      reviewDecisionProgress({ open: 0, accepted: 0, dismissed: 0 }),
    ).toEqual({ decided: 0, total: 0 });
  });
});

describe("whether a completed review still describes the document", () => {
  const freshRun = {
    entityVersionId: REVIEWED_VERSION_ID,
    playbookStale: false,
    playbookMissing: false,
  };

  test("reports the document as changed once it has a newer version", () => {
    expect(
      resolveReviewRunFreshness({
        run: freshRun,
        currentEntityVersionId: CURRENT_VERSION_ID,
      }),
    ).toEqual({ documentChanged: true, playbook: "current" });
  });

  test("reports no change while the current version is the reviewed one", () => {
    expect(
      resolveReviewRunFreshness({
        run: freshRun,
        currentEntityVersionId: REVIEWED_VERSION_ID,
      }),
    ).toEqual({ documentChanged: false, playbook: "current" });
  });

  test("stays silent while the current version is unknown", () => {
    expect(
      resolveReviewRunFreshness({
        run: freshRun,
        currentEntityVersionId: null,
      }),
    ).toEqual({ documentChanged: false, playbook: "current" });
  });

  test("reports a playbook that has been approved again since the run", () => {
    expect(
      resolveReviewRunFreshness({
        run: { ...freshRun, playbookStale: true },
        currentEntityVersionId: REVIEWED_VERSION_ID,
      }),
    ).toEqual({ documentChanged: false, playbook: "stale" });
  });

  test("reports a deleted playbook as missing, never as stale", () => {
    expect(
      resolveReviewRunFreshness({
        run: { ...freshRun, playbookStale: true, playbookMissing: true },
        currentEntityVersionId: CURRENT_VERSION_ID,
      }),
    ).toEqual({ documentChanged: true, playbook: "missing" });
  });
});
