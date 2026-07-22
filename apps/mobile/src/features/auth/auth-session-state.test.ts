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
    ).toBe("ready");
  });

  test("requires organization selection before rendering app routes", () => {
    expect(
      resolveAuthSessionState({
        error: null,
        isPending: false,
        session: { session: { activeOrganizationId: null } },
      }),
    ).toBe("organizationRequired");
  });

  test("does not mistake a pending request for a signed-out session", () => {
    expect(
      resolveAuthSessionState({ error: null, isPending: true, session: null }),
    ).toBe("loading");
  });

  test("fails closed when session resolution errors", () => {
    expect(
      resolveAuthSessionState({
        error: new Error("network"),
        isPending: false,
        session: null,
      }),
    ).toBe("unavailable");
  });

  test("renders sign-in only after a successful empty session response", () => {
    expect(
      resolveAuthSessionState({ error: null, isPending: false, session: null }),
    ).toBe("signedOut");
  });
});
