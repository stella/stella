import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { afterAll, expect, test } from "bun:test";

import { memberSessionFor } from "@/lib/account/auth-session.test-fixtures";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });

const { Suspense, use } = await import("react");
const { hydrateRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { act, waitFor, within } = await import("@testing-library/react");
const {
  Await,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { ClientDocumentPresentationBoot } =
  await import("./client-document-presentation-boot");
const { initializeRenderedLocale, loadLocaleMessages, useI18nStore } =
  await import("./i18n-store");
const { defaultPresentationPrefs } =
  await import("@/lib/account/presentation-prefs/preferences");
const { createPresentationPrefsSync } =
  await import("@/lib/account/presentation-prefs/sync");
const { initializeBrowserPresentationPrefs } =
  await import("@/lib/account/presentation-prefs/provider");
const { sessionOptions } = await import("@/lib/auth-queries");
const { useMountEffect } = await import("@/hooks/use-effect");

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("a sibling commit cannot apply the account before the root route hydrates", async () => {
  const initialI18n = useI18nStore.getState();
  const prefs = defaultPresentationPrefs;
  const visitorMessages = await loadLocaleMessages("en");
  initializeRenderedLocale({ locale: "en", messages: visitorMessages, prefs });
  let savedPrefs = prefs;
  initializeBrowserPresentationPrefs(
    prefs,
    createPresentationPrefsSync({
      initialPrefs: prefs,
      read: async () => await Promise.resolve(savedPrefs),
      write: async (patch) => {
        savedPrefs = { ...savedPrefs, ...patch };
        return await Promise.resolve(savedPrefs);
      },
    }),
  );
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    sessionOptions.queryKey,
    memberSessionFor({ userId: "hydrated-member", locale: "de" }),
  );
  const lateGate = Promise.withResolvers<undefined>();
  const lateHydrationGate: { current: Promise<undefined> | undefined } = {
    current: undefined,
  };
  let siblingCommits = 0;
  const Sibling = () => {
    useMountEffect(() => {
      siblingCommits += 1;
    });
    return <output aria-label="sibling" />;
  };
  const LateLocale = () => {
    if (lateHydrationGate.current !== undefined) {
      use(lateHydrationGate.current);
    }
    const locale = useI18nStore((state) => state.loadedLang);
    return <output aria-label="late locale">{locale}</output>;
  };
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <ClientDocumentPresentationBoot queryClient={queryClient} />
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </>
    ),
  });
  const casesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/law/cases",
    component: LateLocale,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([casesRoute]),
    history: createMemoryHistory({ initialEntries: ["/law/cases"] }),
  });
  await router.load();
  const serverTree = (
    <div>
      <Sibling />
      <Suspense fallback={null}>
        <RouterProvider router={router} />
      </Suspense>
    </div>
  );
  const container = document.createElement("div");
  // safe-html: React serializes this local route fixture without external content.
  container.innerHTML = renderToString(serverTree);
  document.body.append(container);
  const serverOutput = within(container).getByLabelText("late locale");
  expect(serverOutput.textContent).toBe("en");
  const routerGate = Promise.withResolvers<typeof router>();
  lateHydrationGate.current = lateGate.promise;
  const errors: unknown[] = [];
  const root = await act(async () =>
    hydrateRoot(
      container,
      <div>
        <Sibling />
        <Suspense fallback={null}>
          <Await promise={routerGate.promise}>
            {(readyRouter) => <RouterProvider router={readyRouter} />}
          </Await>
        </Suspense>
      </div>,
      { onRecoverableError: (error) => errors.push(error) },
    ),
  );
  try {
    expect(siblingCommits).toBe(1);
    expect(useI18nStore.getState().loadedLang).toBe("en");
    expect(serverOutput.textContent).toBe("en");

    await act(async () => {
      routerGate.resolve(router);
      await routerGate.promise;
    });
    await waitFor(() => {
      expect(useI18nStore.getState().loadedLang).toBe("de");
    });
    expect(serverOutput.isConnected).toBe(true);
    expect(serverOutput.textContent).toBe("en");

    await act(async () => {
      lateGate.resolve(undefined);
      await lateGate.promise;
    });
    expect(errors).toEqual([]);
    expect(within(container).getByLabelText("late locale").textContent).toBe(
      "de",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    queryClient.clear();
    initializeBrowserPresentationPrefs(prefs);
    await useI18nStore.getState().loadMessages(initialI18n.loadedLang);
    useI18nStore.setState(initialI18n);
  }
});
