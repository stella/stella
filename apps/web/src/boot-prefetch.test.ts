import { describe, expect, test } from "bun:test";

import {
  discardBootPrefetch,
  resolveRequestMethod,
  startBootPrefetch,
  takeBootPrefetch,
} from "@/boot-prefetch";

/**
 * The prefetch's staleness guards are what make it safe to serve a cached
 * auth response: a bug in any of them silently hands post-sign-in code a
 * pre-sign-in session (or vice versa), which no type check or lint catches.
 * Each guard gets one test; the happy path rides along. The member-role
 * chain gate matters the same way: fired without a session it produces a
 * browser-visible 401 on every anonymous page load.
 */

const SIGNED_IN_SESSION = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1" },
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const sessionFetch = (sessionBody: unknown) => {
  const requested: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    requested.push(input);
    return await Promise.resolve(
      input.endsWith("/get-session")
        ? jsonResponse(sessionBody)
        : jsonResponse({ role: "member" }),
    );
  };
  return { fetchImpl, requested };
};

const failingFetch = () => async (): Promise<Response> =>
  await Promise.reject(new Error("network down"));

describe("boot prefetch", () => {
  test("serves each prefetched response exactly once", async () => {
    startBootPrefetch({ fetchImpl: sessionFetch(SIGNED_IN_SESSION).fetchImpl });

    const first = await takeBootPrefetch("/api/auth/get-session");
    expect(first).toBeInstanceOf(Response);

    // Consume-once: the second read must fall through to a real fetch.
    expect(await takeBootPrefetch("/api/auth/get-session")).toBeNull();

    // The sibling slot is independent of the session slot's consumption.
    expect(
      await takeBootPrefetch("/api/auth/organization/get-active-member-role"),
    ).toBeInstanceOf(Response);
  });

  test("matches on path suffix, ignores everything else", async () => {
    startBootPrefetch({ fetchImpl: sessionFetch(SIGNED_IN_SESSION).fetchImpl });

    expect(await takeBootPrefetch("/v1/workspaces")).toBeNull();
    // Suffix match covers both the bare auth mount and the /api/auth mount.
    expect(await takeBootPrefetch("/get-session")).toBeInstanceOf(Response);
    discardBootPrefetch();
  });

  // Each variant runs through the shared module-level slots, so the checks
  // are sequential by construction (helper awaited per variant, no loop).
  const expectNoMemberRoleRequest = async (sessionBody: unknown) => {
    const { fetchImpl, requested } = sessionFetch(sessionBody);
    startBootPrefetch({ fetchImpl });

    // The gate resolves the slot to null (consumer falls back to its own
    // fetch, which the app only issues once signed in)...
    expect(
      await takeBootPrefetch("/api/auth/organization/get-active-member-role"),
    ).toBeNull();
    // ...and the request never left the browser: anonymous boots must not
    // produce a console-visible 401/400.
    expect(requested).toEqual([expect.stringContaining("/get-session")]);
    discardBootPrefetch();
  };

  test("no member-role request without a session with an active org", async () => {
    await expectNoMemberRoleRequest(null);
    await expectNoMemberRoleRequest({ session: null });
    await expectNoMemberRoleRequest({
      session: { activeOrganizationId: null },
    });
  });

  test("member-role prefetch fires for a session with an active org", async () => {
    const { fetchImpl, requested } = sessionFetch(SIGNED_IN_SESSION);
    startBootPrefetch({ fetchImpl });

    expect(
      await takeBootPrefetch("/api/auth/organization/get-active-member-role"),
    ).toBeInstanceOf(Response);
    expect(requested).toHaveLength(2);

    // The chain reads a clone; the session slot's own body must survive it.
    const session = await takeBootPrefetch("/api/auth/get-session");
    expect(await session?.json()).toEqual(SIGNED_IN_SESSION);
    discardBootPrefetch();
  });

  test("an expired slot is ignored", async () => {
    startBootPrefetch({
      fetchImpl: sessionFetch(SIGNED_IN_SESSION).fetchImpl,
      // Slot older than the 30s TTL.
      now: () => Date.now() - 31_000,
    });

    expect(await takeBootPrefetch("/api/auth/get-session")).toBeNull();
    discardBootPrefetch();
  });

  test("discardBootPrefetch drops every pending slot", async () => {
    startBootPrefetch({ fetchImpl: sessionFetch(SIGNED_IN_SESSION).fetchImpl });

    discardBootPrefetch();

    expect(await takeBootPrefetch("/api/auth/get-session")).toBeNull();
    expect(
      await takeBootPrefetch("/api/auth/organization/get-active-member-role"),
    ).toBeNull();
  });

  test("a failed prefetch resolves to null instead of rejecting", async () => {
    startBootPrefetch({ fetchImpl: failingFetch() });

    expect(await takeBootPrefetch("/api/auth/get-session")).toBeNull();
    expect(
      await takeBootPrefetch("/api/auth/organization/get-active-member-role"),
    ).toBeNull();
    discardBootPrefetch();
  });

  test("every prefetch request carries an abort-timeout signal", async () => {
    // `takeBootPrefetch` awaits the slot promise directly, bypassing the
    // auth client's fetchWithTimeout fallback; an unbounded prefetch would
    // hang the first protected-route auth read on a stalled connection.
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = async (
      input: string,
      init?: RequestInit,
    ): Promise<Response> => {
      signals.push(init?.signal);
      return await Promise.resolve(
        input.endsWith("/get-session")
          ? jsonResponse(SIGNED_IN_SESSION)
          : jsonResponse({ role: "member" }),
      );
    };
    startBootPrefetch({ fetchImpl });

    await takeBootPrefetch("/api/auth/organization/get-active-member-role");
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    discardBootPrefetch();
  });

  test("resolveRequestMethod reads the method off a Request input", () => {
    // A POST arriving as a bare `Request` must still be classified as a
    // mutation, or it slips past the discard fence and a later GET can
    // consume stale pre-mutation data.
    const post = new Request("http://localhost/api/auth/sign-out", {
      method: "POST",
    });
    expect(resolveRequestMethod(post, undefined)).toBe("POST");
    // init wins over the Request when both are present.
    expect(resolveRequestMethod(post, { method: "PATCH" })).toBe("PATCH");
    expect(resolveRequestMethod("/api/auth/get-session", undefined)).toBe(
      "GET",
    );
    expect(resolveRequestMethod("/x", { method: "delete" })).toBe("DELETE");
  });
});
