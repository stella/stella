import { describe, expect, test } from "bun:test";

import type {
  ApprovalEntry,
  ApprovalResult,
} from "@/features/time-approval-queue/queries";
import { toSafeId } from "@/lib/safe-id";

import {
  applyApprovalResults,
  RETURN_COMMENT_MAX_LENGTH,
  validateReturnComment,
} from "./approval-state";

const entry = {
  id: toSafeId<"timeEntry">("entry-a"),
  workspaceId: toSafeId<"workspace">("matter-a"),
  userId: "member-a",
  dateWorked: "2026-09-30",
  timezoneId: "UTC",
  durationMinutes: 45,
  billedMinutes: 60,
  narrative: "Preparing a submission",
  billable: true,
  status: "draft",
  approverUserId: "reviewer-a",
  approvedByUserId: null,
  approvedAt: null,
  returnedAt: null,
  returnedByUserId: null,
  returnComment: null,
} satisfies ApprovalEntry;

const refused = {
  ...entry,
  id: toSafeId<"timeEntry">("entry-b"),
  returnComment: "Clarify the work performed.",
} satisfies ApprovalEntry;
const untouched = {
  ...entry,
  id: toSafeId<"timeEntry">("entry-c"),
} satisfies ApprovalEntry;

describe("partial approval results", () => {
  test("removes successful entries while preserving refused snapshots and unsubmitted selection", () => {
    const entries = [entry, refused, untouched];
    const selectedIds = [entry.id, untouched.id];
    const results = [
      { id: entry.id, status: "approved" },
      { id: refused.id, status: "refused", reason: "time_period_locked" },
    ] satisfies ApprovalResult[];
    const next = applyApprovalResults({ entries, selectedIds, results });
    expect(next.entries).toEqual([refused, untouched]);
    expect(next.entries.at(0)).toBe(refused);
    expect(next.entries.at(1)).toBe(untouched);
    expect(next.selectedIds.toSorted()).toEqual(
      [refused.id, untouched.id].toSorted(),
    );
    expect(entries).toEqual([entry, refused, untouched]);
    expect(selectedIds).toEqual([entry.id, untouched.id]);
  });

  test("replaying a partial result is a fixed point", () => {
    const results = [
      { id: entry.id, status: "approved" },
      { id: refused.id, status: "refused", reason: "running_timer" },
    ] satisfies ApprovalResult[];
    const first = applyApprovalResults({
      entries: [entry, refused],
      selectedIds: [entry.id, refused.id],
      results,
    });
    expect(applyApprovalResults({ ...first, results })).toEqual(first);
    expect(first.selectedIds).toEqual([refused.id]);
  });

  test("a fully refused batch preserves every snapshot", () => {
    const results = [
      { id: entry.id, status: "refused", reason: "not_approver" },
      { id: refused.id, status: "refused", reason: "unpriced" },
    ] satisfies ApprovalResult[];
    const next = applyApprovalResults({
      entries: [entry, refused],
      selectedIds: [],
      results,
    });
    expect(next.entries).toEqual([entry, refused]);
    expect(next.entries.at(0)).toBe(entry);
    expect(next.entries.at(1)).toBe(refused);
    expect(next.selectedIds).toEqual([entry.id, refused.id]);
  });
});

describe("return comments", () => {
  test("requires meaningful text after trimming", () => {
    for (const raw of ["", " ", "\n\t"]) {
      expect(validateReturnComment(raw)).toEqual({
        status: "invalid",
        key: "billing.approvalQueue.commentRequired",
      });
    }
    expect(validateReturnComment("  Clarify the work performed.\n")).toEqual({
      status: "valid",
      comment: "Clarify the work performed.",
    });
  });

  test("accepts the exact comment boundary and rejects longer trimmed text", () => {
    const comment = "x".repeat(RETURN_COMMENT_MAX_LENGTH);
    expect(validateReturnComment(` ${comment} `)).toEqual({
      status: "valid",
      comment,
    });
    expect(validateReturnComment(`${comment}x`)).toEqual({
      status: "invalid",
      key: "billing.approvalQueue.commentTooLong",
    });
  });
});
