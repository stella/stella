import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { AppServerClient } from "./app-server-client";
import { readRateLimits } from "./rate-limits";

/** A client whose `account/rateLimits/read` answers with `answer`. */
const answering = (
  answer: () => ReturnType<AppServerClient["request"]>,
): AppServerClient => ({
  request: answer,
  notify: () => undefined,
  respond: () => undefined,
  respondError: () => undefined,
  pid: 0,
  exited: Promise.withResolvers<never>().promise,
  closeInput: () => undefined,
  kill: async () => ({ exitCode: 0, signal: null }),
});

const windows = (limitId: string, usedPercent: number) => ({
  limitId,
  primary: { usedPercent, resetsAt: 1_893_456_000 },
  secondary: null,
});

describe("reading Codex's plan limits", () => {
  test("the main allowance is read by its limit id, never another's", async () => {
    const read = await readRateLimits(
      answering(async () =>
        Result.ok({
          rateLimits: windows("codex-other", 100),
          rateLimitsByLimitId: {
            "codex-other": windows("codex-other", 100),
            codex: windows("codex", 20),
          },
        }),
      ),
    );
    expect(read).toEqual({ type: "read", limits: windows("codex", 20) });
  });

  test("a server without limits by id is read from its single view", async () => {
    const read = await readRateLimits(
      answering(async () => Result.ok({ rateLimits: windows("codex", 100) })),
    );
    expect(read).toEqual({ type: "read", limits: windows("codex", 100) });
  });

  test("only another allowance is none, not a failure", async () => {
    const read = await readRateLimits(
      answering(async () =>
        Result.ok({ rateLimits: windows("codex-other", 100) }),
      ),
    );
    expect(read).toEqual({ type: "none" });
  });

  test("an unexpected answer is a failed read, not an empty one", async () => {
    const read = await readRateLimits(
      answering(async () => Result.ok({ limits: [] })),
    );
    expect(read).toEqual({ type: "failed", reason: "malformed" });
  });

  test("a server that does not answer in time is a failed read", async () => {
    const read = await readRateLimits(
      answering(async () => Promise.withResolvers<never>().promise),
      10,
    );
    expect(read).toEqual({ type: "failed", reason: "timed_out" });
  });
});
