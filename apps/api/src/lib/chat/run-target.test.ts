import { describe, expect, test } from "bun:test";

import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatLocalRunTarget,
} from "@stll/api-contract/chat-run-target";

import { localRunContextUsage } from "@/api/lib/chat/run-target";

const LOCAL: ChatLocalRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
  reasoningEffort: null,
};

const answer = (localRunContext?: unknown) => ({
  role: "assistant",
  ...(localRunContext === undefined ? {} : { metadata: { localRunContext } }),
});

describe("the context meter of a thread on the member's computer", () => {
  test("is the latest answer's report, for a thread that runs there", () => {
    const messages = [
      { role: "user" },
      answer({ usedTokens: 10_000, windowTokens: 200_000 }),
      { role: "user" },
      answer({ usedTokens: 48_200, windowTokens: 200_000 }),
      { role: "user" },
    ];
    expect(localRunContextUsage({ target: LOCAL, messages })).toEqual({
      source: "harness",
      reported: { usedTokens: 48_200, windowTokens: 200_000 },
    });
    // A thread back on stella's own models shows stella's estimate.
    expect(
      localRunContextUsage({ target: CHAT_CLOUD_RUN_TARGET, messages }),
    ).toBeUndefined();
  });

  test("reports nothing, never the estimate, before its harness reported", () => {
    // The first turn still running: no answer has a report yet.
    expect(
      localRunContextUsage({
        target: LOCAL,
        messages: [{ role: "user" }, answer()],
      }),
    ).toEqual({ source: "harness", reported: null });
    expect(
      localRunContextUsage({ target: LOCAL, messages: [{ role: "user" }] }),
    ).toEqual({ source: "harness", reported: null });
  });

  test("reports nothing when the latest answer reported none, even if an earlier one did", () => {
    expect(
      localRunContextUsage({
        target: LOCAL,
        messages: [
          answer({ usedTokens: 10_000, windowTokens: 200_000 }),
          answer(),
        ],
      }),
    ).toEqual({ source: "harness", reported: null });
    expect(
      localRunContextUsage({
        target: LOCAL,
        messages: [answer({ usedTokens: 10_000, windowTokens: 0 })],
      }),
    ).toEqual({ source: "harness", reported: null });
  });
});
