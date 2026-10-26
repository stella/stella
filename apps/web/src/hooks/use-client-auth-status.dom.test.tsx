import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DataTag, QueryClient as Client } from "@tanstack/react-query";
import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { MEMBER_SESSION } from "@/lib/account/auth-session.test-fixtures";
import { unregisterDomEnvironment } from "@/test-dom-environment";

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
const { professionalUseOptions, sessionOptions } =
  await import("@/lib/auth-queries");

afterAll(async () => {
  await unregisterDomEnvironment();
});

type SessionData =
  typeof sessionOptions.queryKey extends DataTag<unknown, infer TData, unknown>
    ? NonNullable<TData>
    : never;

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
    // swallow-ok: injected session failure is asserted as unavailable hook state by the calling tests
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
    queryClient.setQueryData(
      professionalUseOptions(MEMBER_SESSION.session.userId).queryKey,
      {
        status: "accepted",
        statementVersion: "2026-10",
        termsVersion: "2026-10",
        acceptedAt: MEMBER_SESSION.session.createdAt.toISOString(),
      },
    );
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

  // Hosts that need the state only on some pages pass `enabled: false`; a
  // member signed in on another page must still read as authenticated.
  test("a disabled read serves a cached member without asking the server", async () => {
    const fetchBoundary = spyOn(globalThis, "fetch");
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
    queryClient.setQueryData(
      professionalUseOptions(MEMBER_SESSION.session.userId).queryKey,
      {
        status: "accepted",
        statementVersion: "2026-10",
        termsVersion: "2026-10",
        acceptedAt: MEMBER_SESSION.session.createdAt.toISOString(),
      },
    );
    const { result, unmount } = renderHook(
      () => useClientAuthStatus({ enabled: false }),
      {
        wrapper: ({ children }) =>
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            children,
          ),
      },
    );
    try {
      expect(result.current.status).toBe("authenticated");
      expect(fetchBoundary).not.toHaveBeenCalled();
    } finally {
      unmount();
      queryClient.clear();
      fetchBoundary.mockRestore();
    }
  });

  // The API refuses its member requests until it accepts, so public pages
  // serve it exactly as they serve a visitor.
  test("a member whose account has not accepted the professional-use statement is a visitor", async () => {
    const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const url = input instanceof Request ? input.url : input;
          expect(new URL(url).href).toBe(
            "http://localhost:3001/v1/me/professional-use",
          );
          return Response.json({ status: "required" });
        },
        { preconnect: () => undefined },
      ),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
    queryClient.setQueryData(
      professionalUseOptions(MEMBER_SESSION.session.userId).queryKey,
      { status: "required" },
    );
    const { result, unmount } = renderAuthStatus(queryClient);
    try {
      expect(result.current.status).toBe("anonymous");
      expect(resolveFeedbackChannel(result.current.status)).toBe("public");
      await waitFor(() => {
        expect(fetchBoundary).toHaveBeenCalledTimes(1);
        expect(queryClient.isFetching()).toBe(0);
      });
      expect(result.current.status).toBe("anonymous");
    } finally {
      unmount();
      queryClient.clear();
      fetchBoundary.mockRestore();
    }
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

test("a public server shell hydrates without exposing a preloaded browser identity", async () => {
  const { renderToString } = await import("react-dom/server");
  const { hydrateRoot } = await import("react-dom/client");
  const serverClient = new QueryClient();
  const browserClient = new QueryClient();
  browserClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  browserClient.setQueryData(
    professionalUseOptions(MEMBER_SESSION.session.userId).queryKey,
    {
      status: "accepted",
      statementVersion: "2026-10",
      termsVersion: "2026-10",
      acceptedAt: MEMBER_SESSION.session.createdAt.toISOString(),
    },
  );
  const PublicIdentity = () =>
    React.createElement(
      "p",
      null,
      useClientAuthStatus({ enabled: false }).status,
    );
  const tree = (client: Client) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(PublicIdentity),
    );
  const container = document.createElement("div");
  // safe-html: React renderToString output from the local PublicIdentity fixture.
  container.innerHTML = renderToString(tree(serverClient));
  expect(container.textContent).toBe("checking");
  document.body.append(container);
  const errors: unknown[] = [];
  const root = hydrateRoot(container, tree(browserClient), {
    onRecoverableError: (error) => {
      errors.push(error);
    },
  });
  try {
    await waitFor(() => expect(container.textContent).toBe("authenticated"));
    expect(errors).toEqual([]);
  } finally {
    await React.act(async () => root.unmount());
    container.remove();
    serverClient.clear();
    browserClient.clear();
  }
});
