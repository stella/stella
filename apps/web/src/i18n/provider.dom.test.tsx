import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });

const { useState } = await import("react");
const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { act, within } = await import("@testing-library/react");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { useTranslations } = await import("use-intl");
const { initializeRenderedLocale, loadLocaleMessages } =
  await import("./i18n-store");
const { parseVisitorPresentationPrefs } =
  await import("@/lib/account/presentation-prefs/preferences");
const { I18nProvider } = await import("./provider");

const { withRequestI18n } = await import("./request-i18n.server");

afterAll(unregisterDomEnvironment);

test.each(["ar-SA", "ar-AE"])(
  "%s keeps focused controls mounted through hydration",
  async (locale) =>
    await withRequestI18n(async () => {
      const prefs = parseVisitorPresentationPrefs(undefined, locale);
      const messages = await loadLocaleMessages("ar");
      initializeRenderedLocale({ locale: "ar", messages, prefs });
      const Filters = () => {
        const t = useTranslations();
        const [open, setOpen] = useState(false);
        return (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {t("common.filters")}
          </button>
        );
      };
      const rootRoute = createRootRoute({
        component: () => (
          <I18nProvider>
            <Outlet />
          </I18nProvider>
        ),
      });
      const route = createRoute({
        getParentRoute: () => rootRoute,
        path: "/law/cases",
        component: Filters,
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([route]),
        history: createMemoryHistory({ initialEntries: ["/law/cases"] }),
      });
      await router.load();
      const container = document.createElement("div");
      // safe-html: React renderToString serializes the local Filters fixture, with no external HTML.
      container.innerHTML = renderToString(<RouterProvider router={router} />);
      document.body.append(container);
      const serverButton = within(container).getByRole("button", {
        name: messages.common.filters,
      });
      serverButton.focus();
      const hydrationErrors: unknown[] = [];
      const root = await act(async () =>
        hydrateRoot(container, <RouterProvider router={router} />, {
          onRecoverableError: (error) => hydrationErrors.push(error),
        }),
      );
      try {
        expect(serverButton.isConnected).toBe(true);
        expect(document.activeElement === serverButton).toBe(true);
        await act(async () => serverButton.click());
        expect(hydrationErrors).toEqual([]);
        expect(
          within(container)
            .getByRole("button", { name: messages.common.filters })
            .getAttribute("aria-expanded"),
        ).toBe("true");
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }),
);
