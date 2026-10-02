import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const ADAPTER_PATH = "apps/api/src/handlers/soft-law/adapters/uoou.ts";
const lint = async (lines: readonly string[], sourcePath = ADAPTER_PATH) =>
  await lintSingleRule("require-safe-outbound-target", lines.join("\n"), {
    sourcePath,
  });

describe.serial("soft-law handlers use the supplied fetch capability", () => {
  test("rejects network primitives even when the destination is fixed", async () => {
    expect(
      await lint([
        'import { fetchWithTimeout as request } from "@stll/fetch";',
        'import https from "node:https";',
        'import { get as httpGet } from "node:http";',
        'import * as undici from "undici";',
        'import Socket from "ws";',
        'await fetch("https://uoou.gov.cz/document");',
        'await globalThis.fetch("https://uoou.gov.cz/document");',
        "const { fetch: globalRequest } = globalThis;",
        'await globalRequest("https://uoou.gov.cz/document");',
        "const alias = request;",
        'await alias("https://uoou.gov.cz/document", { timeoutMs: 1000 });',
        'await request.call(null, "https://uoou.gov.cz/document");',
        'await request.apply(null, ["https://uoou.gov.cz/document"]);',
        "const bound = request.bind(null);",
        'await bound("https://uoou.gov.cz/document");',
        'https.request({ hostname: "uoou.gov.cz", path: "/document" });',
        'httpGet("https://uoou.gov.cz/document");',
        'await undici.request("https://uoou.gov.cz/document");',
        'await undici.stream("https://uoou.gov.cz/document", {}, factory);',
        'new WebSocket("wss://uoou.gov.cz/document");',
        'new Socket("wss://uoou.gov.cz/document");',
      ]),
    ).toEqual([6, 7, 9, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21]);
  });

  test("safe outbound wrappers cannot bypass the publisher block latch", async () => {
    expect(
      await lint([
        'import { safeOutboundFetchBytes as bytes, safeOutboundFetchStream, fetchWithResolvedAddress, fetchStreamWithResolvedAddress } from "@/api/lib/safe-outbound-fetch";',
        'import * as outbound from "@/api/lib/safe-outbound-fetch";',
        'await bytes({ url: "https://uoou.gov.cz/document", maxBytes: 1000, timeoutMs: 1000 });',
        'await safeOutboundFetchStream({ url: "https://uoou.gov.cz/document", maxBytes: 1000, timeoutMs: 1000 });',
        "await fetchWithResolvedAddress(options);",
        "await fetchStreamWithResolvedAddress(options);",
        "const alias = outbound.safeOutboundFetchBytes;",
        "await alias(options);",
        "await outbound.safeOutboundFetchStream.call(null, options);",
        "await bytes.apply(null, [options]);",
      ]),
    ).toEqual([3, 4, 5, 6, 8, 9, 10]);
  });

  test("accepts the supplied capability and locally shadowed fetch names", async () => {
    expect(
      await lint([
        'import type { SoftLawFetch } from "@/api/lib/legal-search/soft-law-access-types";',
        'const discover = async ({ fetch }: { fetch: SoftLawFetch }) => await fetch("https://uoou.gov.cz/listing");',
        'const load = async (context: { fetch: SoftLawFetch }) => await context.fetch("https://uoou.gov.cz/document");',
        'const local = async () => { const fetch = async () => "stored"; return await fetch(); };',
      ]),
    ).toEqual([]);
  });

  test("keeps trusted requests available to the shared transport", async () => {
    expect(
      await lint(
        [
          'import { fetchWithTimeout } from "@stll/fetch";',
          'import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";',
          'await fetchWithTimeout("https://uoou.gov.cz/document", { timeoutMs: 1000 });',
          "await safeOutboundFetchBytes({ url: input, maxBytes: 1000, timeoutMs: 1000 });",
        ],
        "apps/api/src/handlers/soft-law/publisher-access.ts",
      ),
    ).toEqual([]);
  });

  test("handlers and helpers cannot bypass the transport outside the adapter directory", async () => {
    for (const sourcePath of [
      "apps/api/src/handlers/soft-law/ingestion.ts",
      "apps/api/src/handlers/soft-law/helpers/download.ts",
      "apps/api/src/handlers/soft-law/helpers/publisher-access.ts",
      "apps/api/src/handlers/soft-law/publisher-access-other.ts",
    ]) {
      expect(
        await lint(
          [
            'import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";',
            'await fetch("https://uoou.gov.cz/document");',
            "await safeOutboundFetchBytes({ url: input, maxBytes: 1000, timeoutMs: 1000 });",
          ],
          sourcePath,
        ),
      ).toEqual([2, 3]);
    }
  });
});
