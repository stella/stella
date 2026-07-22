import { describe, expect, test } from "bun:test";

import { resolveAuthSessionState } from "./auth-session-state";

describe("resolveAuthSessionState", () => {
  test("keeps a cached authenticated session usable during a refresh", () => {
    expect(
      resolveAuthSessionState({
        error: new Error("offline"),
        isPending: true,
        session: { session: { activeOrganizationId: "org_1" } },
      }),
    ).toEqual({ activeOrganizationId: "org_1", type: "ready" });
  });

  test("requires organization selection before rendering app routes", () => {
    expect(
      resolveAuthSessionState({
        error: null,
        isPending: false,
        session: { session: { activeOrganizationId: null } },
      }),
    ).toEqual({ type: "organizationRequired" });
  });

  test("does not mistake a pending request for a signed-out session", () => {
    expect(
      resolveAuthSessionState({ error: null, isPending: true, session: null }),
    ).toEqual({ type: "loading" });
  });

  test("fails closed when session resolution errors", () => {
    expect(
      resolveAuthSessionState({
        error: new Error("network"),
        isPending: false,
        session: null,
      }),
    ).toEqual({ type: "unavailable" });
  });

  test("renders sign-in only after a successful empty session response", () => {
    expect(
      resolveAuthSessionState({ error: null, isPending: false, session: null }),
    ).toEqual({ type: "signedOut" });
  });
});
