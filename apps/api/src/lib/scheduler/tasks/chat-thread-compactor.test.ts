import { describe, expect, test } from "bun:test";

import type { ChatCompactionOutcome } from "@/api/lib/chat/thread-compaction";

import { settlementForOutcome } from "./chat-thread-compactor";
import { CHAT_COMPACTION_SETTLEMENT } from "./chat-thread-compactor-queue";

/**
 * Every outcome the compactor can report, so the map below is exercised over
 * the whole union rather than the branches that happened to come to mind.
 */
const OUTCOMES = [
  { hasMoreDelta: true, summarizedMessageCount: 5, type: "advanced" },
  { hasMoreDelta: false, summarizedMessageCount: 5, type: "advanced" },
  { type: "up-to-date" },
  { type: "no-summary" },
  { type: "superseded" },
] as const satisfies readonly ChatCompactionOutcome[];

describe("compaction outcome settlement", () => {
  test("only a run that is still behind comes straight back", () => {
    expect(
      settlementForOutcome({
        hasMoreDelta: true,
        summarizedMessageCount: 5,
        type: "advanced",
      }),
    ).toBe(CHAT_COMPACTION_SETTLEMENT.REQUEUED);

    expect(
      settlementForOutcome({
        hasMoreDelta: false,
        summarizedMessageCount: 5,
        type: "advanced",
      }),
    ).toBe(CHAT_COMPACTION_SETTLEMENT.DRAINED);
  });

  test("an empty model response is settled as a failure, not a completion", () => {
    // The distinction the whole retry path rests on: draining here would leave
    // the delta unsummarized until some later send re-enqueued the thread,
    // while failing keeps it queued behind a backoff.
    expect(settlementForOutcome({ type: "no-summary" })).toBe(
      CHAT_COMPACTION_SETTLEMENT.FAILED,
    );
    expect(settlementForOutcome({ type: "up-to-date" })).toBe(
      CHAT_COMPACTION_SETTLEMENT.DRAINED,
    );
  });

  test("a superseded run leaves the follow-up to whatever superseded it", () => {
    expect(settlementForOutcome({ type: "superseded" })).toBe(
      CHAT_COMPACTION_SETTLEMENT.DRAINED,
    );
  });

  test("no outcome retries without a backoff", () => {
    // The property that keeps a deterministically failing thread from being
    // re-claimed every tick: the only settlement that comes due immediately is
    // one that made progress.
    for (const outcome of OUTCOMES) {
      const settlement = settlementForOutcome(outcome);
      if (settlement === CHAT_COMPACTION_SETTLEMENT.REQUEUED) {
        expect(outcome.type).toBe("advanced");
      }
    }
  });

  test("every outcome is mapped", () => {
    // Declared set equals exercised set: a new outcome added without a
    // settlement decision fails the exhaustiveness check in the map itself,
    // and this fails if one is added here without being handled.
    for (const outcome of OUTCOMES) {
      expect(settlementForOutcome(outcome)).toBeOneOf([
        CHAT_COMPACTION_SETTLEMENT.DRAINED,
        CHAT_COMPACTION_SETTLEMENT.REQUEUED,
        CHAT_COMPACTION_SETTLEMENT.FAILED,
      ]);
    }
  });
});
