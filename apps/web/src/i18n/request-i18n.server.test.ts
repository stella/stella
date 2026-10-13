import { expect, test } from "bun:test";

import {
  loadLocaleMessages,
  useI18nStore,
  supportedLanguages,
} from "@/i18n/i18n-store";
import {
  getRequestI18nStore,
  initializeRequestI18n,
  withRequestI18n,
} from "@/i18n/request-i18n.server";

test("concurrent server renders keep their locale catalogues isolated", async () => {
  const baseline = useI18nStore.getState();
  const bothInitialized = Promise.withResolvers<undefined>();
  let initialized = 0;
  const renders = supportedLanguages;
  const results = await Promise.all(
    renders.map(
      async (locale) =>
        await withRequestI18n(async () => {
          const messages = await loadLocaleMessages(locale);
          initializeRequestI18n({
            ...baseline,
            lang: locale,
            loadedLang: locale,
            messages,
            isLoaded: true,
            hasLoadedOnce: true,
          });
          initialized += 1;
          if (initialized === renders.length) {
            bothInitialized.resolve(undefined);
          }
          await bothInitialized.promise;
          const state = getRequestI18nStore()?.getInitialState();
          expect(state?.loadedLang).toBe(locale);
          expect(state?.messages).toBe(messages);
          return state?.loadedLang;
        }),
    ),
  );
  expect(results).toEqual([...renders]);
  expect(getRequestI18nStore()).toBeUndefined();
  expect(useI18nStore.getState()).toBe(baseline);
});
