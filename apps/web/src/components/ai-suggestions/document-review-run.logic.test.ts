import { describe, expect, test } from "bun:test";

import {
  documentReviewRunPollInterval,
  resolveReviewRunRestore,
  resolveRunConflictAttachment,
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
