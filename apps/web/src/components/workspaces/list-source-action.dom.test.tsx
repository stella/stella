import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { InferDataFromTag } from "@tanstack/react-query";
import { panic } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import type { OrganizationRoleName } from "@stll/auth-model";
import { sleep } from "@stll/concurrency/sleep";
import { parseTimeZoneId } from "@stll/time";
import { stellaToast } from "@stll/ui/toast";

import arabic from "@/i18n/langs/ar.json";
import czech from "@/i18n/langs/cs.json";
import english from "@/i18n/langs/en.json";
import slovak from "@/i18n/langs/sk.json";
import type { OrganizationSettings } from "@/queries/organization-settings";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
let respondRequest: (request: Request) => Promise<Response> = async () => {
  throw new TypeError("Unexpected source request");
};
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      return await respondRequest(request);
    },
    { preconnect: () => undefined },
  ),
);
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { organizationSettingsOptions } =
  await import("@/queries/organization-settings");
const { roleOptions } = await import("@/lib/auth-queries");
const { workspaceFilesOptions } =
  await import("@/lib/workspaces/queries/entities");
const { legalListKeys, legalListSourcesOptions } =
  await import("@/lib/workspaces/queries/legal-lists");
const { ListSourceAction } = await import("./list-source-action");
const { ListItemSources } = await import("./list-item-sources");
const { PDF_MIME, DOCX_MIME } = await import("@/lib/consts");
const principal = { organizationId: "org-fixture", userId: "user-fixture" };
const workspaceId = "019a0000-0000-7000-8000-000000000001";
const listId = "019a0000-0000-7000-8000-000000000002";
const itemEntityId = "019a0000-0000-7000-8000-000000000003";
const documentId = "019a0000-0000-7000-8000-000000000004";
const versionId = "019a0000-0000-7000-8000-000000000005";
const sourceId = "019a0000-0000-7000-8000-000000000006";
const files = [
  {
    entityId: documentId,
    fieldId: "019a0000-0000-7000-8000-000000000007",
    name: "Signed agreement",
    fileName: "agreement.pdf",
    parentId: null,
    mimeType: PDF_MIME,
  },
  {
    entityId: "019a0000-0000-7000-8000-000000000008",
    fieldId: "019a0000-0000-7000-8000-000000000009",
    name: "Čapek statement",
    fileName: "statement.docx",
    parentId: null,
    mimeType: DOCX_MIME,
  },
];
const settings = {
  declaredFeatureIds: ["legal-lists", "list-verification"],
  deploymentFeatures: { legalLists: true },
  capabilities: {},
  documentProcessingMode: "off",
  matterNumberPattern: "{year}/{number}",
  matterNumberPadding: 3,
  practiceJurisdictions: [],
  promptCachingEnabled: true,
  managedAIResidency: "eu",
  memoryExtractionEnabled: false,
  timeMinimumUnitMinutes: 1,
  timeEditWindowDays: 30,
  timeLockedThroughMonth: null,
  timeNarrativeRequired: false,
  timeZone:
    parseTimeZoneId("UTC") ??
    panic("UTC fixture must be a supported time zone"),
  timeZoneSource: "organization",
} satisfies OrganizationSettings;

const clients: InstanceType<typeof QueryClient>[] = [];
const spies: { mockRestore: () => void }[] = [];
const requests: Request[] = [];
type MountActionOptions = {
  locale?: string;
  messages?: typeof english;
  granted?: boolean;
  role?: OrganizationRoleName;
  showSources?: boolean;
  matterFiles?: typeof files;
};
type ListSourcesData = InferDataFromTag<
  unknown,
  ReturnType<typeof legalListSourcesOptions>["queryKey"]
>;
const emptySources = {
  items: [],
  nextCursor: null,
  limit: 200,
} satisfies ListSourcesData;
const mountAction = async ({
  locale = "en",
  messages = english,
  granted = true,
  role = "owner",
  showSources = false,
  matterFiles = files,
}: MountActionOptions = {}) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(organizationSettingsOptions(principal).queryKey, {
    ...settings,
    capabilities: granted
      ? {
          "legal-lists": { status: "enabled" },
          "list-verification": { status: "enabled" },
        }
      : {},
  });
  client.setQueryData(roleOptions.queryKey, role);
  client.setQueryData(workspaceFilesOptions(workspaceId).queryKey, matterFiles);
  client.setQueryData(
    legalListSourcesOptions({
      workspaceId,
      listId,
      itemEntityId,
      viewer: principal,
    }).queryKey,
    emptySources,
  );
  client.setQueryData(legalListKeys.items(workspaceId, listId), { pages: [] });
  client.setQueryData(
    legalListKeys.activity(workspaceId, listId, itemEntityId),
    { items: [] },
  );
  const invalidation = spyOn(client, "invalidateQueries");
  spies.push(invalidation);
  const created: string[] = [];
  const root = createRootRoute({
    component: () => (
      <>
        <ListSourceAction
          workspaceId={workspaceId}
          listId={listId}
          itemEntityId={itemEntityId}
          onCreated={() => {
            created.push(itemEntityId);
          }}
        />
        {showSources && (
          <ListItemSources
            workspaceId={workspaceId}
            listId={listId}
            itemEntityId={itemEntityId}
          />
        )}
      </>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      <FormattingProvider locale={locale} timeZone="UTC">
        <QueryClientProvider client={client}>
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: principal.organizationId,
              id: principal.userId,
              email: "member@example.test",
              image: null,
              name: "Fixture member",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <RouterProvider router={router} />
          </AuthenticatedUserProvider>
        </QueryClientProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  return { view, client, invalidation, created, messages };
};
const answer = (status = 200) => {
  let stored: Record<string, unknown> | undefined;
  respondRequest = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    requests.push(request);
    if (
      request.method === "GET" &&
      path.startsWith(`/v1/entities/${workspaceId}/entity/`)
    ) {
      const entityId = path.split("/").at(-1);
      return Response.json({
        entityId,
        kind: "document",
        name: "Signed agreement",
        currentVersionId: versionId,
        currentVersionCreatedAt: "2026-10-01T12:00:00Z",
        currentVersionReference: null,
        fields: [],
      });
    }
    if (
      request.method === "POST" &&
      path === `/v1/lists/${workspaceId}/item-sources`
    ) {
      const body = await request.clone().json();
      if (status !== 200) {
        return Response.json({ message: "Not found" }, { status });
      }
      stored = {
        id: sourceId,
        sourceEntityId: body.sourceEntityId,
        sourceEntityVersionId: body.sourceEntityVersionId,
        locator: body.locator,
        quote: body.quote,
        verificationStatus: "unverified",
        verifiedBy: null,
        verifiedAt: null,
        createdAt: "2026-10-01T12:00:00Z",
      };
      return Response.json({ id: sourceId });
    }
    if (request.method === "GET" && path.endsWith("/sources")) {
      return Response.json({
        items: stored === undefined ? [] : [stored],
        nextCursor: null,
      });
    }
    throw new TypeError(`Unexpected source request: ${request.method} ${path}`);
  };
};
const openForm = async (mounted: Awaited<ReturnType<typeof mountAction>>) => {
  fireEvent.click(
    await mounted.view.findByRole("button", {
      name: mounted.messages.lists.sources.add,
    }),
  );
};
const save = async (mounted: Awaited<ReturnType<typeof mountAction>>) => {
  await act(async () => {
    fireEvent.click(
      mounted.view.getByRole("button", { name: mounted.messages.common.save }),
    );
  });
};
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) {
    client.clear();
  }
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
  requests.length = 0;
});
afterAll(async () => {
  await act(async () => await sleep(50));
  fetchBoundary.mockRestore();
  await unregisterDomEnvironment();
});
for (const { locale, messages } of [
  { locale: "en", messages: english },
  { locale: "cs", messages: czech },
  { locale: "sk", messages: slovak },
  { locale: "ar", messages: arabic },
]) {
  test(`${locale}: attach a PDF page and quote, refresh sources and the fact, and show the new source`, async () => {
    answer();
    const mounted = await mountAction({ locale, messages, showSources: true });
    await openForm(mounted);
    fireEvent.click(mounted.view.getByText("Signed agreement"));
    fireEvent.change(mounted.view.getByLabelText(messages.lists.sources.page), {
      target: { value: "12" },
    });
    fireEvent.change(
      mounted.view.getByLabelText(messages.lists.sources.quote),
      { target: { value: "Payment falls due on delivery." } },
    );
    await save(mounted);
    await waitFor(() => expect(mounted.created).toEqual([itemEntityId]));
    const post = requests.find((request) => request.method === "POST");
    expect(await post?.json()).toEqual({
      listId,
      itemEntityId,
      sourceEntityId: documentId,
      sourceEntityVersionId: versionId,
      locator: { type: "pdf-page", pageNumber: 12 },
      quote: "Payment falls due on delivery.",
    });
    expect(
      await mounted.view.findByText("Payment falls due on delivery."),
    ).toBeTruthy();
    expect(mounted.view.queryByText(messages.common.empty)).toBeNull();
    expect(mounted.invalidation).toHaveBeenCalledWith({
      queryKey: legalListKeys.items(workspaceId, listId),
    });
    expect(
      mounted.client.getQueryState(legalListKeys.items(workspaceId, listId))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      mounted.client.getQueryState(
        legalListKeys.activity(workspaceId, listId, itemEntityId),
      )?.isInvalidated,
    ).toBe(true);
    expect(
      mounted.view.queryByLabelText(messages.lists.sources.quote),
    ).toBeNull();
  });
}
for (const value of ["0", "-1", "1.5", "9007199254740992"]) {
  test(`a page reference of ${value} reports validation and sends no request`, async () => {
    answer();
    const mounted = await mountAction();
    await openForm(mounted);
    fireEvent.click(mounted.view.getByText("Signed agreement"));
    fireEvent.change(mounted.view.getByLabelText(english.lists.sources.page), {
      target: { value },
    });
    await save(mounted);
    expect((await mounted.view.findByRole("alert")).textContent).toBe(
      english.lists.sources.invalidPage,
    );
    expect(requests).toHaveLength(0);
  });
}
test("zero sources show an explicit empty message after a successful query", async () => {
  answer();
  const mounted = await mountAction({ showSources: true });
  expect(
    mounted.client.getQueryState(
      legalListSourcesOptions({
        workspaceId,
        listId,
        itemEntityId,
        viewer: principal,
      }).queryKey,
    )?.status,
  ).toBe("success");
  expect(mounted.view.getByText(english.common.empty)).toBeTruthy();
  expect(mounted.view.queryByRole("article")).toBeNull();
});
test("zero matter files keep the document picker and no-results message visible", async () => {
  answer();
  const mounted = await mountAction({ matterFiles: [] });
  await openForm(mounted);
  expect(mounted.view.getByText(english.common.document)).toBeTruthy();
  expect(
    mounted.view.getByRole("searchbox", { name: english.common.search }),
  ).toBeTruthy();
  expect(mounted.view.getByText(english.common.noResults)).toBeTruthy();
  expect(mounted.view.queryByRole("checkbox")).toBeNull();
});
test("a document is required and the quote limit rejects excess input", async () => {
  answer();
  const mounted = await mountAction();
  await openForm(mounted);
  await save(mounted);
  expect((await mounted.view.findByRole("alert")).textContent).toBe(
    english.lists.sources.documentRequired,
  );
  fireEvent.click(mounted.view.getByText("Signed agreement"));
  fireEvent.change(mounted.view.getByLabelText(english.lists.sources.quote), {
    target: { value: "x".repeat(10_001) },
  });
  await save(mounted);
  expect((await mounted.view.findByRole("alert")).textContent).toBe(
    english.lists.sources.quoteTooLong.replace("{limit}", "10,000"),
  );
  expect(requests).toHaveLength(0);
});
test("correcting a page validation error allows saving without reopening the form", async () => {
  answer();
  const mounted = await mountAction();
  await openForm(mounted);
  fireEvent.click(mounted.view.getByText("Signed agreement"));
  fireEvent.change(mounted.view.getByLabelText(english.lists.sources.page), {
    target: { value: "0" },
  });
  await save(mounted);
  expect(await mounted.view.findByRole("alert")).toBeTruthy();
  fireEvent.change(mounted.view.getByLabelText(english.lists.sources.page), {
    target: { value: "1" },
  });
  await save(mounted);
  await waitFor(() => expect(mounted.created).toHaveLength(1));
  const body = await requests
    .find((request) => request.method === "POST")
    ?.json();
  expect(body.locator).toEqual({ type: "pdf-page", pageNumber: 1 });
});
test("choosing DOCX replaces PDF, clears its page, and accepts a quote at the limit", async () => {
  answer();
  const mounted = await mountAction();
  await openForm(mounted);
  fireEvent.click(mounted.view.getByText("Signed agreement"));
  fireEvent.change(mounted.view.getByLabelText(english.lists.sources.page), {
    target: { value: "12" },
  });
  fireEvent.change(
    mounted.view.getByRole("searchbox", { name: english.common.search }),
    { target: { value: "capek" } },
  );
  fireEvent.click(mounted.view.getByText("Čapek statement"));
  expect(mounted.view.queryByLabelText(english.lists.sources.page)).toBeNull();
  fireEvent.change(mounted.view.getByLabelText(english.lists.sources.quote), {
    target: { value: "x".repeat(10_000) },
  });
  await save(mounted);
  await waitFor(() => expect(mounted.created).toHaveLength(1));
  const body = await requests
    .find((request) => request.method === "POST")
    ?.json();
  expect(body.locator).toEqual({ type: "document" });
  expect(body.sourceEntityId).toBe(files.at(1)?.entityId);
  expect(body.quote).toHaveLength(10_000);
});
test("an optional page and quote can both be omitted", async () => {
  answer();
  const mounted = await mountAction();
  await openForm(mounted);
  fireEvent.click(mounted.view.getByText("Signed agreement"));
  await save(mounted);
  await waitFor(() => expect(mounted.created).toHaveLength(1));
  const body = await requests
    .find((request) => request.method === "POST")
    ?.json();
  expect(body.locator).toEqual({ type: "document" });
  expect(body.quote).toBeNull();
});
test("a server refusal preserves the draft, reports an error, and leaves sources unchanged", async () => {
  answer(404);
  const toast = spyOn(stellaToast, "add").mockReturnValue("source-toast");
  spies.push(toast);
  const mounted = await mountAction();
  await openForm(mounted);
  fireEvent.click(mounted.view.getByText("Signed agreement"));
  fireEvent.change(mounted.view.getByLabelText(english.lists.sources.quote), {
    target: { value: "Keep this quote" },
  });
  await save(mounted);
  await waitFor(() => expect(toast).toHaveBeenCalled());
  expect(
    mounted.view
      .getByLabelText(english.lists.sources.quote)
      .getAttribute("aria-invalid"),
  ).not.toBe("true");
  expect(
    mounted.view.getByLabelText(english.lists.sources.quote).textContent,
  ).toBe("Keep this quote");
  expect(mounted.invalidation).not.toHaveBeenCalled();
  expect(mounted.created).toHaveLength(0);
});
for (const options of [
  { granted: false },
  { role: "intern" },
] as const satisfies readonly MountActionOptions[]) {
  test(`the attach action is hidden with ${JSON.stringify(options)}`, async () => {
    answer();
    const mounted = await mountAction(options);
    expect(
      mounted.view.queryByRole("button", { name: english.lists.sources.add }),
    ).toBeNull();
    expect(requests).toHaveLength(0);
  });
}
test("revoking the feature closes an open form without a create request", async () => {
  answer();
  const mounted = await mountAction();
  await openForm(mounted);
  act(() => {
    mounted.client.setQueryData(
      organizationSettingsOptions(principal).queryKey,
      settings,
    );
  });
  await act(async () => {
    await sleep(50);
  });
  expect(
    mounted.view.queryByRole("button", { name: english.common.save }),
  ).toBeNull();
  expect(requests).toHaveLength(0);
});
