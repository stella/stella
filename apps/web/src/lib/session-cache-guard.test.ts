import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { sleep } from "@stll/concurrency/sleep";

// The network these reads go to: the signed-in member (or nobody) answers.
let signedIn: string | null = "member-a";
const threadListRequests: (string | null)[] = [];

const ROLE_OF: Record<string, string> = {
  "member-a": "owner",
  "member-b": "member",
};

const sessionBody = () => {
  const member = signedIn;
  return member === null
    ? null
    : {
        session: { userId: member, activeOrganizationId: "org-x" },
        user: { id: member, email: "member@example.test", name: "" },
      };
};

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    await Promise.resolve();
    if (url.pathname.endsWith("/api/auth/get-session")) {
      return Response.json(sessionBody());
    }
    if (url.pathname.endsWith("/organization/get-active-member-role")) {
      return Response.json({ role: ROLE_OF[signedIn ?? ""] ?? null });
    }
    if (url.pathname === "/v1/chat/threads") {
      threadListRequests.push(signedIn);
      return Response.json({
        global: [{ id: "thread", title: "Notes" }],
        workspaces: [],
        nextCursor: null,
      });
    }
    return Response.json(null, { status: 404 });
  },
  { preconnect: () => undefined },
);

const { refreshAuthQueries, roleOptions, sessionOptions } =
  await import("@/lib/auth-queries");
const { groupedChatThreadsOptions } = await import("@/features/chat/queries");
const { isAuthFlowPathname } = await import("@/lib/redirect");
const { installSessionCacheGuard, requireFreshDocument } =
  await import("@/lib/session-cache-guard");

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const threadsOptions = groupedChatThreadsOptions({
  activeOrganizationId: "org-x",
  userId: "member-a",
});

/** A client as the app builds it, with a page on screen and a record of the
 *  document loads it asks for. */
const createClient = (page: string) => {
  const queryClient = new QueryClient();
  const reloads: string[] = [];
  const location = { pathname: page };
  installSessionCacheGuard(queryClient, {
    isAuthFlowPage: () => isAuthFlowPathname(location.pathname),
    reloadDocument: () => {
      reloads.push(location.pathname);
    },
    reloadDocumentAt: (href) => {
      reloads.push(href);
    },
  });
  return { queryClient, reloads, location };
};

/** What a sidebar shows first for the list (the cached pages, if any), then
 *  the read it makes when there are none. */
const readThreads = async (queryClient: QueryClient) => {
  const shownFirst = JSON.stringify(
    queryClient.getQueryData(threadsOptions.queryKey)?.pages ?? null,
  );
  await queryClient.infiniteQuery(threadsOptions);
  return shownFirst;
};

const cachedKeys = (queryClient: QueryClient) =>
  queryClient
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify(query.queryKey))
    .toSorted();

const SESSION_ONLY = [JSON.stringify(["session"])];

/** Signs `member` in the way every sign-in step does, from the sign-in page. */
const signInAs = async (
  client: ReturnType<typeof createClient>,
  member: string,
) => {
  signedIn = null;
  client.location.pathname = "/auth";
  await refreshAuthQueries(client.queryClient);
  signedIn = member;
  client.location.pathname = "/auth/otp";
  await refreshAuthQueries(client.queryClient);
};

/** What the next navigation's root guard does: `"stay"`, the redirect it
 *  throws, or `"pending"` while the page reloads. */
const nextNavigation = async (
  queryClient: QueryClient,
  location: { pathname: string; hash?: string },
) => {
  const hash = location.hash ?? "";
  const guard = requireFreshDocument({
    queryClient,
    location: {
      pathname: location.pathname,
      hash,
      publicHref: `${location.pathname}${hash === "" ? "" : `#${hash}`}`,
    },
  });
  return await Promise.race([
    guard.then(
      () => "stay" as const,
      (error: unknown) => (isRedirect(error) ? ("redirect" as const) : error),
    ),
    sleep(20).then(() => "pending" as const),
  ]);
};

/** The client with member-a's reads cached. */
const clientWithMemberA = async (page: string) => {
  signedIn = "member-a";
  const client = createClient(page);
  await client.queryClient.query(sessionOptions);
  await client.queryClient.query(roleOptions);
  await readThreads(client.queryClient);
  return client;
};

describe("sign-in and the client cache", () => {
  test("a different member signing in starts with an empty client cache", async () => {
    threadListRequests.length = 0;
    const client = await clientWithMemberA("/chat");

    // The session changes to member-b.
    await signInAs(client, "member-b");

    expect(cachedKeys(client.queryClient)).toEqual(SESSION_ONLY);
    expect(client.reloads).toEqual([]);
    expect((await client.queryClient.query(sessionOptions))?.user.id).toBe(
      "member-b",
    );
    // The role is read again for the member now signed in.
    expect(await client.queryClient.query(roleOptions)).toBe("member");

    // The first page after the sign-in steps loads as a new document; the
    // steps in between do not.
    expect(
      await nextNavigation(client.queryClient, {
        pathname: "/auth/organization",
      }),
    ).toBe("stay");
    expect(
      await nextNavigation(client.queryClient, { pathname: "/chat" }),
    ).toBe("redirect");

    // The next list read starts from nothing cached and asks the server.
    expect(await readThreads(client.queryClient)).toBe("null");
    expect(threadListRequests).toEqual(["member-a", "member-b"]);
  });

  test("a different member's session read outside the sign-in pages reloads with only the session cached", async () => {
    const client = await clientWithMemberA("/chat");

    signedIn = "member-b";
    await client.queryClient.refetchQueries({
      queryKey: sessionOptions.queryKey,
    });

    expect(client.reloads).toEqual(["/chat"]);
    expect(cachedKeys(client.queryClient)).toEqual(SESSION_ONLY);
    expect(
      await nextNavigation(client.queryClient, { pathname: "/chat" }),
    ).toBe("redirect");
  });

  test("a page named with a fragment reloads at that address", async () => {
    const client = await clientWithMemberA("/chat");
    await signInAs(client, "member-b");

    expect(
      await nextNavigation(client.queryClient, {
        pathname: "/workspaces/ws-1",
        hash: "notes",
      }),
    ).toBe("pending");
    expect(client.reloads).toEqual(["/workspaces/ws-1#notes"]);
  });

  test("signing back in as the first member starts over again", async () => {
    const client = await clientWithMemberA("/chat");
    await signInAs(client, "member-b");
    await readThreads(client.queryClient);
    expect(cachedKeys(client.queryClient)).not.toEqual(SESSION_ONLY);

    await signInAs(client, "member-a");

    expect(cachedKeys(client.queryClient)).toEqual(SESSION_ONLY);
    expect(await client.queryClient.query(roleOptions)).toBe("owner");
  });

  test("the same member signing in again keeps working with their cache", async () => {
    const client = await clientWithMemberA("/chat");

    await signInAs(client, "member-a");

    expect(client.reloads).toEqual([]);
    expect(
      client.queryClient
        .getQueryCache()
        .find({ queryKey: threadsOptions.queryKey })?.state.data,
    ).toBeDefined();
    expect(await client.queryClient.query(roleOptions)).toBe("owner");
    expect(
      await nextNavigation(client.queryClient, { pathname: "/chat" }),
    ).toBe("stay");
  });

  test("the first sign-in in a page changes nothing", async () => {
    signedIn = null;
    const client = createClient("/auth");
    await client.queryClient.query(sessionOptions);
    signedIn = "member-a";
    client.location.pathname = "/auth/otp";
    await refreshAuthQueries(client.queryClient);

    expect(client.reloads).toEqual([]);
    expect((await client.queryClient.query(sessionOptions))?.user.id).toBe(
      "member-a",
    );
    expect(
      await nextNavigation(client.queryClient, { pathname: "/chat" }),
    ).toBe("stay");
  });
});

describe("the app wires the guard in", () => {
  const webSource = (path: string) =>
    readFileSync(nodePath.resolve(import.meta.dir, "..", path), "utf-8");

  test("the router installs it on the client it creates", () => {
    const router = webSource("router.tsx");
    expect(router).toContain("installSessionCacheGuard(queryClient, {");
    expect(router).toContain("reloadDocumentAt: (href) => {");
    expect(router).toContain("window.history.replaceState(");
  });

  test("the root route checks every navigation", () => {
    const root = webSource("routes/__root.tsx");
    expect(root).toContain(
      "await requireFreshDocument({ queryClient: context.queryClient, location });",
    );
  });
});
