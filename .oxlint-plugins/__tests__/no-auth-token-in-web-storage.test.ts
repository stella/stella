import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects literal credential keys and property writes", async () => {
  expect(
    await lintSingleRule(
      "no-auth-token-in-web-storage",
      'localStorage.setItem("accessToken", value);\nwindow.sessionStorage["refreshToken"] = value;',
      {},
    ),
  ).toEqual([1, 2]);
});

test("follows storage aliases and imported credential key names", async () => {
  expect(
    await lintSingleRule(
      "no-auth-token-in-web-storage",
      'import { ACCESS_TOKEN } from "./keys";\nconst storage = globalThis.localStorage;\nstorage.setItem(ACCESS_TOKEN, value);',
      {},
    ),
  ).toEqual([3]);
});

test("rejects serialized credentials under a benign key", async () => {
  expect(
    await lintSingleRule(
      "no-auth-token-in-web-storage",
      'const payload = { accessToken: value };\nlocalStorage.setItem("state", JSON.stringify(payload));',
      {},
    ),
  ).toEqual([2]);
});

test("checks local helpers that forward credential keys", async () => {
  expect(
    await lintSingleRule(
      "no-auth-token-in-web-storage",
      'function save(key, value) { localStorage.setItem(key, value); }\nsave("authToken", value);',
      {},
    ),
  ).toEqual([2]);
});

test("allows benign tokens and genuinely dynamic keys", async () => {
  expect(
    await lintSingleRule(
      "no-auth-token-in-web-storage",
      'localStorage.setItem("csrfToken", value);\nlocalStorage.setItem("designToken", value);\nlocalStorage.setItem(key, value);',
      {},
    ),
  ).toEqual([]);
});

test("respects lexical storage and host shadows", async () => {
  expect(
    await lintSingleRule(
      "no-auth-token-in-web-storage",
      'function local(localStorage, window) {\n localStorage.setItem("accessToken", value);\n window.sessionStorage.setItem("accessToken", value);\n}',
      {},
    ),
  ).toEqual([]);
});
