import { expect, spyOn, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { rootDb } from "@/api/db/root";
import { createAuth } from "@/api/lib/auth";
import * as email from "@/api/lib/email/email";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

test("a handoff session on a new device sends the account notice", async () => {
  const restoreRuntime = setRuntimeModeForTesting({
    mode: RUNTIME_MODE.strict,
  });
  const notice = spyOn(email, "sendNewDeviceLoginEmail").mockResolvedValue(
    undefined,
  );
  const previousSessions = spyOn(
    rootDb.query.session,
    "findMany",
  ).mockResolvedValue(
    asTestRaw([
      {
        ipAddress: "192.0.2.1",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      },
    ]),
  );
  const background: Promise<unknown>[] = [];
  try {
    const after = createAuth().options.hooks.after;
    await after(
      asTestRaw({
        path: "/mcp-handoff/redeem",
        request: new Request(
          "https://example.test/api/auth/mcp-handoff/redeem",
        ),
        context: {
          newSession: {
            user: { id: "user-notice", email: "account@example.test" },
            session: {
              id: "session-notice",
              originConsentId: "consent-notice",
              ipAddress: "192.0.2.2",
              userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
              createdAt: new Date("2026-01-15T12:00:00Z"),
            },
          },
          runInBackground: (promise: Promise<unknown>) =>
            background.push(promise),
        },
      }),
    );
    await Promise.all(background);
    expect(previousSessions).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "account@example.test",
        ipAddress: "192.0.2.2",
        device: expect.stringContaining("Windows"),
        sessionsUrl: expect.stringContaining("/account"),
      }),
    );
  } finally {
    previousSessions.mockRestore();
    notice.mockRestore();
    restoreRuntime();
  }
});
