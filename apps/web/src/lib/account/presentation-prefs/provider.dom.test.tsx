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
const { act, cleanup, fireEvent, render } =
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
        onClick={() => setPrefs({ theme: "dark" })}
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
