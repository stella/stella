import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DataTag } from "@tanstack/react-query";
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

// A DOM for this file only: the guard's modules read browser globals.
GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

// The browser build keeps only the client half of an isomorphic function;
// without the build step both halves exist and the server one would run.
const start = await import("@tanstack/react-start");
type ClientHalf = (...args: never[]) => unknown;
await mock.module("@tanstack/react-start", () => ({
  ...start,
  createIsomorphicFn: () => {
    let clientHalf: ClientHalf = () => undefined;
    const isomorphic = Object.assign(
      (...args: never[]) => clientHalf(...args),
      {
        server: () => isomorphic,
        client: (half: ClientHalf) => {
          clientHalf = half;
          return isomorphic;
        },
      },
    );
    return isomorphic;
  },
}));

const { QueryClient } = await import("@tanstack/react-query");
const { isRedirect } = await import("@tanstack/react-router");
const { Result } = await import("better-result");
const { sessionOptions } = await import("@/lib/auth-queries");
const { loadProtectedContext } = await import("@/routes/-protected-guard");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");

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
        options: {
          to: "/auth/professional-use",
          search: { redirectTo: "/workspaces?view=list" },
        },
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

  test("starts the workspace navigation request with the shell's first wave, before chrome mounts", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ) => {
          const request = input instanceof Request ? input : undefined;
          const url = new URL(request ? request.url : String(input));
          if (url.pathname === "/v1/me/professional-use") {
            return Response.json({ status: "accepted" });
          }
          // Shell prefetches stay in flight until the test cancels them.
          const signal = init?.signal ?? request?.signal;
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(signal.reason);
            });
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    try {
      const guarded = await loadProtectedContext({
        context: { queryClient },
        location: { pathname: "/workspaces/ws_1", searchStr: "" },
      });

      expect(guarded.user.id).toBe("user_1");
      // The sidebar's chrome query and the time-billing gate read this key;
      // a fetch already in flight here means neither opens a later round.
      const navigation = queryClient.getQueryState(
        workspacesNavigationOptions({
          userId: "user_1",
          organizationId: "org_1",
        }).queryKey,
      );
      expect(navigation?.fetchStatus).toBe("fetching");
    } finally {
      await queryClient.cancelQueries();
      fetch.mockRestore();
      queryClient.clear();
    }
  });
});
