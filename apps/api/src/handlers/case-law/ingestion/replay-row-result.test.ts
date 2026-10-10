import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { STORED_RAW_REPARSE_REJECTION } from "@/api/lib/legal-search/ingestion-types";

import {
  REPLAY_ROW_OUTCOME,
  replayRowResult,
  type ReplayRowResult,
} from "./replay";

const dispositions = {
  applied: "changed",
  unchanged: "unchanged",
  "would-apply": "changed",
  rejected: "rejected",
  "missing-payload": "rejected",
  retryable: null,
  withdrawn: "rejected",
  "withdraw-incomplete": null,
  "would-withdraw": "rejected",
} as const satisfies Record<
  (typeof REPLAY_ROW_OUTCOME)[keyof typeof REPLAY_ROW_OUTCOME],
  string | null
>;

test("canonical receipts preserve identity and classify every replay outcome", () => {
  const decisionId = createSafeId<"caseLawDecision">();
  for (const outcome of Object.values(REPLAY_ROW_OUTCOME)) {
    const receipt = replayRowResult(
      {
        id: decisionId,
        caseNumber: "receipt fixture",
        language: "cs",
        outcome,
        rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      },
      42,
    );
    const expected = dispositions[outcome];
    if (expected === null) {
      expect(receipt).toBeNull();
      continue;
    }
    expect(receipt?.decisionId).toBe(decisionId);
    expect(receipt?.targetParserVersion).toBe(42);
    expect(receipt?.outcome).toBe(expected);
    if (receipt?.outcome === "rejected") {
      const reason =
        outcome === REPLAY_ROW_OUTCOME.MISSING_PAYLOAD
          ? "missing-payload"
          : STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH;
      expect(receipt.reason).toBe(reason);
      continue;
    }
    expect(receipt).not.toHaveProperty("reason");
  }
});

test("canonical rejected receipts preserve every typed parser reason", () => {
  const decisionId = createSafeId<"caseLawDecision">();
  for (const reason of Object.values(STORED_RAW_REPARSE_REJECTION)) {
    const expected = {
      decisionId,
      targetParserVersion: 42,
      outcome: "rejected",
      reason,
    } as const satisfies ReplayRowResult;
    expect(
      replayRowResult(
        {
          id: decisionId,
          caseNumber: "receipt fixture",
          language: "cs",
          outcome: REPLAY_ROW_OUTCOME.REJECTED,
          rejection: reason,
        },
        42,
      ),
    ).toEqual(expected);
  }
});
