import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });

const { Suspense, use, useState } = await import("react");
const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { act, render, within } = await import("@testing-library/react");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { useTranslations } = await import("use-intl");
const { useLocale } = await import("./formatting-context");
const {
  applyClientDocumentLocale,
  initializeRenderedLocale,
  loadLocaleMessages,
  useI18nStore,
} = await import("./i18n-store");
const { defaultPresentationPrefs, parseVisitorPresentationPrefs } =
  await import("@/lib/account/presentation-prefs/preferences");
const { createPresentationPrefsSync } =
  await import("@/lib/account/presentation-prefs/sync");
const { createPrefsBroadcastHub, createPrefsWriteLock } =
  await import("@/lib/account/presentation-prefs/sync.test-fixtures");
const { PresentationPrefsProvider, usePresentationPrefs } =
  await import("@/lib/account/presentation-prefs/provider");
const { I18nProvider } = await import("./provider");

const { withRequestI18n } = await import("./request-i18n.server");

afterAll(unregisterDomEnvironment);

test("a late boundary hydrates the visitor snapshot before showing the live account locale", async () => {
  const prefs = defaultPresentationPrefs;
  const visitorMessages = await loadLocaleMessages("en");
  initializeRenderedLocale({ locale: "en", messages: visitorMessages, prefs });
  const gate = Promise.withResolvers<undefined>();
  const Language = ({
    hydrationGate,
  }: {
    hydrationGate?: Promise<undefined>;
  }) => {
    if (hydrationGate !== undefined) {
      use(hydrationGate);
    }
    const locale = useI18nStore((state) => state.loadedLang);
    return <output aria-label="late locale">{locale}</output>;
  };
  const tree = (hydrationGate?: Promise<undefined>) => (
    <Suspense fallback={null}>
      <Language hydrationGate={hydrationGate} />
    </Suspense>
  );
  const container = document.createElement("div");
  // safe-html: React serializes the local Language fixture without external content.
  container.innerHTML = renderToString(tree());
  document.body.append(container);
  const serverOutput = within(container).getByLabelText("late locale");
  expect(serverOutput.textContent).toBe("en");
  const errors: unknown[] = [];
  const root = await act(async () =>
    hydrateRoot(container, tree(gate.promise), {
      onRecoverableError: (error) => {
        errors.push(error);
      },
    }),
  );
  try {
    await act(async () => {
      applyClientDocumentLocale({
        locale: "de",
        messages: await loadLocaleMessages("de"),
        prefs,
      });
    });
    expect(serverOutput.textContent).toBe("en");
    await act(async () => {
      gate.resolve(undefined);
      await gate.promise;
    });
    expect(errors).toEqual([]);
    expect(serverOutput.isConnected).toBe(true);
    expect(within(container).getByLabelText("late locale").textContent).toBe(
      "de",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    initializeRenderedLocale({
      locale: "en",
      messages: visitorMessages,
      prefs,
    });
  }
});

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
          onRecoverableError: (error) => {
            hydrationErrors.push(error);
          },
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

test("formatting preferences propagate only through the peer channel", async () => {
  const hub = createPrefsBroadcastHub();
  const withLock = createPrefsWriteLock();
  let saved = defaultPresentationPrefs;
  const messages = await loadLocaleMessages("en");
  initializeRenderedLocale({ locale: "en", messages, prefs: saved });
  const createTab = () =>
    createPresentationPrefsSync({
      initialPrefs: saved,
      read: async () => await Promise.resolve(saved),
      write: async (patch) => {
        saved = { ...saved, ...patch };
        return saved;
      },
      withLock,
      openChannel: hub.open,
    });
  const FormattingControls = ({ tab }: { tab: string }) => {
    const locale = useLocale();
    const { setPrefs } = usePresentationPrefs();
    return (
      <>
        <output aria-label={`${tab} locale`}>{locale}</output>
        <button
          type="button"
          aria-label={`${tab} Arabic numerals`}
          onClick={() => setPrefs(() => ({ numberingSystem: "arab" }))}
        >
          {tab}
        </button>
      </>
    );
  };
  const Tab = ({ tab }: { tab: string }) => (
    <PresentationPrefsProvider initialPrefs={saved} sync={createTab()}>
      <I18nProvider>
        <FormattingControls tab={tab} />
      </I18nProvider>
    </PresentationPrefsProvider>
  );
  const view = render(
    <>
      <Tab tab="A" />
      <Tab tab="B" />
    </>,
  );
  try {
    hub.setDeliveryEnabled(false);
    await act(async () => {
      view.getByRole("button", { name: "A Arabic numerals" }).click();
    });
    expect(view.getByLabelText("A locale").textContent).toContain("nu-arab");
    expect(view.getByLabelText("B locale").textContent).not.toContain(
      "nu-arab",
    );
    hub.setDeliveryEnabled(true);
    await act(async () => {
      view.getByRole("button", { name: "A Arabic numerals" }).click();
    });
    expect(view.getByLabelText("B locale").textContent).toContain("nu-arab");
  } finally {
    await act(async () => view.unmount());
  }
  expect(hub.connected()).toBe(0);
});
