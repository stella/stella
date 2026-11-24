import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";
import * as v from "valibot";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import en from "@/i18n/langs/en.json";
import type { WebApiRoutes } from "@/lib/api-contract";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  __APP_VERSION__: "test",
  __APP_COMMIT_SHA__: "0000000000000000000000000000000000000000",
});
const originalFetch = globalThis.fetch;
const writes: Record<string, unknown>[] = [];
let reloadOutcome: "current" | "missing" | "failed" = "current";
let refuseRename = true;
let exactReads = 0;
let listVersion: keyof typeof listedSearches = "original";
let heldReload: Promise<Response> | undefined;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/v1/saved-searches" && request.method === "GET") {
      return Response.json({
        items: [listedSearches[listVersion]],
        nextCursor: null,
        limit: 25,
      });
    }
    if (
      path === `/v1/saved-searches/${originalSearch.id}` &&
      request.method === "GET"
    ) {
      exactReads += 1;
      if (heldReload) {
        return await heldReload;
      }
      switch (reloadOutcome) {
        case "current":
          return Response.json(currentSearch);
        case "missing":
          return Response.json(
            { message: "Saved search not found" },
            { status: 404 },
          );
        case "failed":
          return Response.json({ message: "Read failed" }, { status: 500 });
      }
    }
    if (
      path === `/v1/saved-searches/${originalSearch.id}` &&
      request.method === "PATCH"
    ) {
      writes.push(
        v.parse(v.record(v.string(), v.unknown()), await request.json()),
      );
      if (!refuseRename) {
        listVersion = "renamed";
        return Response.json(renamedSearch);
      }
      return Response.json(
        {
          code: API_VERSION_CONFLICT_ERROR_CODE,
          message:
            "Saved search changed while it was being edited; reload and try again",
        },
        { status: 409 },
      );
    }
    return Response.json(
      { message: "Unexpected fixture request" },
      { status: 404 },
    );
  },
  { preconnect: () => undefined },
);

const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { drainReactScheduler } =
  await import("@stll/property-testing/dom-environment");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { ToastProvider } = await import("@stll/ui/toast");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { toSafeId } = await import("@/lib/safe-id");
const { SavedSearches } = await import("./saved-searches");
const ORGANIZATION_ID = "00000000-0000-7000-8000-000000000041";
const USER_ID = "00000000-0000-7000-8000-000000000042";
const originalSearch = {
  id: toSafeId<"savedSearch">("00000000-0000-7000-8000-000000000043"),
  name: "Original stored name",
  criteria: {
    version: 1,
    query: "motion",
    workspaceIds: [],
    types: [],
    kinds: [],
    editedByUserIds: [],
    mimeTypes: [],
    sort: "relevance",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.001Z",
} satisfies WebApiRoutes["saved-searches"]["get"]["response"][200]["items"][number];
const currentSearch = {
  ...originalSearch,
  name: "Latest stored name",
  updatedAt: "2026-01-01T00:00:00.002Z",
};
const renamedSearch = {
  ...currentSearch,
  name: "My draft name",
  updatedAt: "2026-01-01T00:00:00.003Z",
};
const OTHER_USER_ID = "00000000-0000-7000-8000-000000000044";
const OTHER_ORGANIZATION_ID = "00000000-0000-7000-8000-000000000045";
const otherSearch = {
  ...originalSearch,
  id: toSafeId<"savedSearch">("00000000-0000-7000-8000-000000000046"),
  name: "Other owner stored name",
  updatedAt: "2026-01-01T00:00:00.010Z",
};
const listedSearches = {
  original: originalSearch,
  renamed: renamedSearch,
  other: otherSearch,
};
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  writes.length = 0;
  exactReads = 0;
  listVersion = "original";
  heldReload = undefined;
  reloadOutcome = "current";
  refuseRename = true;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const editName = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const ownerView = ({
    organizationId,
    userId,
  }: {
    organizationId: string;
    userId: string;
  }) => (
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: organizationId,
            id: userId,
            email: "owner@example.test",
            name: "Owner",
            preferredName: null,
            image: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <TooltipProvider>
            <SavedSearches
              filters={{
                workspaceIds: [],
                types: [],
                kinds: [],
                editedByUserIds: [],
                mimeTypes: [],
              }}
              query="motion"
              isOpen
              onApply={() => undefined}
            />
            <ToastProvider />
          </TooltipProvider>
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
  const mounted = render(
    ownerView({ organizationId: ORGANIZATION_ID, userId: USER_ID }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: en.common.rename }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: en.search.renameSearchTitle,
  });
  expect(dialog.textContent).toContain(originalSearch.name);
  const input = within(dialog).getByRole("textbox", { name: en.common.name });
  if (!(input instanceof HTMLInputElement)) {
    return panic("Rename fixture did not render its input");
  }
  fireEvent.change(input, { target: { value: "My draft name" } });
  return {
    dialog,
    input,
    save: within(dialog).getByRole("button", { name: en.common.save }),
    changeOwner: (owner: { organizationId: string; userId: string }) => {
      listVersion = "other";
      mounted.rerender(ownerView(owner));
    },
  };
};

test("keeps a conflicting draft until explicit exact-resource reload and deliberate save", async () => {
  const { dialog, input, save } = await editName();
  fireEvent.click(save);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes).toEqual([
    { name: "My draft name", expectedUpdatedAt: originalSearch.updatedAt },
  ]);
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toContain(
      en.errors.apiCodes.versionConflict,
    ),
  );
  expect(input.value).toBe("My draft name");
  expect(save.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(save);
  expect(writes).toHaveLength(1);
  expect(exactReads).toBe(0);
  fireEvent.click(
    within(dialog).getByRole("button", { name: en.common.reload }),
  );
  await waitFor(() => expect(dialog.textContent).toContain(currentSearch.name));
  await waitFor(() =>
    expect(save.getAttribute("aria-disabled")).not.toBe("true"),
  );
  expect(input.value).toBe("My draft name");
  expect(exactReads).toBe(1);
  expect(writes).toHaveLength(1);
  refuseRename = false;
  fireEvent.click(save);
  await waitFor(() =>
    expect(writes).toEqual([
      { name: "My draft name", expectedUpdatedAt: originalSearch.updatedAt },
      { name: "My draft name", expectedUpdatedAt: currentSearch.updatedAt },
    ]),
  );
  await act(async () => await drainReactScheduler());
  await waitFor(() => expect(dialog.dataset["open"] === undefined).toBe(true));
  await screen.findByRole("button", { name: renamedSearch.name });
  expect(
    screen.queryByRole("dialog", { name: en.search.renameSearchTitle }) ===
      null,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: en.common.rename }));
  const reopened = await screen.findByRole("dialog", {
    name: en.search.renameSearchTitle,
  });
  const reopenedInput = within(reopened).getByRole("textbox", {
    name: en.common.name,
  });
  if (!(reopenedInput instanceof HTMLInputElement)) {
    panic("Reopened rename did not render its input");
  }
  expect(reopenedInput.value).toBe(renamedSearch.name);
  fireEvent.click(
    within(reopened).getByRole("button", { name: en.common.save }),
  );
  await waitFor(() =>
    expect(writes.at(2)).toEqual({
      name: renamedSearch.name,
      expectedUpdatedAt: renamedSearch.updatedAt,
    }),
  );
});

test.each([{ outcome: "missing" }, { outcome: "failed" }] as const)(
  "does not adopt a token or lose the draft when reload is %s",
  async ({ outcome }) => {
    reloadOutcome = outcome;
    const { dialog, input, save } = await editName();
    fireEvent.click(save);
    const reload = await within(dialog).findByRole("button", {
      name: en.common.reload,
    });
    fireEvent.click(reload);
    await waitFor(() => expect(exactReads).toBe(1));
    await waitFor(() =>
      expect(reload.getAttribute("aria-disabled")).not.toBe("true"),
    );
    expect(input.value).toBe("My draft name");
    expect(dialog.textContent).toContain(originalSearch.name);
    expect(dialog.textContent).not.toContain(currentSearch.name);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(save);
    expect(writes).toEqual([
      { name: "My draft name", expectedUpdatedAt: originalSearch.updatedAt },
    ]);
  },
);

test.each([
  { change: "user", organizationId: ORGANIZATION_ID, userId: OTHER_USER_ID },
  {
    change: "organization",
    organizationId: OTHER_ORGANIZATION_ID,
    userId: USER_ID,
  },
])(
  "retires a held reload when the authenticated $change changes",
  async ({ organizationId, userId }) => {
    const response = Promise.withResolvers<Response>();
    heldReload = response.promise;
    const { dialog, save, changeOwner } = await editName();
    try {
      fireEvent.click(save);
      const reload = await within(dialog).findByRole("button", {
        name: en.common.reload,
      });
      fireEvent.click(reload);
      await waitFor(() => expect(exactReads).toBe(1));
      await act(async () => changeOwner({ organizationId, userId }));
      expect(
        screen.queryByRole("dialog", { name: en.search.renameSearchTitle }) ===
          null,
      ).toBe(true);
      await screen.findByRole("button", { name: otherSearch.name });
      await act(async () => {
        response.resolve(Response.json(currentSearch));
        await drainReactScheduler();
      });
      expect(
        screen.queryByRole("dialog", { name: en.search.renameSearchTitle }) ===
          null,
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: en.common.rename }));
      const nextDialog = await screen.findByRole("dialog", {
        name: en.search.renameSearchTitle,
      });
      const nextInput = within(nextDialog).getByRole("textbox", {
        name: en.common.name,
      });
      if (!(nextInput instanceof HTMLInputElement)) {
        panic("New owner did not receive its editor");
      }
      expect(nextInput.value).toBe(otherSearch.name);
      expect(nextDialog.textContent).not.toContain(currentSearch.name);
      expect(writes).toHaveLength(1);
    } finally {
      await act(async () => {
        response.resolve(Response.json(currentSearch));
        await drainReactScheduler();
      });
    }
  },
);
