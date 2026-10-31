import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { afterAll, expect, test } from "bun:test";

import { memberSessionFor } from "@/lib/account/auth-session.test-fixtures";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act, cleanup, render } = await import("@testing-library/react");
const { defaultPresentationPrefs } =
  await import("@/lib/account/presentation-prefs/preferences");
const { createPresentationPrefsSync } =
  await import("@/lib/account/presentation-prefs/sync");
const {
  initializeBrowserPresentationPrefs,
  PresentationPrefsProvider,
  usePresentationPrefs,
} = await import("@/lib/account/presentation-prefs/provider");
const { loadClientDocumentPresentation } =
  await import("./document-presentation");
const { useI18nStore } = await import("./i18n-store");
const { seedLegacyBrowserStorage } =
  await import("@/lib/account/browser-storage.test-fixtures");
const { legacyBrowserStorage } = await import("@/lib/account/browser-storage");
const { sessionOptions } = await import("@/lib/auth-queries");

const createTestPrefsSync = () => {
  let savedPrefs = defaultPresentationPrefs;
  return createPresentationPrefsSync({
    initialPrefs: defaultPresentationPrefs,
    read: async () => await Promise.resolve(savedPrefs),
    write: async (patch) => {
      savedPrefs = { ...savedPrefs, ...patch };
      return await Promise.resolve(savedPrefs);
    },
  });
};

test("account changes replace the catalogue before navigation completes without a document reload", async () => {
  const initialI18n = useI18nStore.getState();
  initializeBrowserPresentationPrefs(
    defaultPresentationPrefs,
    createTestPrefsSync(),
  );
  const queryClient = new QueryClient();
  try {
    for (const user of [
      { id: "first", locale: "cs", navigation: "Právní databáze" },
      { id: "second", locale: "de", navigation: "Rechtsdatenbank" },
      { id: "first", locale: "cs", navigation: "Právní databáze" },
    ] as const) {
      queryClient.setQueryData(
        sessionOptions.queryKey,
        memberSessionFor({ userId: user.id, locale: user.locale }),
      );
      await loadClientDocumentPresentation(queryClient);
      expect(useI18nStore.getState().loadedLang).toBe(user.locale);
      expect(useI18nStore.getState().messages.common.legalDatabase).toBe(
        user.navigation,
      );
    }
  } finally {
    initializeBrowserPresentationPrefs(defaultPresentationPrefs);
    queryClient.clear();
    await useI18nStore.getState().loadMessages(initialI18n.loadedLang);
    useI18nStore.setState(initialI18n);
  }
});

test("navigation by the same account retains a freshly selected catalogue despite a cached profile", async () => {
  const initialI18n = useI18nStore.getState();
  initializeBrowserPresentationPrefs(
    defaultPresentationPrefs,
    createTestPrefsSync(),
  );
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    sessionOptions.queryKey,
    memberSessionFor({ userId: "same", locale: "en" }),
  );
  try {
    await loadClientDocumentPresentation(queryClient);
    await useI18nStore.getState().loadMessages("cs");
    await loadClientDocumentPresentation(queryClient);
    expect(useI18nStore.getState().loadedLang).toBe("cs");
  } finally {
    initializeBrowserPresentationPrefs(defaultPresentationPrefs);
    queryClient.clear();
    await useI18nStore.getState().loadMessages(initialI18n.loadedLang);
    useI18nStore.setState(initialI18n);
  }
});

afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const MountedPrefs = () => {
  const { prefs } = usePresentationPrefs();
  return (
    <>
      <output aria-label="mounted theme">{prefs.theme}</output>
      <output aria-label="mounted locale">{prefs.visitorLocale}</output>
    </>
  );
};

test("document migration updates an already mounted preference provider", async () => {
  const key = "stella-ui-theme";
  const initialI18n = useI18nStore.getState();
  let savedPrefs = defaultPresentationPrefs;
  const sync = createPresentationPrefsSync({
    initialPrefs: defaultPresentationPrefs,
    read: async () => await Promise.resolve(savedPrefs),
    write: async (patch) => {
      savedPrefs = { ...savedPrefs, ...patch };
      return await Promise.resolve(savedPrefs);
    },
  });
  initializeBrowserPresentationPrefs(defaultPresentationPrefs, sync);
  seedLegacyBrowserStorage(key, "dark");
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    sessionOptions.queryKey,
    memberSessionFor({
      userId: "mounted-member",
      locale: "de",
      sessionId: "mounted-session",
    }),
  );
  const view = render(
    <PresentationPrefsProvider initialPrefs={defaultPresentationPrefs}>
      <MountedPrefs />
    </PresentationPrefsProvider>,
  );
  try {
    expect(view.getByLabelText("mounted theme").textContent).toBe("system");
    expect(view.getByLabelText("mounted locale").textContent).toBe("en");
    await act(async () => {
      await loadClientDocumentPresentation(queryClient);
    });
    expect(view.getByLabelText("mounted theme").textContent).toBe("dark");
    expect(view.getByLabelText("mounted locale").textContent).toBe("de");
    expect(savedPrefs.theme).toBe("dark");
    expect(savedPrefs.visitorLocale).toBe("de");
    expect(useI18nStore.getState().loadedLang).toBe("de");
    expect(legacyBrowserStorage.getItem(key).unwrap()).toBeNull();
  } finally {
    view.unmount();
    initializeBrowserPresentationPrefs(defaultPresentationPrefs);
    legacyBrowserStorage.removeItem(key);
    queryClient.clear();
    await useI18nStore.getState().loadMessages(initialI18n.loadedLang);
    useI18nStore.setState(initialI18n);
  }
});
