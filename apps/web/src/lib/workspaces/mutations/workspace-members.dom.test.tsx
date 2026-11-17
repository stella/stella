import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { rejectionOf } from "@stll/property-testing/rejection";

import englishMessages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import type { workspaceMembersOptions as memberQueryOptions } from "@/lib/workspaces/queries/workspace-members";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const originalFetch = globalThis.fetch;
const workspaceId = "00000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "00000000-0000-4000-8000-000000000002";
const userId = toSafeId<"user">("00000000-0000-4000-8000-000000000003");
const otherUserId = toSafeId<"user">("00000000-0000-4000-8000-000000000004");
type MemberResponse = Awaited<
  ReturnType<NonNullable<ReturnType<typeof memberQueryOptions>["queryFn"]>>
>;
const members = [
  {
    id: toSafeId<"workspaceMember">("00000000-0000-4000-8000-000000000005"),
    userId,
    createdAt: "2026-11-01T12:00:00.000Z",
    user: {
      id: userId,
      name: "Member One",
      image: null,
      email: "one@example.test",
    },
  },
  {
    id: toSafeId<"workspaceMember">("00000000-0000-4000-8000-000000000006"),
    userId: otherUserId,
    createdAt: "2026-11-01T12:00:00.000Z",
    user: {
      id: otherUserId,
      name: "Member Two",
      image: null,
      email: "two@example.test",
    },
  },
] satisfies MemberResponse;
let answer = Promise.withResolvers<Response>();
const writes: { method: string; path: string; replayKey: string | null }[] = [];
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.pathname.endsWith("/members") && method === "GET") {
      return Response.json(members);
    }
    if (
      url.pathname.includes("/members") &&
      (method === "PUT" || method === "DELETE")
    ) {
      writes.push({
        method,
        path: url.pathname,
        replayKey: new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ).get("Idempotency-Key"),
      });
      return await answer.promise;
    }
    throw new Error(`Unexpected member request: ${method} ${url.pathname}`);
  },
  { preconnect: originalFetch.preconnect },
);
const { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { queryView } = await import("@/lib/query-view.logic");
const { MembersList } = await import("@/components/workspaces/members-section");
const { useAddWorkspaceMember } = await import("./workspace-members");
const { workspaceMembersOptions } =
  await import("@/lib/workspaces/queries/workspace-members");
const { workspacesKeys } = await import("@/lib/workspaces/queries");

beforeEach(() => {
  answer = Promise.withResolvers<Response>();
  writes.length = 0;
});
afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const prepare = async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const own = workspaceMembersOptions(workspaceId);
  const other = workspaceMembersOptions(otherWorkspaceId);
  await client.query(own);
  await client.query(other);
  client.setQueryData(workspacesKeys.all, [workspaceId]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </IntlProvider>
  );
  return { client, own, other, wrapper };
};

const expectRefreshed = (state: Awaited<ReturnType<typeof prepare>>) => {
  expect(state.client.getQueryState(state.own.queryKey)?.isInvalidated).toBe(
    true,
  );
  expect(state.client.getQueryState(workspacesKeys.all)?.isInvalidated).toBe(
    true,
  );
  expect(state.client.getQueryState(state.other.queryKey)?.isInvalidated).toBe(
    false,
  );
};

test("add completion after its hook unmounts still refreshes membership readers and matters", async () => {
  const state = await prepare();
  try {
    expect(
      state.client.getQueryCache().find({ queryKey: state.own.queryKey })?.meta
        ?.resourceReads,
    ).toEqual({
      resources: [RESOURCE_TYPE.WORKSPACE],
      scope: { type: "workspace", workspaceId },
    });
    const hook = renderHook(useAddWorkspaceMember, { wrapper: state.wrapper });
    let completion: Promise<unknown> | undefined;
    act(() => {
      completion = hook.result.current.mutateAsync({ workspaceId, userId });
    });
    await waitFor(() => expect(writes).toHaveLength(1));
    hook.unmount();
    answer.resolve(Response.json({ id: "membership-added" }));
    await act(async () => {
      await (completion ?? panic("Missing add submission"));
    });
    expect(writes).toEqual([
      {
        method: "PUT",
        path: `/v1/workspaces/${workspaceId}/members`,
        replayKey: null,
      },
    ]);
    expectRefreshed(state);
  } finally {
    state.client.clear();
  }
});

test("remove completion after its row unmounts still refreshes membership readers and matters", async () => {
  const state = await prepare();
  try {
    const ReadMembers = () => (
      <MembersList
        view={queryView(useQuery({ ...state.own, staleTime: Infinity }))}
        workspaceId={workspaceId}
        canUpdate
      />
    );
    const view = render(<ReadMembers />, { wrapper: state.wrapper });
    fireEvent.click(
      screen
        .getAllByRole("button", { name: englishMessages.common.removeMember })
        .at(0) ?? panic("Missing remove button"),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: englishMessages.common.removeMember,
      }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    view.unmount();
    await act(async () => {
      answer.resolve(
        Response.json({
          id: members.at(0)?.id ?? panic("Missing member fixture"),
        }),
      );
    });
    await waitFor(() =>
      expect(state.client.getMutationCache().getAll().at(0)?.state.status).toBe(
        "success",
      ),
    );
    expect(writes).toEqual([
      {
        method: "DELETE",
        path: `/v1/workspaces/${workspaceId}/members/${userId}`,
        replayKey: null,
      },
    ]);
    expectRefreshed(state);
  } finally {
    state.client.clear();
  }
});

test("a refused add leaves membership readers and matters current", async () => {
  const state = await prepare();
  try {
    const hook = renderHook(useAddWorkspaceMember, { wrapper: state.wrapper });
    const failure = rejectionOf(
      hook.result.current.mutateAsync({ workspaceId, userId }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    answer.resolve(
      Response.json({ message: "Member cannot be added" }, { status: 409 }),
    );
    await act(async () => {
      expect(await failure).toBeInstanceOf(Error);
    });
    expect(state.client.getQueryState(state.own.queryKey)?.isInvalidated).toBe(
      false,
    );
    expect(state.client.getQueryState(workspacesKeys.all)?.isInvalidated).toBe(
      false,
    );
    expect(
      state.client.getQueryState(state.other.queryKey)?.isInvalidated,
    ).toBe(false);
  } finally {
    state.client.clear();
  }
});
