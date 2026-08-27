import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import sharepointOAuthCallback from "@/api/handlers/sharepoint/oauth-callback";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// The deployment flag is read at env import time; the gate itself is not
// under test here, so replace it wholesale (a full module mock, no partial).
void mock.module("@/api/handlers/sharepoint/enablement", () => ({
  assertSharepointConnectionEnabled: async () =>
    await Promise.resolve(Result.ok(undefined)),
}));

type CallbackCtx = Parameters<typeof sharepointOAuthCallback.handler>[0];

const orgA = toSafeId<"organization">("org_a");
const userA = toSafeId<"user">("user_a");

const reasonOf = (result: unknown): string | null => {
  if (!(result instanceof Response)) {
    throw new Error(`expected a 302 Response, got ${JSON.stringify(result)}`);
  }
  expect(result.status).toBe(302);
  const location = result.headers.get("Location");
  expect(location).not.toBeNull();
  return new URL(location ?? "").searchParams.get("reason");
};

// The state-row lookup goes through safeDb; queue results in call order.
const queuedSafeDb = (results: unknown[]): CallbackCtx["safeDb"] =>
  asTestRaw<CallbackCtx["safeDb"]>(async () => {
    const next = results.shift();
    if (next instanceof Error) {
      return Result.err(next);
    }
    return Result.ok(next);
  });

describe("sharepointOAuthCallback", () => {
  // A safeDb failure surfaces as Result.err, not a thrown exception. The
  // callback must still redirect (never a raw JSON error body) so the popup
  // can close itself instead of showing an API error page.
  test("redirects instead of leaking a raw error when a DB lookup fails", async () => {
    const ctx = asTestRaw<CallbackCtx>({
      query: { code: "auth-code", state: "state-token" },
      safeDb: queuedSafeDb([
        new HandlerError({ status: 500, message: "db down" }),
      ]),
      scopedDb: asTestRaw<CallbackCtx["scopedDb"]>(async () => undefined),
      session: { activeOrganizationId: orgA },
      user: { id: userA },
      memberRole: { role: "owner" },
      recordAuditEvent: async () => {},
    });

    const result = await sharepointOAuthCallback.handler(ctx);

    expect(reasonOf(result)).toBe("invalid-secret");
  });
});
