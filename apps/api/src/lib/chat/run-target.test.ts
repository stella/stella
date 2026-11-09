import { describe, expect, test } from "bun:test";

import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatLocalRunTarget,
} from "@stll/api-contract/chat-run-target";

import { reportedLocalRunContext } from "@/api/lib/chat/run-target";

const LOCAL: ChatLocalRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
};

const answer = (localRunContext?: unknown) => ({
  role: "assistant",
  ...(localRunContext === undefined ? {} : { metadata: { localRunContext } }),
});

describe("the context a thread on the member's computer reports", () => {
  test("is the latest answer's report, for a thread that runs there", () => {
    const messages = [
      { role: "user" },
      answer({ usedTokens: 10_000, windowTokens: 200_000 }),
      { role: "user" },
      answer({ usedTokens: 48_200, windowTokens: 200_000 }),
      { role: "user" },
    ];
    expect(reportedLocalRunContext({ target: LOCAL, messages })).toEqual({
      usedTokens: 48_200,
      windowTokens: 200_000,
    });
    // A thread back on stella's own models shows stella's estimate.
    expect(
      reportedLocalRunContext({ target: CHAT_CLOUD_RUN_TARGET, messages }),
    ).toBeUndefined();
  });

  test("is nothing when the latest answer reported none, even if an earlier one did", () => {
    expect(
      reportedLocalRunContext({
        target: LOCAL,
        messages: [
          answer({ usedTokens: 10_000, windowTokens: 200_000 }),
          answer(),
        ],
      }),
    ).toBeUndefined();
    expect(
      reportedLocalRunContext({
        target: LOCAL,
        messages: [answer({ usedTokens: 10_000, windowTokens: 0 })],
      }),
    ).toBeUndefined();
  });
});
