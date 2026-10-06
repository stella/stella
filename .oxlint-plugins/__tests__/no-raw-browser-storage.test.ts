import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { STORAGE_OWNERS } from "../no-raw-browser-storage.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(30_000);

const lint = async (
  source: string,
  sourcePath = "apps/web/src/lib/storage-consumer.ts",
) => await lintSingleRule("no-raw-browser-storage", source, { sourcePath });

const rawReferences = [
  'localStorage.getItem("key");',
  "void window.sessionStorage;",
  "void globalThis.localStorage;",
  "const { localStorage } = window;",
  'void window["localStorage"];',
  'const { ["sessionStorage"]: tab } = globalThis;',
  "const browser = window;",
  "void browser.localStorage;",
  "const { sessionStorage: storage } = browser;",
  "let target;",
  "({ localStorage: target } = window);",
  "void self.sessionStorage;",
  "void window.window.localStorage;",
  "const retained = localStorage;",
  "void window[`sessionStorage`];",
  "const maybeBrowser = typeof window === 'undefined' ? null : window;",
  "void maybeBrowser?.localStorage;",
  "const fallbackBrowser = window || null;",
  "void fallbackBrowser.sessionStorage;",
].join("\n");

describe("browser storage ownership", () => {
  test("rejects direct references, browser properties, aliases and destructuring", async () => {
    expect(await lint(rawReferences)).toEqual([
      1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13, 14, 15, 17, 19,
    ]);
  });

  test("admits raw references only in the storage owners", async () => {
    // This pinned boundary fails when an owner exemption is added.
    expect(STORAGE_OWNERS).toEqual([
      "apps/web/src/lib/account/user-scoped-storage.ts",
      "apps/web/src/lib/account/session-signal.ts",
      "apps/web/src/lib/account/browser-storage.ts",
    ]);
    for (const owner of STORAGE_OWNERS) {
      expect(await lint(rawReferences, owner)).toEqual([]);
      expect(
        await lint(rawReferences, owner.replace("/account/", "/other/")),
      ).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13, 14, 15, 17, 19]);
    }
  });

  test("guards test consumers without reporting storage fixture declarations", async () => {
    expect(
      await lint(rawReferences, "apps/web/src/lib/storage-consumer.test.ts"),
    ).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13, 14, 15, 17, 19]);
    expect(
      await lint(
        [
          "type BrowserFixture = { localStorage: Storage; sessionStorage: Storage };",
          "const storageFixture = { localStorage: fakeStorage, sessionStorage: fakeStorage };",
          "Object.defineProperty(globalThis, 'window', { value: storageFixture });",
          "const ordinary = { localStorage: 'label' };",
          "void ordinary.localStorage;",
          "const { localStorage: label } = ordinary;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
