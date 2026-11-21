import { describe, expect, test } from "bun:test";

import { CHAT_QUEUE_ERROR_CODE } from "@stll/api-contract/chat-queue";
import type { DesktopRunnerHarnessReport } from "@stll/api-contract/desktop-runner";

import {
  limitResumeRefusalDisposition,
  limitResumeRouteDisposition,
} from "@/api/handlers/chat/limit-reminder/limit-resume";
import type { LocalRunRoute } from "@/api/handlers/chat/local-run-route";
import { status } from "@/api/http/status";

const NOW = new Date("2026-11-16T15:30:10.000Z");
const limitedUntil = (resetsAt: string): LocalRunRoute => ({
  type: "harness_unavailable",
  report: {
    id: "codex",
    state: "limit_until",
    version: "0.166.0",
    resetsAt,
  } satisfies DesktopRunnerHarnessReport,
});

describe("continuing a chat once its usage limit reset", () => {
  test("notifies instead when the computer is away, and does not wait for it", () => {
    for (const route of [
      { type: "no_computer" },
      { type: "folder_unavailable" },
    ] satisfies LocalRunRoute[]) {
      expect(limitResumeRouteDisposition(route, NOW)).toEqual({
        type: "end",
        end: "notify",
      });
    }
  });

  test("notifies instead when the computer reports the limit reached until later", () => {
    expect(
      limitResumeRouteDisposition(
        limitedUntil("2026-11-16T18:00:00.000Z"),
        NOW,
      ),
    ).toEqual({ type: "end", end: "notify" });
  });

  test("tries again while the computer still reports a limit whose reset passed", () => {
    // The fixture's reset is before now, so only its age makes it a retry.
    expect(new Date("2026-11-16T15:30:00.000Z").getTime()).toBeLessThan(
      NOW.getTime(),
    );
    expect(
      limitResumeRouteDisposition(
        limitedUntil("2026-11-16T15:30:00.000Z"),
        NOW,
      ),
    ).toEqual({ type: "retry-later" });
  });

  test("starts the turn on every other route, leaving its reason to the send", () => {
    const routes = [
      { type: "harness_unavailable", report: null },
      { type: "model_unavailable" },
      { type: "reasoning_effort_unavailable" },
      { type: "approvals_unavailable" },
      { type: "folder_not_approved" },
    ] satisfies LocalRunRoute[];
    for (const route of routes) {
      expect(limitResumeRouteDisposition(route, NOW)).toEqual({
        type: "start",
      });
    }
  });
});

describe("a refused resend after a usage limit", () => {
  test("does nothing when another task or a newer turn got there first", () => {
    expect(
      limitResumeRefusalDisposition(
        status(409, { code: CHAT_QUEUE_ERROR_CODE.notDue, message: "later" }),
      ),
    ).toEqual({ type: "not-due" });
  });

  test("tries again after a refusal that may pass on its own", () => {
    for (const code of [429, 503]) {
      expect(
        limitResumeRefusalDisposition(status(code, { message: "busy" })),
      ).toEqual({ type: "retry-later" });
    }
  });

  test("notifies the member on any other refusal, once", () => {
    for (const answer of [
      status(402, { message: "limit" }),
      status(403, { code: "local_run_unavailable", message: "no" }),
      status(400, { message: "invalid" }),
    ]) {
      expect(limitResumeRefusalDisposition(answer)).toEqual({
        type: "ended",
        end: "notify",
      });
    }
  });
});
