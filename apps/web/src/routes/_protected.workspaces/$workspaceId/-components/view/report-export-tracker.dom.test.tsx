import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, spyOn, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/exports" });
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { act } = await import("react");
const { IntlProvider } = await import("use-intl");
const { QueryClient, QueryClientProvider, onlineManager } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { stellaToast } = await import("@stll/ui/toast");
const { reportExportDetailOptions } =
  await import("@/lib/workspaces/queries/report-exports");
const { ReportExportTracker } = await import("./report-export-tracker");
const { useReportExportTrackingStore } =
  await import("./report-export-tracking");

afterAll(async () => {
  cleanup();
  await act(async () => {
    await sleep(50);
  });
  await unregisterDomEnvironment();
});

test("failed exports preserve worker reasons when adding or settling their toast", async () => {
  const wasOnline = onlineManager.isOnline();
  onlineManager.setOnline(false);
  const add = spyOn(stellaToast, "add");
  const update = spyOn(stellaToast, "update");
  try {
    for (const error of [
      "Unsupported view type for report export",
      "AI usage is unavailable for this report",
      "Missing template values: reporting period",
      null,
    ]) {
      for (const toastId of [undefined, "pending-export-toast"]) {
        add.mockClear();
        update.mockClear();
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        const key = {
          exportId: "export-example",
          workspaceId: "workspace-example",
          userId: "user-example",
        };
        queryClient.setQueryData(reportExportDetailOptions(key).queryKey, {
          status: "failed",
          error,
          resultEntityId: null,
          resultFieldId: null,
          downloadUrl: null,
        });
        useReportExportTrackingStore.setState({
          exports: {
            [key.exportId]: {
              exportId: key.exportId,
              workspaceId: key.workspaceId,
              requestedBy: key.userId,
              trackedAt: 1,
              mode: "download",
            },
          },
          toastIds: toastId === undefined ? {} : { [key.exportId]: toastId },
        });
        const root = router.createRootRoute({ component: router.Outlet });
        const protectedRoute = router.createRoute({
          getParentRoute: () => root,
          id: "_protected",
          beforeLoad: () => ({ user: { id: key.userId } }),
        });
        const page = router.createRoute({
          getParentRoute: () => protectedRoute,
          path: "/exports",
          component: () => (
            <ReportExportTracker workspaceId={key.workspaceId} />
          ),
        });
        const appRouter = router.createRouter({
          routeTree: root.addChildren([protectedRoute.addChildren([page])]),
          history: router.createMemoryHistory({ initialEntries: ["/exports"] }),
          isServer: false,
        });
        await appRouter.load();
        const view = render(
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <QueryClientProvider client={queryClient}>
              <router.RouterProvider router={appRouter} />
            </QueryClientProvider>
          </IntlProvider>,
        );
        try {
          const expected = {
            type: "error",
            title: messages.workspaces.views.reportExport.failed,
            description: error ?? messages.common.unexpectedError,
          };
          await waitFor(() => {
            if (toastId === undefined) {
              expect(add).toHaveBeenCalledWith(expected);
              expect(update).not.toHaveBeenCalled();
            } else {
              expect(update).toHaveBeenCalledWith(toastId, expected);
              expect(add).not.toHaveBeenCalled();
            }
          });
          expect(useReportExportTrackingStore.getState().exports).toEqual({});
          expect(useReportExportTrackingStore.getState().toastIds).toEqual({});
        } finally {
          view.unmount();
          queryClient.clear();
        }
      }
    }
  } finally {
    cleanup();
    useReportExportTrackingStore.setState({ exports: {}, toastIds: {} });
    add.mockRestore();
    update.mockRestore();
    onlineManager.setOnline(wasOnline);
  }
});
