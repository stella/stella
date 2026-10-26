import { createElement, Suspense, use } from "react";
import { renderToReadableStream } from "react-dom/server";

import assert from "node:assert/strict";

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
                  fallback: createElement(LocaleSnapshot, { suspended: false }),
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
    assert.equal(shell.done, false);
    return { locale, messages, stream, reader, shell };
  }),
);
assert.equal(getRequestI18nStore(), undefined);
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
    assert.equal(
      html.match(new RegExp(`data-locale="${locale}"`, "gu"))?.length,
      2,
    );
    assert.ok(html.includes(messages.common.legalDatabase));
  }),
);
assert.equal(useI18nStore.getState(), baseline);
process.stdout.write(`resumed ${supportedLanguages.length} locales\n`);
