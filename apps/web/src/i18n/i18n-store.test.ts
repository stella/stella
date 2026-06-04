import { beforeEach, expect, test } from "bun:test";

import { useI18nStore } from "@/i18n/i18n-store";
import en from "@/i18n/langs/en.json";

// Baseline: the app has already booted in English, so the boot latch is on.
const resetToBootedEnglish = (): void => {
  useI18nStore.setState({
    lang: "en",
    messages: en,
    loadedLang: "en",
    isLoaded: true,
    hasLoadedOnce: true,
  });
};

beforeEach(() => {
  resetToBootedEnglish();
});

test("switching to an unbundled language keeps the boot latch on", async () => {
  const isLoadedSeen: boolean[] = [];
  const hasLoadedOnceSeen: boolean[] = [];
  const unsubscribe = useI18nStore.subscribe((state) => {
    isLoadedSeen.push(state.isLoaded);
    hasLoadedOnceSeen.push(state.hasLoadedOnce);
  });

  await useI18nStore.getState().setLang("cs");
  unsubscribe();

  // A non-English bundle is loaded async, so isLoaded must dip false while it
  // streams in. That dip is exactly what used to unmount the app (and any
  // in-progress onboarding) via the boot spinner.
  expect(isLoadedSeen).toContain(false);

  // The boot latch must stay on through the whole switch, so the provider
  // keeps the app mounted and swaps the locale in place.
  expect(hasLoadedOnceSeen.every(Boolean)).toBe(true);

  const state = useI18nStore.getState();
  expect(state.loadedLang).toBe("cs");
  expect(state.isLoaded).toBe(true);
  expect(state.messages).not.toBe(en);
});

test("cold boot into a persisted non-English language holds the spinner", async () => {
  // Post-hydration cold boot: the persisted language is non-English, only the
  // bundled English messages are loaded, and the latch has not fired yet.
  useI18nStore.setState({
    lang: "cs",
    messages: en,
    loadedLang: "en",
    isLoaded: false,
    hasLoadedOnce: false,
  });

  const load = useI18nStore.getState().loadMessages("cs");

  // While the Czech bundle streams in the latch must stay off, so the provider
  // keeps the boot spinner up instead of flashing the English bundle first.
  expect(useI18nStore.getState().hasLoadedOnce).toBe(false);

  await load;

  const state = useI18nStore.getState();
  expect(state.hasLoadedOnce).toBe(true);
  expect(state.loadedLang).toBe("cs");
});

test("cold boot in English latches the spinner off synchronously", async () => {
  // The English bundle ships with the app, so loadMessages resolves on the sync
  // fast path and must latch before the first render (no boot spinner flash).
  useI18nStore.setState({
    lang: "en",
    messages: en,
    loadedLang: "en",
    isLoaded: true,
    hasLoadedOnce: false,
  });

  const load = useI18nStore.getState().loadMessages("en");
  expect(useI18nStore.getState().hasLoadedOnce).toBe(true);
  await load;
});

test("loadedLang and messages advance together", async () => {
  await useI18nStore.getState().setLang("cs");
  const afterCs = useI18nStore.getState();
  expect(afterCs.loadedLang).toBe("cs");
  const csMessages = afterCs.messages;

  await useI18nStore.getState().setLang("en");
  const afterEn = useI18nStore.getState();
  expect(afterEn.loadedLang).toBe("en");
  expect(afterEn.messages).not.toBe(csMessages);
  expect(afterEn.hasLoadedOnce).toBe(true);
});
