import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import englishMessages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import type { MatterActivityItem } from "@/lib/workspaces/queries";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ActivityDetailsSheet, ActivityWorkspaceContext } =
  await import("./activity-panel");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const WORKSPACE_ID = "workspace-1";
const EVENT_ID = "019df73f-0000-7000-8000-000000000001";
const OTHER_EVENT_ID = "019df73f-0000-7000-8000-000000000002";

const createItem = (id: string): MatterActivityItem => ({
  action: "create",
  activityAt: "2026-05-05T08:26:58.000Z",
  approval: { status: "not_required", user: null },
  category: "documents",
  id: toSafeId<"auditLog">(id),
  performer: { name: "Jane Doe", type: "user" },
  renameOnly: false,
  runId: null,
  target: {
    color: null,
    deleted: false,
    encrypted: false,
    entityId: "entity-1",
    fieldId: "field-1",
    hasThumbnail: false,
    id: "entity-1",
    kind: "document",
    mimeType: "application/pdf",
    name: "Agreement.pdf",
    pdfFileId: null,
    placeholder: null,
    propertyId: "property-1",
  },
  trigger: { source: "chat", type: "direct", user: null },
});

type SheetGroup = Parameters<typeof ActivityDetailsSheet>[0]["group"];

// The sheet's "Open" action navigates, so it renders under a router.
const renderSheet = async (group: SheetGroup) => {
  const rootRoute = router.createRootRoute({
    component: () => (
      <ActivityWorkspaceContext value={WORKSPACE_ID}>
        <ActivityDetailsSheet
          group={group}
          onOpenChange={() => {}}
          workspaceId={WORKSPACE_ID}
        />
      </ActivityWorkspaceContext>
    ),
  });
  const appRouter = router.createRouter({
    routeTree: rootRoute,
    history: router.createMemoryHistory({
      initialEntries: [`/workspaces/${WORKSPACE_ID}`],
    }),
    isServer: false,
  });
  await appRouter.load();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <router.RouterProvider router={appRouter} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await screen.findByText(
    englishMessages.workspaces.overview.activity.details.title,
  );
};

test("shows the date and time but never the raw event id", async () => {
  await renderSheet({
    id: "group-1",
    items: [createItem(EVENT_ID)],
    type: "single",
  });
  const body = document.body.textContent;
  expect(body).toContain("Date and time");
  expect(body).not.toContain("Event ID");
  expect(body).not.toContain(EVENT_ID);
});

test("a document batch lists each document without its event id", async () => {
  await renderSheet({
    id: "group-2",
    items: [createItem(EVENT_ID), createItem(OTHER_EVENT_ID)],
    type: "document_batch",
  });
  const body = document.body.textContent;
  expect(body).toContain("Date and time");
  expect(body).not.toContain("Event ID");
  expect(body).not.toContain(EVENT_ID);
  expect(body).not.toContain(OTHER_EVENT_ID);
});
