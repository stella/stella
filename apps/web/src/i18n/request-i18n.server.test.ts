import { createElement, Suspense, use } from "react";
import { renderToReadableStream } from "react-dom/server";

import { expect, test } from "bun:test";

import {
  loadLocaleMessages,
  RenderedI18nStoreProvider,
  supportedLanguages,
  useI18nStore,
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

test("suspended concurrent response streams retain their request locale when resumed outside the request", async () => {
  const baseline = useI18nStore.getState();
  const release = Promise.withResolvers<undefined>();
  const LocaleSnapshot = ({ suspended }: { suspended: boolean }) => {
    if (suspended) {
      use(release.promise);
    }
    const { loadedLang, messages } = useI18nStore((state) => state);
    return createElement(
      "span",
      { "data-locale": loadedLang },
      messages.common.legalDatabase,
    );
  };
  const streams = await Promise.all(
    supportedLanguages.map(async (locale) => {
      const messages = await loadLocaleMessages(locale);
      const stream = await withRequestI18n(async () => {
        initializeRequestI18n({
          ...baseline,
          lang: locale,
          loadedLang: locale,
          messages,
          isLoaded: true,
          hasLoadedOnce: true,
        });
        return await renderToReadableStream(
          createElement(
            RenderedI18nStoreProvider,
            null,
            createElement(
              "html",
              null,
              createElement("head"),
              createElement(
                "body",
                null,
                createElement(
                  Suspense,
                  {
                    fallback: createElement(LocaleSnapshot, {
                      suspended: false,
                    }),
                  },
                  createElement(LocaleSnapshot, { suspended: true }),
                ),
              ),
            ),
          ),
          { bootstrapScripts: ["/fixture.js"] },
        );
      });
      const reader = stream.getReader();
      const shell = await reader.read();
      expect(shell.done).toBe(false);
      return { locale, messages, stream, reader, shell };
    }),
  );
  expect(getRequestI18nStore()).toBeUndefined();
  release.resolve(undefined);
  await Promise.all(
    streams.map(async ({ locale, messages, stream, reader, shell }) => {
      await stream.allReady;
      const decoder = new TextDecoder();
      const chunks = [decoder.decode(shell.value, { stream: true })];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          chunks.push(decoder.decode());
          break;
        }
        chunks.push(decoder.decode(chunk.value, { stream: true }));
      }
      const html = chunks.join("");
      expect(
        html.match(new RegExp(`data-locale="${locale}"`, "gu")),
      ).toHaveLength(2);
      expect(html).toContain(messages.common.legalDatabase);
    }),
  );
  expect(useI18nStore.getState()).toBe(baseline);
});
