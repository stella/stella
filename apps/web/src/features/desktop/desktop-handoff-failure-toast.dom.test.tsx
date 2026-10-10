import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { DESKTOP_HANDOFF_FAILURE } from "@stll/api-contract/desktop-handoff";
import { Temporal } from "@stll/time";

GlobalRegistrator.register();
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async () =>
      new Response("{}", { headers: { "Content-Type": "application/json" } }),
    { preconnect: globalThis.fetch.preconnect },
  ),
);
const { act, cleanup, render, renderHook } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { useDesktopPdfSign } =
  await import("@/components/inspector/use-desktop-pdf-sign");
const { IntlProvider } = await import("use-intl");
const { stellaToast, ToastProvider } = await import("@stll/ui/toast");
const { showDesktopEditOpenResultToast } =
  await import("@/lib/desktop-edit-status-toast");
const { watchDesktopEditHandoff } = await import("./desktop-edit-handoff");
const { readQueryResult } = await import("@/lib/errors/query-result");
const { WINDOWS_EXE_URL } = await import("@/lib/desktop-downloads");
const en = (await import("@/i18n/langs/en.json")).default;
const ar = (await import("@/i18n/langs/ar.json")).default;

afterEach(async () => {
  await act(async () => {
    stellaToast.close();
  });
  cleanup();
});
afterAll(async () => {
  fetchBoundary.mockRestore();
  await GlobalRegistrator.unregister();
});

for (const { locale, messages } of [
  { locale: "en", messages: en },
  { locale: "ar", messages: ar },
]) {
  for (const failureReason of Object.values(DESKTOP_HANDOFF_FAILURE)) {
    test(`${locale}: ${failureReason} replaces the waiting toast on the first status read`, async () => {
      const ui = render(
        <IntlProvider locale={locale} messages={messages}>
          <ToastProvider />
        </IntlProvider>,
      );
      const copy = messages.workspaces.files.desktopEdit;
      let reads = 0;
      await act(async () => {
        await showDesktopEditOpenResultToast({
          messages: {
            accountRequiredTitle: copy.accountRequiredTitle,
            updateRequiredTitle: copy.updateRequiredTitle,
            updateRequiredDescription: copy.updateRequiredDescription,
            notOpenedDescription: copy.notOpenedDescription,
            openedDescription: copy.openedDescription,
            openedTitle: copy.openedTitle,
            sentDescription: copy.sentDescription,
            sentTitle: copy.sentTitle,
            unavailableTitle: copy.unavailableTitle,
          },
          result: {
            type: "handoff-pending",
            waitUntilOpened: watchDesktopEditHandoff({
              expiresAt: Temporal.Now.instant().add({ minutes: 2 }).toString(),
              readStatus: async () => {
                reads += 1;
                return {
                  status: "failed",
                  failureReason,
                  failedAt: Temporal.Now.instant().toString(),
                };
              },
            }).then((result) => {
              readQueryResult(result);
              return undefined;
            }),
          },
        });
      });
      expect(reads).toBe(1);
      expect(ui.queryByText(copy.sentTitle)).toBeNull();
      expect(ui.queryByText(copy.unavailableTitle)).toBeNull();
      if (failureReason === DESKTOP_HANDOFF_FAILURE.updateRequired) {
        expect(
          ui.getAllByText(copy.updateRequiredTitle).length,
        ).toBeGreaterThan(0);
        const urls = ui
          .getAllByRole("link")
          .map((link) => link.getAttribute("href"));
        expect(urls).toContain(WINDOWS_EXE_URL);
      } else {
        expect(ui.getByText(copy.accountRequiredTitle)).toBeDefined();
        expect(ui.queryAllByRole("link")).toHaveLength(0);
      }
    });
  }
}

for (const failureReason of Object.values(DESKTOP_HANDOFF_FAILURE)) {
  test(`PDF signing: ${failureReason} replaces the waiting toast after one session read`, async () => {
    let reads = 0;
    const expiresAt = Temporal.Now.instant().add({ minutes: 2 }).toString();
    fetchBoundary.mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = input instanceof Request ? input.url : String(input);
          let payload: unknown = {};
          if (url.includes("pdf-signing-handoffs")) {
            payload = {
              deepLinkUrl: "stella://pdf-signing",
              expiresAt,
              sessionId: "90123344-5566-7788-9900-aabbccddeeff",
            };
          }
          if (url.includes("pdf-signing-sessions")) {
            reads += 1;
            payload = {
              status: "cancelled",
              closeReason: failureReason,
              expiresAt,
              finalizedVersionNumber: null,
            };
          }
          return new Response(JSON.stringify(payload), {
            headers: { "Content-Type": "application/json" },
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = renderHook(
      () => useDesktopPdfSign({ connectDesktop: () => undefined }),
      {
        wrapper: ({ children }) => (
          <IntlProvider locale="en" messages={en}>
            <QueryClientProvider client={client}>
              <ToastProvider>{children}</ToastProvider>
            </QueryClientProvider>
          </IntlProvider>
        ),
      },
    );
    await act(async () => {
      await ui.result.current.sign({
        target: {
          entityId: "90123344-5566-7788-9900-aabbccddeeff",
          propertyId: "90123344-5566-7788-9900-aabbccddeeff",
          workspaceId: "90123344-5566-7788-9900-aabbccddeeff",
        },
      });
    });
    expect(reads).toBe(1);
    expect(ui.result.current.isSigning).toBe(false);
    const title =
      failureReason === DESKTOP_HANDOFF_FAILURE.updateRequired
        ? en.workspaces.files.desktopEdit.updateRequiredTitle
        : en.workspaces.files.desktopEdit.accountRequiredTitle;
    expect(document.body.textContent).toContain(title);
    expect(document.body.textContent).not.toContain(
      en.workspaces.files.pdfSigning.cancelledTitle,
    );
    expect(document.body.textContent).not.toContain(
      en.workspaces.files.pdfSigning.expiredTitle,
    );
    client.clear();
  });
}
