import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withTimeout } from "@stll/concurrency/with-timeout";

import {
  loadLocaleMessages,
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

// timeout: child startup, all shipped catalogues and suspended streams share this budget.
test("suspended concurrent response streams retain request locale outside the request", async () => {
  // Plain `bun` runs the server isomorphic branch; `bun test` preloads the
  // browser branch for DOM suites in this workspace.
  const child = Bun.spawn(
    [
      "bun",
      fileURLToPath(new URL("request-i18n-stream.fixture.ts", import.meta.url)),
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [exitCode, stdout, stderr] = await withTimeout(
      async () =>
        await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
      // Includes a fresh Bun process, all shipped catalogues and suspended SSR.
      { label: "unmocked request stream fixture", timeoutMs: 10_000 },
    );
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain(`resumed ${supportedLanguages.length} locales`);
  } finally {
    child.kill();
  }
}, 12_000);
