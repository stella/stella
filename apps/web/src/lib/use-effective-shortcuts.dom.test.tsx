import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DataTag } from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const React = await import("react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { rootKeys, sessionOptions } = await import("@/lib/auth-queries");
const { useShortcutOverrides } = await import("@/lib/use-effective-shortcuts");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

type SessionData =
  typeof sessionOptions.queryKey extends DataTag<unknown, infer Data, unknown>
    ? Data
    : never;

const signedAt = new Date("2026-01-01T00:00:00Z");
const sessionWithShortcuts = (userShortcuts: string | null) =>
  ({
    session: {
      activeOrganizationId: "org_1",
      createdAt: signedAt,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      id: "session_1",
      token: "token",
      updatedAt: signedAt,
      userId: "user_1",
    },
    user: {
      createdAt: signedAt,
      email: "member@example.test",
      emailVerified: true,
      id: "user_1",
      name: "Member",
      timezoneId: "UTC",
      twoFactorEnabled: false,
      updatedAt: signedAt,
      userShortcuts,
    },
  }) satisfies SessionData;

test("shortcut cache reads leave session refetching intact and follow cache changes", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let requests = 0;
  let nextSession = sessionWithShortcuts(JSON.stringify({ search: "Mod+P" }));
  const readSession = async () => {
    requests += 1;
    return nextSession;
  };
  const options = {
    queryKey: sessionOptions.queryKey,
    queryFn: readSession,
    staleTime: Infinity,
  };
  await queryClient.query(options);

  const { result, unmount } = renderHook(
    () => {
      useQuery(options);
      return useShortcutOverrides();
    },
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
    expect(result.current.search?.hotkey).toBe("Mod+P");
    expect(requests).toBe(1);
    nextSession = sessionWithShortcuts(JSON.stringify({ search: "Mod+K" }));
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: rootKeys.session,
        type: "all",
      });
    });
    expect(requests).toBe(2);
    await waitFor(() => expect(result.current.search?.hotkey).toBe("Mod+K"));

    await act(async () => {
      queryClient.setQueryData(
        sessionOptions.queryKey,
        sessionWithShortcuts(JSON.stringify({ search: "Mod+J" })),
      );
    });
    expect(result.current.search?.hotkey).toBe("Mod+J");
    await act(async () => {
      queryClient.setQueryData(sessionOptions.queryKey, null);
    });
    expect(result.current).toEqual({});
  } finally {
    unmount();
    queryClient.clear();
  }
});

test("a public shortcut cache reader creates no session query", () => {
  const queryClient = new QueryClient();
  const { result, unmount } = renderHook(() => useShortcutOverrides(), {
    wrapper: ({ children }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children,
      ),
  });
  try {
    expect(result.current).toEqual({});
    expect(queryClient.getQueryState(rootKeys.session)).toBeUndefined();
  } finally {
    unmount();
    queryClient.clear();
  }
});
