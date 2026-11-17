import { CancelledError, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { deferred } from "@stll/test-kit";

import { MEMBER_SESSION } from "@/lib/account/auth-session.test-fixtures";
import {
  activeMemberOptions,
  refreshAuthQueries,
  roleOptions,
  sessionOptions,
} from "@/lib/auth-queries";
import { rootKeys } from "@/lib/auth-query-options";
import {
  installSessionCacheGuard,
  resetAuthTransition,
  settleAuthTransition,
} from "@/lib/session-cache-guard";

const sessionFor = ({
  userId = "member-a",
  organizationId = "org-a",
}: { userId?: string; organizationId?: string | null } = {}) => ({
  ...MEMBER_SESSION,
  user: { ...MEMBER_SESSION.user, id: userId },
  session: {
    ...MEMBER_SESSION.session,
    userId,
    activeOrganizationId: organizationId,
  },
});

const originalFetch = globalThis.fetch;
const clients: { queryClient: QueryClient; uninstall: () => void }[] = [];
const requests: string[] = [];
let serverSession: ReturnType<typeof sessionFor> | null;
let role: "owner" | "member";
let heldRole: ReturnType<typeof deferred<Response>> | undefined;
let roleReached: ReturnType<typeof deferred<AbortSignal | null>> | undefined;
let heldSession: ReturnType<typeof deferred<Response>> | undefined;
let sessionReached: ReturnType<typeof deferred<undefined>> | undefined;
let sessionStatus: number;
let roleStatus: number;

beforeEach(() => {
  requests.length = 0;
  serverSession = sessionFor();
  role = "owner";
  heldRole = undefined;
  roleReached = undefined;
  heldSession = undefined;
  sessionReached = undefined;
  sessionStatus = 200;
  roleStatus = 200;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url.pathname);
      if (url.pathname.endsWith("/get-session")) {
        sessionReached?.resolve(undefined);
        return heldSession === undefined
          ? Response.json(serverSession, { status: sessionStatus })
          : await heldSession.promise;
      }
      if (url.pathname.endsWith("/get-active-member-role")) {
        roleReached?.resolve(init?.signal ?? null);
        return heldRole === undefined
          ? Response.json({ role }, { status: roleStatus })
          : await heldRole.promise;
      }
      if (url.pathname.endsWith("/get-active-member")) {
        return Response.json({
          id: "membership-a",
          userId: serverSession?.user.id,
          organizationId: serverSession?.session.activeOrganizationId,
          role,
          billingAccess: false,
          createdAt: MEMBER_SESSION.session.createdAt,
        });
      }
      throw new Error(`Unexpected auth request: ${url.pathname}`);
    },
    { preconnect: () => undefined },
  );
});

afterEach(() => {
  heldRole?.resolve(Response.json({ role: "owner" }));
  heldSession?.resolve(Response.json(serverSession));
  for (const { queryClient, uninstall } of clients) {
    uninstall();
    queryClient.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});

const createClient = () => {
  const queryClient = new QueryClient();
  const uninstall = installSessionCacheGuard(queryClient, {
    isAuthFlowPage: () => false,
    reloadDocument: () => undefined,
    reloadDocumentAt: () => undefined,
  });
  clients.push({ queryClient, uninstall });
  return queryClient;
};

const roleRequests = () =>
  requests.filter((path) => path.endsWith("/get-active-member-role"));

const holdNextRole = () => {
  const response = deferred<Response>();
  const reached = deferred<AbortSignal | null>();
  heldRole = response;
  roleReached = reached;
  return { response, reached };
};

describe("session-owned auth queries", () => {
  test("an accepted role survives cancellation of a same-owner replacement", async () => {
    const queryClient = createClient();
    queryClient.setQueryData(sessionOptions.queryKey, serverSession);
    expect(await queryClient.query(roleOptions)).toBe("owner");
    const cached = queryClient.getQueryCache().find(roleOptions);
    const held = holdNextRole();
    const replacement = queryClient
      .query({ ...roleOptions, staleTime: 0 })
      .catch((error: unknown) => error);
    const signal = await held.reached.promise;
    await queryClient.cancelQueries({
      queryKey: roleOptions.queryKey,
      exact: true,
    });
    held.response.resolve(Response.json({ role: "member" }));
    await replacement;
    await settleAuthTransition(queryClient);
    expect(signal?.aborted).toBe(true);
    expect(queryClient.getQueryCache().find(roleOptions)).toBe(cached);
    expect(await queryClient.query(roleOptions)).toBe("owner");
    expect(roleRequests()).toHaveLength(2);
  });

  test("organization refresh retains the newly bound role through the frame barrier", async () => {
    const queryClient = createClient();
    queryClient.setQueryData(sessionOptions.queryKey, serverSession);
    await queryClient.query(roleOptions);
    const previous = queryClient.getQueryCache().find(roleOptions);
    serverSession = sessionFor({ organizationId: "org-b" });
    role = "member";
    const response = deferred<Response>();
    const reached = deferred<undefined>();
    heldSession = response;
    sessionReached = reached;
    const refreshing = refreshAuthQueries(queryClient);
    await Promise.race([
      reached.promise,
      refreshing.then(() => {
        throw new Error("Auth refresh completed before its session request");
      }),
    ]);
    expect(roleRequests()).toHaveLength(1);
    response.resolve(Response.json(serverSession));
    await refreshing;
    const current = queryClient.getQueryCache().find(roleOptions);
    expect(current).not.toBe(previous);
    await resetAuthTransition(queryClient, "member:member-a:org-b");
    expect(queryClient.getQueryCache().find(roleOptions)).toBe(current);
    expect(await queryClient.query(roleOptions)).toBe("member");
    expect(roleRequests()).toHaveLength(2);
    expect(
      requests.filter((path) => path.endsWith("/get-session")),
    ).toHaveLength(1);
    expect(requests.some((path) => path.endsWith("/get-active-member"))).toBe(
      false,
    );
  });

  test("the installed guard observes leaving and returning without an intervening role read", async () => {
    const queryClient = createClient();
    queryClient.setQueryData(sessionOptions.queryKey, serverSession);
    const held = holdNextRole();
    const oldRead = queryClient
      .query(roleOptions)
      .catch((error: unknown) => error);
    const signal = await held.reached.promise;
    queryClient.setQueryData(
      sessionOptions.queryKey,
      sessionFor({ organizationId: "org-b" }),
    );
    queryClient.setQueryData(sessionOptions.queryKey, serverSession);
    held.response.resolve(Response.json({ role: "owner" }));
    expect(await oldRead).toBeInstanceOf(CancelledError);
    expect(signal?.aborted).toBe(true);
    heldRole = undefined;
    role = "member";
    expect(await queryClient.query(roleOptions)).toBe("member");
    expect(queryClient.getQueryData(roleOptions.queryKey)).toBe("member");
    expect(roleRequests()).toHaveLength(2);
  });

  test("initial session adoption removes unbound bootstrap cache values", async () => {
    const queryClient = createClient();
    queryClient.setQueryData(rootKeys.role, "owner");
    queryClient.setQueryData(rootKeys.activeMember, "unbound membership");
    queryClient.setQueryData(sessionOptions.queryKey, serverSession);
    await settleAuthTransition(queryClient);
    expect(queryClient.getQueryState(rootKeys.role)).toBeUndefined();
    expect(queryClient.getQueryState(rootKeys.activeMember)).toBeUndefined();
    role = "member";
    expect(await queryClient.query(roleOptions)).toBe("member");
    expect(roleRequests()).toHaveLength(1);
  });

  test.each([
    { name: "failed", remove: false },
    { name: "removed", remove: true },
  ])(
    "a $name session rejects a held replacement without revoking accepted data",
    async (change) => {
      const queryClient = createClient();
      queryClient.setQueryData(sessionOptions.queryKey, serverSession);
      expect(await queryClient.query(roleOptions)).toBe("owner");
      const cached = queryClient.getQueryCache().find(roleOptions);
      const held = holdNextRole();
      const replacement = queryClient
        .query({ ...roleOptions, staleTime: 0 })
        .catch((error: unknown) => error);
      const signal = await held.reached.promise;
      if (change.remove) {
        queryClient.removeQueries({
          queryKey: sessionOptions.queryKey,
          exact: true,
        });
      } else {
        sessionStatus = 503;
        const sessionRead = await queryClient
          .query({ ...sessionOptions, staleTime: 0 })
          .catch((error: unknown) => error);
        expect(sessionRead).toBeInstanceOf(Error);
        expect(queryClient.getQueryState(sessionOptions.queryKey)?.status).toBe(
          "error",
        );
      }
      expect(signal?.aborted).toBe(false);
      held.response.resolve(Response.json({ role: "member" }));
      expect(await replacement).toBeInstanceOf(CancelledError);
      expect(queryClient.getQueryCache().find(roleOptions)).toBe(cached);
      expect(queryClient.getQueryData(roleOptions.queryKey)).toBe("owner");
    },
  );

  test("missing or organization-less sessions do not issue bootstrap requests", async () => {
    const queryClient = createClient();
    expect(
      await queryClient.query(roleOptions).catch((error: unknown) => error),
    ).toBeInstanceOf(CancelledError);
    queryClient.setQueryData(
      sessionOptions.queryKey,
      sessionFor({ organizationId: null }),
    );
    expect(
      await queryClient
        .query(activeMemberOptions)
        .catch((error: unknown) => error),
    ).toBeInstanceOf(CancelledError);
    expect(requests).toEqual([]);
  });

  test("first sign-in refresh does not add an eager role or member request", async () => {
    const queryClient = createClient();
    queryClient.setQueryData(sessionOptions.queryKey, null);
    await refreshAuthQueries(queryClient);
    expect(queryClient.getQueryData(sessionOptions.queryKey)?.user.id).toBe(
      "member-a",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEndWith("/get-session");
  });

  test("a failed session refresh rejects without warming role and still signals other tabs", async () => {
    const queryClient = createClient();
    queryClient.setQueryData(sessionOptions.queryKey, serverSession);
    await queryClient.query(roleOptions);
    sessionStatus = 503;
    const signal = spyOn(
      BroadcastChannel.prototype,
      "postMessage",
    ).mockImplementation(() => undefined);
    try {
      const outcome = await refreshAuthQueries(queryClient).then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect(roleRequests()).toHaveLength(1);
      expect(signal).toHaveBeenCalledTimes(1);
      expect(signal.mock.calls[0]?.[0]).toEqual({
        type: "session-changed",
        sender: expect.any(String),
        nonce: expect.any(String),
      });
    } finally {
      signal.mockRestore();
    }
  });

  test("a failed replacement role rejects and still signals the committed session change", async () => {
    const queryClient = createClient();
    queryClient.setQueryData(sessionOptions.queryKey, serverSession);
    await queryClient.query(roleOptions);
    serverSession = sessionFor({ organizationId: "org-b" });
    roleStatus = 503;
    const signal = spyOn(
      BroadcastChannel.prototype,
      "postMessage",
    ).mockImplementation(() => undefined);
    try {
      const outcome = await refreshAuthQueries(queryClient).then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect(queryClient.getQueryData(roleOptions.queryKey)).toBeUndefined();
      expect(signal).toHaveBeenCalledTimes(1);
    } finally {
      signal.mockRestore();
    }
  });
});
