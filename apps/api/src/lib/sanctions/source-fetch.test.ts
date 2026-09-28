import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { readUnListVersion } from "@stll/sanctions";

import {
  discoverCzCsvUrl,
  discoverEuXmlUrl,
  fetchSanctionsEdition,
} from "./source-fetch";

const UN_FIXTURE = path.join(
  import.meta.dir,
  "../../../../../packages/sanctions/src/fixtures/un.xml",
);

const euMetadata = (downloadUrl: string) => ({
  "@graph": [
    {
      "@type": "dcat:Distribution",
      "dct:title": [
        {
          "@language": "en",
          "@value": "Consolidated Financial Sanctions File 1.1",
        },
      ],
      "dct:format": {
        "@id": "http://publications.europa.eu/resource/authority/file-type/XML",
      },
      "dcat:downloadURL": { "@id": downloadUrl },
    },
  ],
});

describe("publisher download discovery", () => {
  test("takes the XML 1.1 distribution from EU metadata with its current query token", () => {
    const url =
      "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=example";
    const found = discoverEuXmlUrl(euMetadata(url));
    expect(found.isOk()).toBe(true);
    expect(found.unwrap()).toBe(url);
  });

  test("rejects a distribution redirected to a different host without exposing its query", () => {
    const found = discoverEuXmlUrl(
      euMetadata(
        "https://example.test/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=private",
      ),
    );
    expect(found.isErr()).toBe(true);
    expect(found.error.message).not.toContain("private");
  });

  test("selects the latest dated CSV from the Czech ministry page", () => {
    const found = discoverCzCsvUrl(`
      <a href="/file/1/Vnitrostatni_sankcni_seznam_2025_01_01.csv">old</a>
      <a href="/file/2/Vnitrostatni_sankcni_seznam_2026_07_23.csv">new</a>
      <a href="https://example.test/file/3/Vnitrostatni_sankcni_seznam_2027_01_01.csv">foreign</a>
    `);
    expect(found.isOk()).toBe(true);
    expect(found.unwrap()).toBe(
      "https://mzv.gov.cz/file/2/Vnitrostatni_sankcni_seznam_2026_07_23.csv",
    );
  });
});

describe("streaming list downloads", () => {
  test("retries a connection lost while reading the body as a fetch failure", async () => {
    const fixture = new Uint8Array(await Bun.file(UN_FIXTURE).arrayBuffer());
    const version = (
      await readUnListVersion(Bun.file(UN_FIXTURE).stream())
    ).unwrap();
    let attempts = 0;
    const result = await fetchSanctionsEdition(
      { source: "un", version, downloadUrl: "https://example.test/un.xml" },
      {
        signal: new AbortController().signal,
        fetchStreamRequest: async ({ headers }) => {
          attempts += 1;
          expect(new Headers(headers).get("User-Agent")).toMatch(
            /^stella-ingestion\//u,
          );
          return Result.ok({
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(fixture.subarray(0, 128));
                controller.error(new Error("connection reset"));
              },
            }),
            headers: new Headers(),
            ok: true,
            status: 200,
          });
        },
      },
    );

    expect(result.isErr()).toBe(true);
    expect(result.error.code).toBe("fetch-failed");
    expect(attempts).toBe(3);
  });

  test("bounds a body that remains silent after response headers", async () => {
    const version = (
      await readUnListVersion(Bun.file(UN_FIXTURE).stream())
    ).unwrap();
    let attempts = 0;
    const result = await fetchSanctionsEdition(
      { source: "un", version, downloadUrl: "https://example.test/un.xml" },
      {
        signal: new AbortController().signal,
        streamTotalTimeoutMs: 20,
        fetchStreamRequest: async ({ signal }) => {
          attempts += 1;
          return Result.ok({
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                signal?.addEventListener(
                  "abort",
                  () => controller.error(signal.reason),
                  { once: true },
                );
              },
            }),
            headers: new Headers(),
            ok: true,
            status: 200,
          });
        },
      },
    );

    expect(result.isErr()).toBe(true);
    expect(result.error.code).toBe("fetch-failed");
    expect(attempts).toBe(3);
  });
});
