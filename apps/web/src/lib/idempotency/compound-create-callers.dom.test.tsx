import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { parseTimeZoneId } from "@stll/time";

import type { WorkspaceViewTemplate } from "@/lib/workspaces/queries/view-templates";
import type { OrganizationSettings } from "@/queries/organization-settings";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { viewsOptions } = await import("@/lib/workspaces/queries/views");
const { viewTemplatesOptions } =
  await import("@/lib/workspaces/queries/view-templates");
const { organizationSettingsOptions } =
  await import("@/queries/organization-settings");
const { useComposerSubmit } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-composer");
const { TemplatePickerDialog } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/view/template-picker-dialog");
const { ViewSwitcher } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/view/view-switcher");
const { ClientOperationError } = await import("@/lib/errors/client");
const messages = (await import("@/i18n/langs/en.json")).default;
const originalFetch = globalThis.fetch;
const clients: InstanceType<typeof QueryClient>[] = [];
const workspaceId = "00000000-0000-4000-8000-000000000061";
const invoiceId = "00000000-0000-4000-8000-000000000062";
const user = {
  activeOrganizationId: "compound-org",
  id: "compound-user",
  email: "reviewer@example.test",
  image: null,
  name: "Reviewer",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const tableLayout = {
  version: 1,
  type: "table",
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
  columnOrder: [],
  columnPinning: [],
} as const satisfies WorkspaceViewTemplate["layout"];
const template = {
  version: 1,
  id: "00000000-0000-4000-8000-000000000063",
  name: "Billing review",
  layout: tableLayout,
  templateProperties: [],
  layoutType: "table",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
} satisfies WorkspaceViewTemplate;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  for (const client of clients.splice(0)) {
    client.clear();
  }
});
afterAll(unregisterDomEnvironment);

const createClient = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "owner");
  client.setQueryData(viewsOptions(workspaceId).queryKey, []);
  client.setQueryData(
    viewTemplatesOptions({
      key: { organizationId: user.activeOrganizationId, userId: user.id },
      context: { workspaceId },
    }).queryKey,
    [template],
  );
  const timeZone = parseTimeZoneId("UTC") ?? panic("Fixture UTC must exist");
  const settings = {
    declaredFeatureIds: [],
    deploymentFeatures: { legalLists: true },
    capabilities: {},
    documentProcessingMode: "off",
    matterNumberPattern: "{year}/{number}",
    matterNumberPadding: 3,
    matterNumberingEnabled: true,
    practiceJurisdictions: [],
    promptCachingEnabled: true,
    managedAIResidency: "eu",
    memoryExtractionEnabled: false,
    timeMinimumUnitMinutes: 1,
    timeEditWindowDays: 30,
    timeLockedThroughMonth: null,
    timeNarrativeRequired: false,
    timeZone,
    timeZoneSource: "organization",
  } satisfies OrganizationSettings;
  client.setQueryData(
    organizationSettingsOptions({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }).queryKey,
    settings,
  );
  return client;
};

const renderProtected = async (children: ReactElement) => {
  const client = createClient();
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user }),
  });
  const page = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/compound",
    component: () => children,
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([page])]),
    history: router.createMemoryHistory({ initialEntries: ["/compound"] }),
    isServer: false,
  });
  await appRouter.load();
  return render(
    <IntlProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <AuthenticatedUserProvider user={user}>
          <router.RouterProvider router={appRouter} />
        </AuthenticatedUserProvider>
      </QueryClientProvider>
    </IntlProvider>,
  );
};

const ComposerSubmitButton = ({
  onDone,
}: {
  onDone: Parameters<typeof useComposerSubmit>[0]["onDone"];
}) => {
  const submit = useComposerSubmit({ workspaceId, onDone });
  return (
    <button
      type="button"
      onClick={() =>
        submit.mutate({
          issue: true,
          body: {
            invoiceDate: "2026-10-27",
            currency: "EUR",
            timeEntryIds: [],
          },
        })
      }
    >
      {messages.billing.invoiceComposer.issueInvoice}
    </button>
  );
};

for (const finalizationLost of [false, true]) {
  test(`the real invoice composer sends no replay key with lost finalization response ${finalizationLost}`, async () => {
    const requests: Request[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "PUT") {
          return Response.json({ id: invoiceId, totalAmount: 100 });
        }
        if (request.method === "POST") {
          if (finalizationLost) {
            throw new ClientOperationError({
              action: "finalize-invoice",
              message: "Finalization response lost",
            });
          }
          return Response.json({ id: invoiceId });
        }
        return Response.json({
          id: invoiceId,
          status: "issued",
          invoiceNumber: "2026/1",
          totalAmount: 100,
          currency: "EUR",
          dueDate: null,
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const completed: boolean[] = [];
    const view = await renderProtected(
      <ComposerSubmitButton
        onDone={(invoice) => {
          completed.push(invoice.issued);
        }}
      />,
    );
    fireEvent.click(
      view.getByRole("button", {
        name: messages.billing.invoiceComposer.issueInvoice,
      }),
    );
    await waitFor(() => expect(completed).toEqual([!finalizationLost]));
    expect(requests.map(({ method }) => method)).toEqual(
      !finalizationLost ? ["PUT", "POST", "GET"] : ["PUT", "POST"],
    );
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(
      !finalizationLost
        ? [
            `/v1/invoices/${workspaceId}`,
            `/v1/invoices/${workspaceId}/${invoiceId}/transition`,
            `/v1/invoices/${workspaceId}/${invoiceId}`,
          ]
        : [
            `/v1/invoices/${workspaceId}`,
            `/v1/invoices/${workspaceId}/${invoiceId}/transition`,
          ],
    );
    for (const request of requests) {
      expect(request.headers.get("Idempotency-Key")).toBeNull();
    }
    expect(await requests.at(1)?.json()).toEqual({ action: "finalize" });
  });
}

const installViewBoundary = () => {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method !== "PUT") {
        return panic("Unexpected view fixture request", request.url);
      }
      const body: unknown = await request.clone().json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return panic("Expected a view creation object");
      }
      return Response.json({
        ...body,
        version: 1,
        position: 0,
        createdAt: "2026-10-01T00:00:00Z",
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  return requests;
};

test("the real template picker creates its fresh view without a replay key", async () => {
  const requests = installViewBoundary();
  const created: string[] = [];
  const view = await renderProtected(
    <TemplatePickerDialog
      workspaceId={workspaceId}
      open
      disallowedLayoutTypes={new Set()}
      onOpenChange={() => undefined}
      onCreated={(id) => {
        created.push(id);
      }}
    />,
  );
  fireEvent.click(
    await waitFor(() => view.getByRole("button", { name: template.name })),
  );
  await waitFor(() => expect(created).toHaveLength(1));
  expect(requests).toHaveLength(1);
  expect(new URL(requests.at(0)?.url ?? "").pathname).toBe(
    `/v1/views/${workspaceId}`,
  );
  expect(requests.at(0)?.headers.get("Idempotency-Key")).toBeNull();
  expect(await requests.at(0)?.json()).toMatchObject({
    id: created.at(0),
    name: template.name,
    layout: tableLayout,
  });
});

test("the real view switcher creates its selected layout without a replay key", async () => {
  const requests = installViewBoundary();
  const created: string[] = [];
  const view = await renderProtected(
    <ViewSwitcher
      workspaceId={workspaceId}
      activeViewId=""
      onViewChange={(id) => {
        created.push(id);
      }}
    />,
  );
  fireEvent.click(
    await waitFor(() =>
      view.getByRole("button", { name: messages.common.add }),
    ),
  );
  fireEvent.click(
    await waitFor(() =>
      view.getByRole("menuitem", {
        name: messages.workspaces.views.layouts.table,
      }),
    ),
  );
  await waitFor(() => expect(created).toHaveLength(1));
  expect(requests).toHaveLength(1);
  expect(new URL(requests.at(0)?.url ?? "").pathname).toBe(
    `/v1/views/${workspaceId}`,
  );
  expect(requests.at(0)?.headers.get("Idempotency-Key")).toBeNull();
  expect(await requests.at(0)?.json()).toMatchObject({
    id: created.at(0),
    layout: tableLayout,
  });
});
