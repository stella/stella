import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DataTag } from "@tanstack/react-query";
import { linkOptions } from "@tanstack/react-router";
import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

// A DOM for this file only: the guard's modules read browser globals.
GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const { QueryClient } = await import("@tanstack/react-query");
const { isRedirect } = await import("@tanstack/react-router");
const { Result } = await import("better-result");
const { sessionOptions } = await import("@/lib/auth-queries");
const { loadProtectedContext } = await import("@/routes/-protected-guard");

afterAll(async () => {
  await unregisterDomEnvironment();
});

type SessionData =
  typeof sessionOptions.queryKey extends DataTag<unknown, infer TData, unknown>
    ? NonNullable<TData>
    : never;

const SIGNED_AT = new Date("2026-01-01T00:00:00Z");
const MEMBER_SESSION = {
  session: {
    activeOrganizationId: "org_1",
    createdAt: SIGNED_AT,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    id: "session_1",
    token: "token",
    updatedAt: SIGNED_AT,
    userId: "user_1",
  },
  user: {
    createdAt: SIGNED_AT,
    email: "member@example.test",
    emailVerified: true,
    id: "user_1",
    name: "Member",
    timezoneId: "UTC",
    twoFactorEnabled: false,
    updatedAt: SIGNED_AT,
  },
} satisfies SessionData;

describe("signed-in route guard", () => {
  test("sends an account that has not accepted the professional-use statement to accept it, before anything signed-in loads", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof globalThis.fetch>[0]) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          expect(url.pathname).toBe("/v1/me/professional-use");
          return Response.json({ status: "required" });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    try {
      const guarded = await Result.tryPromise({
        try: async () =>
          await loadProtectedContext({
            context: { queryClient },
            location: { pathname: "/workspaces", searchStr: "?view=list" },
          }),
        catch: (thrown) => thrown,
      });

      expect(Result.isError(guarded)).toBe(true);
      const thrown = Result.isError(guarded) ? guarded.error : undefined;
      expect(isRedirect(thrown)).toBe(true);
      expect(thrown).toMatchObject({
        options: linkOptions({
          to: "/auth/professional-use",
          search: { redirectTo: "/workspaces?view=list" },
        }),
      });
      // Nothing signed-in was requested for an account the API still refuses.
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey.at(0)),
      ).toEqual(["session", "professional-use"]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
      queryClient.clear();
    }
  });
});
