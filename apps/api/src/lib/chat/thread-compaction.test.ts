import { describe, expect, test } from "bun:test";

import {
  CHAT_COMPACTION_MEMORY_ELIGIBILITIES,
  CHAT_COMPACTION_MEMORY_ELIGIBILITY,
  CHAT_COMPACTION_MEMORY_EXTRACTABLE,
} from "@/api/db/schema";
import type { ChatCompactionMemoryEligibility } from "@/api/db/schema";

import { resolveCheckpointMemoryEligibility } from "./thread-compaction";

const eligibleMessages = [
  { memoryExtractionEligible: true },
  { memoryExtractionEligible: true },
];
const messagesWithOptOut = [
  { memoryExtractionEligible: true },
  { memoryExtractionEligible: false },
];

describe("checkpoint memory eligibility", () => {
  test("a first segment of eligible messages under an enabled deployment is extractable", () => {
    expect(
      resolveCheckpointMemoryEligibility({
        extractionFeatureEnabled: true,
        previous: null,
        segmentMessages: eligibleMessages,
      }),
    ).toBe(CHAT_COMPACTION_MEMORY_ELIGIBILITY.ELIGIBLE);
  });

  test("one opted-out message disqualifies the whole segment", () => {
    // The summary cannot separate the opted-out message from the rest, so the
    // verdict is a property of the segment, not of individual messages.
    expect(
      resolveCheckpointMemoryEligibility({
        extractionFeatureEnabled: true,
        previous: null,
        segmentMessages: messagesWithOptOut,
      }),
    ).toBe(CHAT_COMPACTION_MEMORY_ELIGIBILITY.MESSAGE_OPTED_OUT);
  });

  test("a segment summarized while extraction is disabled records that reason", () => {
    expect(
      resolveCheckpointMemoryEligibility({
        extractionFeatureEnabled: false,
        previous: null,
        segmentMessages: eligibleMessages,
      }),
    ).toBe(CHAT_COMPACTION_MEMORY_ELIGIBILITY.CONSENT_INACTIVE);
  });

  test("a user opt-out outranks a disabled deployment", () => {
    // Re-enabling the deployment must not be able to reinterpret this segment,
    // so the reason recorded is the one that survives a flag change.
    expect(
      resolveCheckpointMemoryEligibility({
        extractionFeatureEnabled: false,
        previous: null,
        segmentMessages: messagesWithOptOut,
      }),
    ).toBe(CHAT_COMPACTION_MEMORY_ELIGIBILITY.MESSAGE_OPTED_OUT);
  });

  test("every non-extractable verdict is inherited unchanged, whatever the deployment now says", () => {
    // The re-enable case. A later segment of perfectly eligible messages, under
    // an enabled deployment, still cannot make the chain extractable: its
    // summary folds in the earlier one, which covered content that was not.
    const inherited = CHAT_COMPACTION_MEMORY_ELIGIBILITIES.filter(
      (eligibility) => !CHAT_COMPACTION_MEMORY_EXTRACTABLE[eligibility],
    );
    expect(inherited.length).toBeGreaterThan(0);

    for (const previous of inherited) {
      expect(
        resolveCheckpointMemoryEligibility({
          extractionFeatureEnabled: true,
          previous,
          segmentMessages: eligibleMessages,
        }),
      ).toBe(previous);
    }
  });

  test("an extractable chain is re-evaluated on each segment", () => {
    // The inverse of inheritance: staying eligible is not sticky, so a later
    // opt-out still takes effect.
    expect(
      resolveCheckpointMemoryEligibility({
        extractionFeatureEnabled: true,
        previous: CHAT_COMPACTION_MEMORY_ELIGIBILITY.ELIGIBLE,
        segmentMessages: messagesWithOptOut,
      }),
    ).toBe(CHAT_COMPACTION_MEMORY_ELIGIBILITY.MESSAGE_OPTED_OUT);
  });

  test("the verdict is never extractable unless every input allows it", () => {
    // Property over the whole input class: extractability requires an eligible
    // (or absent) predecessor, an all-eligible segment, and an enabled
    // deployment. Any one missing must deny.
    const predecessors: (ChatCompactionMemoryEligibility | null)[] = [
      null,
      ...CHAT_COMPACTION_MEMORY_ELIGIBILITIES,
    ];

    for (const previous of predecessors) {
      for (const segmentMessages of [eligibleMessages, messagesWithOptOut]) {
        for (const extractionFeatureEnabled of [true, false]) {
          const verdict = resolveCheckpointMemoryEligibility({
            extractionFeatureEnabled,
            previous,
            segmentMessages,
          });
          const predecessorAllows =
            previous === null || CHAT_COMPACTION_MEMORY_EXTRACTABLE[previous];
          const allInputsAllow =
            predecessorAllows &&
            extractionFeatureEnabled &&
            segmentMessages.every((m) => m.memoryExtractionEligible);

          expect(CHAT_COMPACTION_MEMORY_EXTRACTABLE[verdict]).toBe(
            allInputsAllow,
          );
        }
      }
    }
  });

  test("only 'eligible' is extractable", () => {
    // Pins the companion map against the union: a new value added without a
    // consent decision would default to nothing and fail here.
    const extractable = CHAT_COMPACTION_MEMORY_ELIGIBILITIES.filter(
      (eligibility) => CHAT_COMPACTION_MEMORY_EXTRACTABLE[eligibility],
    );
    expect(extractable).toEqual([CHAT_COMPACTION_MEMORY_ELIGIBILITY.ELIGIBLE]);
  });
});
