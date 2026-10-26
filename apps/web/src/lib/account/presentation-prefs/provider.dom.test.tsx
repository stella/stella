import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { defaultPresentationPrefs } from "./preferences";
import type { PresentationPrefs } from "./preferences";
import { createPresentationPrefsSync } from "./sync";
import {
  createPrefsBroadcastHub,
  createPrefsWriteLock,
} from "./sync.test-fixtures";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { Suspense, startTransition, use } = await import("react");
const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { act, cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { PresentationPrefsProvider, usePresentationPrefs } =
  await import("./provider");
const { usePersistedSidebarOpen } =
  await import("@/hooks/use-persisted-sidebar-open");

afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const Controls = ({ tab }: { tab: string }) => {
  const { prefs, setPrefs } = usePresentationPrefs();
  const { open, setOpen, persistOpen } = usePersistedSidebarOpen({
    defaultOpen: true,
    usePreference: true,
  });
  return (
    <>
      <output aria-label={`${tab} theme`}>{prefs.theme}</output>
      <button
        type="button"
        aria-label={`${tab} dark`}
        onClick={() => setPrefs(() => ({ theme: "dark" }))}
      >
        {tab}
      </button>
      <button
        type="button"
        aria-label={`${tab} sidebar`}
        aria-pressed={open}
        onClick={() => {
          setOpen(!open);
          persistOpen(!open);
        }}
      >
        {tab}
      </button>
    </>
  );
};

test("mounted tabs receive saved themes and sidebar changes even after a local toggle", async () => {
  const hub = createPrefsBroadcastHub();
  const withLock = createPrefsWriteLock();
  let cookie = defaultPresentationPrefs;
  const write = async (patch: Partial<PresentationPrefs>) => {
    cookie = { ...cookie, ...patch };
    return cookie;
  };
  const createTab = () =>
    createPresentationPrefsSync({
      initialPrefs: cookie,
      read: async () => await Promise.resolve(cookie),
      write,
      withLock,
      openChannel: hub.open,
    });
  const first = createTab();
  const second = createTab();
  const view = render(
    <>
      <PresentationPrefsProvider initialPrefs={cookie} sync={first}>
        <Controls tab="A" />
      </PresentationPrefsProvider>
      <PresentationPrefsProvider initialPrefs={cookie} sync={second}>
        <Controls tab="B" />
      </PresentationPrefsProvider>
    </>,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "A dark" }));
  });
  expect(view.getByLabelText("B theme").textContent).toBe("dark");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "B sidebar" }));
  });
  expect(
    view
      .getByRole("button", { name: "A sidebar" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "A sidebar" }));
  });
  expect(
    view
      .getByRole("button", { name: "B sidebar" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  view.unmount();
  expect(hub.connected()).toBe(0);
});

test("a deserialized store and peer updates preserve a boundary still hydrating", async () => {
  const hub = createPrefsBroadcastHub();
  const initialPrefs = { ...defaultPresentationPrefs, theme: "light" as const };
  const options = {
    initialPrefs: { ...initialPrefs },
    read: async () => await Promise.resolve(initialPrefs),
    write: async (patch: Partial<PresentationPrefs>) =>
      await Promise.resolve({ ...initialPrefs, ...patch }),
    openChannel: hub.open,
  };
  const sync = createPresentationPrefsSync(options);
  const peer = createPresentationPrefsSync(options);
  const gate = Promise.withResolvers<undefined>();
  const Reader = ({
    hydrationGate,
  }: {
    hydrationGate?: Promise<undefined>;
  }) => {
    if (hydrationGate !== undefined) {
      use(hydrationGate);
    }
    return <Controls tab="reader" />;
  };
  const tree = (
    hydrationGate?: Promise<undefined>,
    incomingPrefs = initialPrefs,
  ) => (
    <PresentationPrefsProvider initialPrefs={incomingPrefs} sync={sync}>
      <Suspense fallback={null}>
        {hydrationGate === undefined ? (
          <Reader />
        ) : (
          <Reader hydrationGate={hydrationGate} />
        )}
      </Suspense>
    </PresentationPrefsProvider>
  );
  const container = document.createElement("div");
  // safe-html: React serializes the local Reader fixture, without external HTML.
  container.innerHTML = renderToString(tree());
  document.body.append(container);
  expect(hub.connected()).toBe(0);
  const serverButton = within(container).getByRole("button", {
    name: "reader dark",
  });
  serverButton.focus();
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
      await peer.update(() => ({ theme: "dark" }));
    });
    // Route-context refresh can replace the prop while this boundary still
    // has the original server HTML to hydrate.
    await act(async () => {
      startTransition(() => {
        root.render(tree(gate.promise, { ...initialPrefs, theme: "dark" }));
      });
    });
    expect(serverButton.isConnected).toBe(true);
    expect(document.activeElement === serverButton).toBe(true);
    await act(async () => {
      gate.resolve(undefined);
      await gate.promise;
    });
    expect(errors).toEqual([]);
    expect(within(container).getByLabelText("reader theme").textContent).toBe(
      "dark",
    );
    expect(
      within(container).getByRole("button", { name: "reader dark" }) ===
        serverButton,
    ).toBe(true);
  } finally {
    gate.resolve(undefined);
    await act(async () => root.unmount());
    container.remove();
  }
  expect(hub.connected()).toBe(0);
});
