import { READER_ANSWER_DEADLINE_MS } from "@stll/api-contract/reader-answers";
import type { ReaderAnswer } from "@stll/api-contract/reader-answers";
import { Temporal } from "@stll/time";

const INITIAL_POLL_DELAY_MS = 1000;
const MAX_POLL_DELAY_MS = 10_000;
const POLL_BACKOFF_PERIOD_MS = 5000;

type ReaderAnswerPollingOptions = {
  answers: readonly ReaderAnswer[];
  ownedMessageIds: ReadonlySet<string>;
  now: number;
};
const unownedClaims = ({
  answers,
  ownedMessageIds,
}: ReaderAnswerPollingOptions) =>
  answers
    .flatMap((answer) =>
      answer.messages.filter(
        (message) =>
          message.status === "streaming" && !ownedMessageIds.has(message.id),
      ),
    )
    .map((message) => ({
      startedAt: Temporal.Instant.from(message.updatedAt).epochMilliseconds,
    }));

export const readerAnswerPollDelay = (
  options: ReaderAnswerPollingOptions,
): number | false => {
  const claims = unownedClaims(options);
  if (claims.length === 0) {
    return false;
  }
  const liveClaims = claims.filter(
    ({ startedAt }) => startedAt + READER_ANSWER_DEADLINE_MS > options.now,
  );
  if (liveClaims.length === 0) {
    return 1;
  }
  let soonest = MAX_POLL_DELAY_MS;
  for (const { startedAt } of liveClaims) {
    const remaining = startedAt + READER_ANSWER_DEADLINE_MS - options.now;
    const age = Math.max(0, options.now - startedAt);
    const delay = Math.min(
      MAX_POLL_DELAY_MS,
      INITIAL_POLL_DELAY_MS * 2 ** Math.floor(age / POLL_BACKOFF_PERIOD_MS),
    );
    soonest = Math.min(soonest, Math.max(1, Math.min(delay, remaining)));
  }
  return soonest;
};

export const readerAnswerClaimRemainder = (
  options: ReaderAnswerPollingOptions,
): number | null => {
  const claims = unownedClaims(options);
  if (claims.length === 0) {
    return null;
  }
  const liveClaims = claims.filter(
    ({ startedAt }) => startedAt + READER_ANSWER_DEADLINE_MS > options.now,
  );
  if (liveClaims.length === 0) {
    return 0;
  }
  let soonest = READER_ANSWER_DEADLINE_MS;
  for (const { startedAt } of liveClaims) {
    soonest = Math.min(
      soonest,
      startedAt + READER_ANSWER_DEADLINE_MS - options.now,
    );
  }
  return soonest;
};

export const allUnownedReaderClaimsExpired = (
  options: ReaderAnswerPollingOptions,
) => {
  const claims = unownedClaims(options);
  return (
    claims.length > 0 &&
    claims.every(
      ({ startedAt }) => startedAt + READER_ANSWER_DEADLINE_MS <= options.now,
    )
  );
};

export const projectExpiredReaderAnswers = (
  options: ReaderAnswerPollingOptions,
): ReaderAnswer[] =>
  options.answers.map((answer) => {
    const projection = { changed: false };
    const messages = answer.messages.map((message) => {
      if (
        message.status !== "streaming" ||
        options.ownedMessageIds.has(message.id) ||
        Temporal.Instant.from(message.updatedAt).epochMilliseconds +
          READER_ANSWER_DEADLINE_MS >
          options.now
      ) {
        return message;
      }
      projection.changed = true;
      return {
        ...message,
        status: "failed",
        errorCode: "timeout",
      } satisfies ReaderAnswer["messages"][number];
    });
    return projection.changed ? { ...answer, messages } : answer;
  });
