import { createElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { defaultPresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { createPresentationPrefsSync } from "@/lib/account/presentation-prefs/sync";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { PresentationPrefsProvider } =
  await import("@/lib/account/presentation-prefs/provider");
const { usePersistedSidebarOpen } =
  await import("@/hooks/use-persisted-sidebar-open");

afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const SidebarToggle = () => {
  const { open, persistOpen, setOpen } = usePersistedSidebarOpen({
    defaultOpen: true,
    usePreference: true,
  });
  return createElement(
    "button",
    {
      "aria-label": "Toggle sidebar",
      "aria-pressed": open,
      onClick: () => {
        setOpen(!open);
        persistOpen(!open);
      },
      type: "button",
    },
    "Toggle",
  );
};

test("sidebar changes persist through the presentation owner without Cookie Store", async () => {
  const cookieStore = Object.getOwnPropertyDescriptor(
    globalThis,
    "cookieStore",
  );
  Reflect.deleteProperty(globalThis, "cookieStore");
  try {
    let stored = defaultPresentationPrefs;
    const saved = Promise.withResolvers<undefined>();
    const createSync = () =>
      createPresentationPrefsSync({
        initialPrefs: stored,
        read: async () => await Promise.resolve(stored),
        write: async (patch: Partial<PresentationPrefs>) => {
          stored = { ...stored, ...patch };
          saved.resolve(undefined);
          return stored;
        },
      });
    const view = render(
      createElement(
        PresentationPrefsProvider,
        { initialPrefs: stored, sync: createSync() },
        createElement(SidebarToggle),
      ),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Toggle sidebar" }));
      await saved.promise;
    });
    expect(stored.sidebarOpen).toBe(false);
    expect(
      view
        .getByRole("button", { name: "Toggle sidebar" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    view.unmount();
    const reloaded = render(
      createElement(
        PresentationPrefsProvider,
        { initialPrefs: stored, sync: createSync() },
        createElement(SidebarToggle),
      ),
    );
    expect(
      reloaded
        .getByRole("button", { name: "Toggle sidebar" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    reloaded.unmount();
  } finally {
    if (cookieStore === undefined) {
      Reflect.deleteProperty(globalThis, "cookieStore");
    } else {
      Object.defineProperty(globalThis, "cookieStore", cookieStore);
    }
  }
});
