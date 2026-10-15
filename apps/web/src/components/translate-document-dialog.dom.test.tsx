import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/document" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { useState } = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;
const { TranslateDocumentDialog } = await import("./translate-document-dialog");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { deepLAvailabilityOptions } = await import("@/lib/deepl/queries");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

for (const controlled of [true, false]) {
  const mode = controlled ? "controlled" : "trigger";
  for (const isDocx of [true, false]) {
    test(`${mode} translation dialog reads on open and caches across remount (DOCX=${isDocx})`, async () => {
      const response = Promise.withResolvers<Response>();
      let calls = 0;
      let aborts = 0;
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          const pathname = new URL(request.url).pathname;
          if (pathname.endsWith("/organization-settings/deepl")) {
            expect(request.method).toBe("GET");
            calls += 1;
            request.signal.addEventListener("abort", () => {
              aborts += 1;
            });
            return response.promise;
          }
          if (pathname.endsWith("/document-translations/prepare")) {
            return Response.json({
              entityVersionId: "version",
              hasComments: false,
            });
          }
          if (pathname.startsWith("/api/auth/")) {
            return Response.json(null);
          }
          throw new TypeError(`Unexpected transport: ${pathname}`);
        },
        { preconnect: () => undefined },
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      clients.push(client);
      const Page = () => {
        const [open, setOpen] = useState(false);
        const [mount, setMount] = useState(0);
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>
              {messages.common.open}
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              {messages.common.close}
            </button>
            <button
              type="button"
              onClick={() => setMount((value) => value + 1)}
            >
              {messages.common.refresh}
            </button>
            {mode === "controlled" ? (
              <TranslateDocumentDialog
                key={mount}
                workspaceId="matter"
                viewId="view"
                entityId="entity"
                fieldId="field"
                entityVersionKey="version"
                isDocx={isDocx}
                mode="controlled"
                open={open}
                onOpenChange={setOpen}
              />
            ) : (
              <TranslateDocumentDialog
                key={mount}
                workspaceId="matter"
                viewId="view"
                entityId="entity"
                fieldId="field"
                entityVersionKey="version"
                isDocx={isDocx}
              />
            )}
          </>
        );
      };
      const root = router.createRootRoute({ component: router.Outlet });
      const protectedRoute = router.createRoute({
        getParentRoute: () => root,
        id: "_protected",
        beforeLoad: () => ({
          user: { activeOrganizationId: "organization-a" },
        }),
        component: router.Outlet,
      });
      const route = router.createRoute({
        getParentRoute: () => protectedRoute,
        path: "/document",
        component: Page,
      });
      const appRouter = router.createRouter({
        history: router.createMemoryHistory({ initialEntries: ["/document"] }),
        routeTree: root.addChildren([protectedRoute.addChildren([route])]),
        isServer: false,
      });
      await appRouter.load();
      const view = render(
        <QueryClientProvider client={client}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <ActionCapabilitiesProvider
              value={resolveActionCapabilities({
                role: "member",
                ai: true,
                deepl: true,
                ocr: true,
                desktop: "current",
                settings: undefined,
              })}
            >
              <FormattingProvider locale="en" timeZone="UTC">
                <router.RouterProvider router={appRouter} />
              </FormattingProvider>
            </ActionCapabilitiesProvider>
          </IntlProvider>
        </QueryClientProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(calls).toBe(0);
      fireEvent.click(
        mode === "controlled"
          ? view.getByText(messages.common.open)
          : view.getByLabelText(messages.common.translate),
      );
      await waitFor(() => {
        expect(calls).toBe(1);
      });
      fireEvent.click(
        mode === "controlled"
          ? view.getByText(messages.common.close, {
              selector: "button:not([data-slot])",
            })
          : view.getByText(messages.common.close, {
              selector: "button[data-slot=dialog-close]",
            }),
      );
      fireEvent.click(view.getByText(messages.common.refresh));
      fireEvent.click(
        mode === "controlled"
          ? view.getByText(messages.common.open)
          : view.getByLabelText(messages.common.translate),
      );
      await act(async () => {
        response.resolve(Response.json({ configured: true }));
      });
      await waitFor(() => {
        const availability = client.getQueryData(
          deepLAvailabilityOptions({
            organizationId: "organization-a",
            open: true,
          }).queryKey,
        );
        expect(availability).toEqual({ configured: true });
      });
      expect(aborts).toBe(0);
      expect(calls).toBe(1);
      fireEvent.click(
        mode === "controlled"
          ? view.getByText(messages.common.close, {
              selector: "button:not([data-slot])",
            })
          : view.getByText(messages.common.close, {
              selector: "button[data-slot=dialog-close]",
            }),
      );
      fireEvent.click(view.getByText(messages.common.refresh));
      fireEvent.click(
        mode === "controlled"
          ? view.getByText(messages.common.open)
          : view.getByLabelText(messages.common.translate),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(calls).toBe(1);
    });
  }
}
