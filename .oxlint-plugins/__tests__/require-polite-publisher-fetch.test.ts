import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  await lintSingleRule("require-polite-publisher-fetch", source, {
    sourcePath: "scripts/research/download.ts",
  });

test("rejects raw publisher transports by binding", async () => {
  expect(
    await lint(
      [
        'import { fetchWithTimeout as request } from "@stll/fetch";',
        'import { fetch as undiciFetch } from "undici";',
        "await fetch(url);",
        "await request(url, options);",
        "await undiciFetch(url);",
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5]);
});

test("accepts the publisher policy owner and its factory", async () => {
  expect(
    await lint(
      [
        'import { politePublisherFetch, createPolitePublisherFetch } from "@stll/fetch/publisher";',
        "await politePublisherFetch(url, options);",
        "const request = createPolitePublisherFetch();",
        "await request(url, options);",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("rejects global, namespace, and Node HTTP member transports", async () => {
  expect(
    await lint(
      [
        'import * as undici from "undici";',
        'import * as http from "node:http";',
        'import * as https from "node:https";',
        "await globalThis.fetch(url);",
        "await undici.fetch(url);",
        "http.get(url);",
        "https.request(url);",
      ].join("\n"),
    ),
  ).toEqual([4, 5, 6, 7]);
});
