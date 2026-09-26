import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DataTag, QueryClient as Client } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";

// A DOM for this file only: the hook is read while its query observer is
// mounted, the state a real page is in when a session read fails.
GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { renderHook, waitFor } = await import("@testing-library/react");
const { resolveFeedbackChannel } =
  await import("@/components/feedback-dialog.logic");
const { useClientAuthStatus } = await import("@/hooks/use-client-auth-status");
const { sessionOptions } = await import("@/lib/auth-queries");

afterAll(async () => {
  await GlobalRegistrator.unregister();
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

const SESSION_READ_FAILED = new Error("session read failed");

const renderAuthStatus = (queryClient: Client) =>
  renderHook(() => useClientAuthStatus(), {
    wrapper: ({ children }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children,
      ),
  });

/** A session read answered by `answer`, in place of the real auth client. */
const readSession = async (
  queryClient: Client,
  answer: () => Promise<SessionData | null>,
) => {
  await queryClient
    .query({
      queryKey: sessionOptions.queryKey,
      queryFn: answer,
      retry: false,
      staleTime: 0,
    })
    .catch(() => undefined);
};

/** A session read the test settles, started before the hook mounts so the
 *  observer joins it rather than starting its own. */
const startSessionRead = (queryClient: Client) => {
  const read = Promise.withResolvers<SessionData | null>();
  const settled = readSession(queryClient, async () => await read.promise);
  return { read, settled };
};

describe("client auth status", () => {
  test("a session read that fails is unknown, not a visitor", async () => {
    const queryClient = new QueryClient();
    const { read, settled } = startSessionRead(queryClient);
    const { result } = renderAuthStatus(queryClient);
    expect(result.current.status).toBe("checking");

    read.reject(SESSION_READ_FAILED);
    await settled;

    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    expect(resolveFeedbackChannel(result.current.status)).toBeNull();
  });

  test("a failed refetch does not turn a cached member into a visitor", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
    const { result } = renderAuthStatus(queryClient);
    expect(result.current.status).toBe("authenticated");

    await readSession(queryClient, async () => {
      throw SESSION_READ_FAILED;
    });

    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    // The member session is still cached; only its freshness is in doubt.
    expect(
      queryClient.getQueryData(sessionOptions.queryKey)?.session.userId,
    ).toBe(MEMBER_SESSION.session.userId);
    expect(resolveFeedbackChannel(result.current.status)).toBeNull();
  });

  test("a read that answers with no session is a visitor", async () => {
    const queryClient = new QueryClient();
    const { read, settled } = startSessionRead(queryClient);
    const { result } = renderAuthStatus(queryClient);

    read.resolve(null);
    await settled;

    await waitFor(() => {
      expect(result.current.status).toBe("anonymous");
    });
    expect(resolveFeedbackChannel(result.current.status)).toBe("public");
  });
});
