/* oxlint-disable require-contract-domains/require-contract-domains -- Nonempty generator sizes bound test workload, not an API limit; the claim window comes from the shared contract. */
import { expect, test } from "bun:test";
import fc from "fast-check";

import { READER_ANSWER_DEADLINE_MS } from "@stll/api-contract/reader-answers";
import type { ReaderAnswer } from "@stll/api-contract/reader-answers";
import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import { toSafeId } from "@/lib/safe-id";

import {
  allUnownedReaderClaimsExpired,
  projectExpiredReaderAnswers,
  readerAnswerClaimRemainder,
  readerAnswerPollDelay,
} from "./reader-answers-polling";

const now = 1_800_000_000_000;
const fixture = (remaining: number, id = "assistant"): ReaderAnswer => ({
  id: toSafeId<"legalReaderAnswer">(`answer-${id}`),
  decisionId: toSafeId<"caseLawDecision">("decision"),
  authorId: toSafeId<"user">("user"),
  mine: true,
  kind: "explain",
  visibility: "private",
  anchor: {
    spans: [
      {
        paragraphId: "paragraph",
        quote: "Text",
        startOffset: 0,
        endOffset: 4,
      },
    ],
  },
  createdAt: Temporal.Instant.fromEpochMilliseconds(now).toString(),
  updatedAt: Temporal.Instant.fromEpochMilliseconds(now).toString(),
  messages: [
    {
      id: toSafeId<"legalReaderAnswerMessage">(id),
      role: "assistant",
      status: "streaming",
      content: "",
      citations: [],
      model: null,
      usage: null,
      errorCode: null,
      invalidCitationCount: 0,
      createdAt: Temporal.Instant.fromEpochMilliseconds(now).toString(),
      updatedAt: Temporal.Instant.fromEpochMilliseconds(
        now - READER_ANSWER_DEADLINE_MS + remaining,
      ).toString(),
    },
  ],
});

test("reader answer polling respects every remaining claim deadline and projection is a fixed point", () => {
  assertProperty(
    "reader answer polling respects every remaining claim deadline and projection is a fixed point",
    fc.property(
      fc.array(fc.integer({ min: 1, max: READER_ANSWER_DEADLINE_MS }), {
        minLength: 1,
        maxLength: 20,
      }),
      (remaining) => {
        const answers = remaining.map((value, index) =>
          fixture(value, `assistant-${index}`),
        );
        const options = { answers, ownedMessageIds: new Set<string>(), now };
        const delay = readerAnswerPollDelay(options);
        expect(delay).not.toBe(false);
        expect(Number(delay)).toBeGreaterThan(0);
        expect(Number(delay)).toBeLessThanOrEqual(Math.min(...remaining));
        expect(Number(delay)).toBeLessThanOrEqual(10_000);
        const expired = { ...options, now: now + READER_ANSWER_DEADLINE_MS };
        const projected = projectExpiredReaderAnswers(expired);
        expect(
          projectExpiredReaderAnswers({ ...expired, answers: projected }),
        ).toEqual(projected);
        expect(readerAnswerPollDelay({ ...expired, answers: projected })).toBe(
          false,
        );
      },
    ),
  );
});

test("mixed expired, live and locally owned claims cannot create a tight retry loop", () => {
  const expired = fixture(-1, "expired");
  const live = fixture(500, "live");
  const owned = fixture(-10, "owned");
  const options = {
    answers: [expired, live, owned],
    ownedMessageIds: new Set(["owned"]),
    now,
  };
  expect(readerAnswerPollDelay(options)).toBe(500);
  expect(readerAnswerClaimRemainder(options)).toBe(500);
  expect(allUnownedReaderClaimsExpired(options)).toBe(false);
  const projected = projectExpiredReaderAnswers(options);
  expect(projected.at(0)?.messages.at(0)).toMatchObject({
    status: "failed",
    errorCode: "timeout",
  });
  expect(projected.at(1)?.messages.at(0)?.status).toBe("streaming");
  expect(projected.at(2)).toBe(owned);
  expect(readerAnswerPollDelay({ ...options, answers: [owned] })).toBe(false);
  expect(
    readerAnswerClaimRemainder({ ...options, answers: [owned] }),
  ).toBeNull();
});
