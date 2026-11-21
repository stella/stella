import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const sourcePath = ".oxlint-plugins/__fixtures__/outbound-owner.ts";

test("checks dynamic destinations through the current relative fetch owner", async () => {
  expect(
    await lintSingleRule(
      "require-safe-outbound-target",
      [
        'import { fetchWithTimeout as request } from "../../packages/fetch/src/index.ts";',
        "await request(inputUrl, { timeoutMs: 1000 });",
      ].join("\n"),
      { sourcePath, cwd: "scratch" },
    ),
  ).toEqual([2]);
});

test("accepts proven destinations through the current relative fetch owner", async () => {
  expect(
    await lintSingleRule(
      "require-safe-outbound-target",
      [
        'import * as http from "../../packages/fetch/src/index.ts";',
        'await http.fetchWithTimeout("https://api.example.com/items", { timeoutMs: 1000 });',
      ].join("\n"),
      { sourcePath, cwd: "scratch" },
    ),
  ).toEqual([]);
});

test("checks scoped public-read fetch methods and stable aliases", async () => {
  expect(
    await lintSingleRule(
      "require-safe-outbound-target",
      [
        'import { withPublicReadIo as own } from "@/api/lib/legal-search/public-read-timeout-context";',
        'await own("corpus-index", async io => {',
        "  await io.fetch(inputUrl, { timeoutMs: 1000 }, async response => response.text());",
        "  const handle = io;",
        "  const { fetchStream: request } = handle;",
        "  await request(inputUrl, { timeoutMs: 1000 });",
        "  const scopedFetch = io.fetch;",
        "  await scopedFetch.call(io, inputUrl, { timeoutMs: 1000 }, consume);",
        "});",
      ].join("\n"),
      {
        sourcePath: "apps/api/src/lib/legal-search/corpus-index-client.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([3, 6, 8]);
});

test("scoped public reads retain literal and configured object-store origin proofs", async () => {
  expect(
    await lintSingleRule(
      "require-safe-outbound-target",
      [
        'import { withPublicReadIo } from "@/api/lib/legal-search/public-read-timeout-context";',
        'import { getCorpusS3 } from "@/api/lib/s3";',
        'await withPublicReadIo("corpus-index", async io => {',
        '  await io.fetch("https://api.example.test/document", { timeoutMs: 1000 }, consume);',
        "  await io.fetchStream(getCorpusS3().presign(key), { timeoutMs: 1000 });",
        "});",
      ].join("\n"),
      {
        sourcePath: "apps/api/src/lib/legal-search/corpus-index-client.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("recognizes configured object-store factories within their canonical module", async () => {
  expect(
    await lintSingleRule(
      "require-safe-outbound-target",
      [
        "const getCorpusS3 = () => configuredClient;",
        "const getS3 = () => configuredClient;",
        "await fetch(getCorpusS3().presign(key));",
        "await fetch(getS3().presign(key));",
      ].join("\n"),
      { sourcePath: "apps/api/src/lib/s3.ts", cwd: "scratch" },
    ),
  ).toEqual([]);
});

test("factory names require the canonical module binding", async () => {
  const code = [
    "const getCorpusS3 = () => configuredClient;",
    "async function read(getCorpusS3) {",
    "  await fetch(getCorpusS3().presign(key));",
    "}",
    "await fetch(getCorpusS3().presign(key));",
  ].join("\n");
  expect(
    await lintSingleRule("require-safe-outbound-target", code, {
      sourcePath: "apps/api/src/lib/s3.ts",
      cwd: "scratch",
    }),
  ).toEqual([3]);
  expect(
    await lintSingleRule("require-safe-outbound-target", code, {
      sourcePath: "apps/api/src/lib/object-reader.ts",
      cwd: "scratch",
    }),
  ).toEqual([3, 5]);
});
