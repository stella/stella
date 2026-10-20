import { expect, test } from "bun:test";

import {
  ADVISED_RETRY_MAX_ATTEMPTS,
  ADVISED_RETRY_MAX_DELAY_MS,
  advisedRetry as sharedAdvisedRetry,
} from "@stll/concurrency/retry-advised";

import { uploadRetryDecision } from "./upload-retry.js";

test("published retry policy matches the shared policy through give-up", () => {
  const advisedDelays = [
    undefined,
    0,
    1,
    ADVISED_RETRY_MAX_DELAY_MS - 1,
    ADVISED_RETRY_MAX_DELAY_MS,
    ADVISED_RETRY_MAX_DELAY_MS + 1,
  ];

  for (let attempt = 1; attempt <= ADVISED_RETRY_MAX_ATTEMPTS; attempt += 1) {
    for (const advisedDelayMs of advisedDelays) {
      expect(uploadRetryDecision({ attempt, advisedDelayMs })).toEqual(
        sharedAdvisedRetry({ attempt, advisedDelayMs }),
      );
    }
  }
});
