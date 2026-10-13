import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/settings" });

const { listAuthSessions } = await import("@/lib/auth-client");

const originalFetch = globalThis.fetch;
let originConsentId: string | null = "handoff-consent";
let handoffRequests = 0;
let handoffResponse: Response | "network-error" = Response.json({
  sessions: [{ id: "session-one", clientName: "Connected app" }],
});

globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/list-sessions")) {
      return Response.json([
        {
          id: "session-one",
          originConsentId,
          userId: "user-one",
          token: "ordinary-session-token",
          expiresAt: "2026-10-14T00:00:00.000Z",
          createdAt: "2026-10-13T00:00:00.000Z",
          updatedAt: "2026-10-13T00:00:00.000Z",
          ipAddress: null,
          userAgent: "Browser",
        },
      ]);
    }
    if (url.pathname.endsWith("/mcp-handoff/sessions")) {
      handoffRequests += 1;
      if (handoffResponse === "network-error") {
        throw new TypeError("Network unavailable");
      }
      return handoffResponse;
    }
    return Response.json({ message: "Unexpected request" }, { status: 404 });
  },
  { preconnect: () => undefined },
);

beforeEach(() => {
  originConsentId = "handoff-consent";
  handoffRequests = 0;
  handoffResponse = Response.json({
    sessions: [{ id: "session-one", clientName: "Connected app" }],
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

describe("auth session listing", () => {
  test("ordinary sessions need no handoff lookup", async () => {
    originConsentId = null;
    const result = await listAuthSessions();
    expect(result.data?.at(0)?.id).toBe("session-one");
    expect(handoffRequests).toBe(0);
  });

  test.each([
    [
      "HTTP failure",
      Response.json({ message: "Unavailable" }, { status: 503 }),
    ],
    ["network failure", "network-error"],
    ["invalid response", Response.json({ sessions: [{ id: 42 }] })],
  ] as const)(
    "keeps ordinary sessions when handoff lookup has %s",
    async (_, response) => {
      handoffResponse = response;

      const result = await listAuthSessions();

      expect(handoffRequests).toBe(1);
      expect(result.error).toBeNull();
      expect(result.data).toHaveLength(1);
      expect(result.data?.[0]).toMatchObject({
        id: "session-one",
        userId: "user-one",
      });
      expect(result.data?.[0]?.originClientName).toBeUndefined();
    },
  );

  test("labels a session when the optional handoff lookup succeeds", async () => {
    const result = await listAuthSessions();

    expect(result.error).toBeNull();
    expect(result.data?.[0]?.originClientName).toBe("Connected app");
    expect(handoffRequests).toBe(1);
  });
});
