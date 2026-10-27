import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import type { WorkspaceActivity } from "@/components/app-sidebar.logic";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const {
  createMatterViewTestRouter,
  EXPECTED_OTHER_TREE_REVEAL,
  seedTestMatterTrees,
  TEST_FOLDER_ID,
  TEST_MATTER_ID,
  TEST_OTHER_TREE_DOCUMENT_PATH,
} = await import("@/lib/workspaces/matter-view-test-router");
// The matter's recent activity is one folder.
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(new Request(input, init).url);
      if (pathname.endsWith(`/workspaces/${TEST_MATTER_ID}/activity`)) {
        return Response.json({
          items: [
            {
              activityAt: "2026-07-01T12:00:00.000Z",
              entityKind: "folder",
              fieldId: null,
              fileName: null,
              hasThumbnail: false,
              id: TEST_FOLDER_ID,
              listItemType: null,
              mimeType: null,
              status: null,
              title: "Pleadings",
              type: "entity",
            } satisfies WorkspaceActivity,
          ],
          nextCursor: null,
        });
      }
      throw new TypeError(`Unexpected sidebar activity request: ${pathname}`);
    },
    { preconnect: () => undefined },
  ),
);
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { RouterProvider } = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { MatterActivityList } = await import("@/components/app-sidebar");

afterEach(cleanup);
afterAll(async () => {
  fetchBoundary.mockRestore();
  await unregisterDomEnvironment();
});

const RecentActivity = () => (
  <MatterActivityList
    activeOrganizationId="organization_sidebar"
    id="matter-recent"
    userId="user_sidebar"
    workspaceId={TEST_MATTER_ID}
  />
);

test("a recent folder reveals itself in the tree on screen, not the first tree", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seedTestMatterTrees(queryClient);
  const router = await createMatterViewTestRouter(
    TEST_OTHER_TREE_DOCUMENT_PATH,
    RecentActivity,
  );
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: /Pleadings/u }));

  await waitFor(() =>
    expect({
      pathname: router.state.location.pathname,
      search: router.state.location.search,
    }).toEqual(EXPECTED_OTHER_TREE_REVEAL),
  );
});
