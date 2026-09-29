import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { SANCTIONS_SOURCES, readUnListVersion } from "@stll/sanctions";

import type { safeOutboundFetchStream } from "@/api/lib/safe-outbound-fetch";

import {
  discoverCzCsvUrl,
  discoverEuXmlUrl,
  fetchSanctionsEdition,
  fetchSanctionsMarker,
} from "./source-fetch";

const FIXTURES = path.join(
  import.meta.dir,
  "../../../../../../packages/sanctions/src/fixtures",
);
const UN_FIXTURE = path.join(FIXTURES, "un.xml");
const OFAC_SDN_FIXTURE = path.join(FIXTURES, "ofac-sdn.xml");
const OFAC_NON_SDN_FIXTURE = path.join(FIXTURES, "ofac-non-sdn.xml");
const UK_FIXTURE = path.join(FIXTURES, "uk.xml");

/** Serves a fixture file as a successful stream and records requested URLs. */
const fixtureStream = (
  fixture: string,
  headers: Record<string, string> = {},
) => {
  const requested: string[] = [];
  const fetchStreamRequest: typeof safeOutboundFetchStream = async ({
    url,
  }) => {
    requested.push(String(url));
    return Result.ok({
      body: Bun.file(fixture).stream(),
      headers: new Headers(headers),
      ok: true,
      status: 200,
    });
  };
  return { fetchStreamRequest, requested };
};

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
    if (found.isErr()) {
      expect(found.error.message).not.toContain("private");
    }
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
      {
        source: "un",
        version,
        downloadUrl: "https://example.test/un.xml",
        lastModified: null,
      },
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
    if (result.isErr()) {
      expect(result.error.code).toBe("fetch-failed");
    }
    expect(attempts).toBe(3);
  });

  test("bounds a body that remains silent after response headers", async () => {
    const version = (
      await readUnListVersion(Bun.file(UN_FIXTURE).stream())
    ).unwrap();
    let attempts = 0;
    const result = await fetchSanctionsEdition(
      {
        source: "un",
        version,
        downloadUrl: "https://example.test/un.xml",
        lastModified: null,
      },
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
    if (result.isErr()) {
      expect(result.error.code).toBe("fetch-failed");
    }
    expect(attempts).toBe(3);
  });
});

describe("OFAC list refresh", () => {
  test("reads the SDN edition from the start of the published export", async () => {
    const { fetchStreamRequest, requested } = fixtureStream(OFAC_SDN_FIXTURE);
    const marker = await fetchSanctionsMarker("us-sdn", {
      signal: new AbortController().signal,
      fetchStreamRequest,
    });

    const downloadUrl = SANCTIONS_SOURCES["us-sdn"].download.urls[0];
    expect(marker.unwrap()).toEqual({
      source: "us-sdn",
      version: { source: "us-sdn", publishedAt: "2026-09-23", fileId: null },
      downloadUrl,
      lastModified: null,
    });
    expect(requested).toEqual([downloadUrl]);
  });

  test("parses the non-SDN export it identified as that source", async () => {
    const marker = (
      await fetchSanctionsMarker("us-non-sdn", {
        signal: new AbortController().signal,
        fetchStreamRequest:
          fixtureStream(OFAC_NON_SDN_FIXTURE).fetchStreamRequest,
      })
    ).unwrap();
    expect(marker.downloadUrl).toBe(
      SANCTIONS_SOURCES["us-non-sdn"].download.urls[0],
    );

    const edition = await fetchSanctionsEdition(marker, {
      signal: new AbortController().signal,
      fetchStreamRequest:
        fixtureStream(OFAC_NON_SDN_FIXTURE).fetchStreamRequest,
    });

    const { parsed, contentHash } = edition.unwrap();
    expect(parsed.version).toEqual(marker.version);
    expect(parsed.entries.length).toBeGreaterThan(0);
    expect(
      parsed.entries.every(
        (entry) => entry.source === "us-non-sdn" && entry.issuer === "US",
      ),
    ).toBe(true);
    expect(contentHash).toBe(
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(OFAC_NON_SDN_FIXTURE).arrayBuffer())
        .digest("hex"),
    );
  });

  test("reports an export without a publication stamp as a parse failure", async () => {
    let attempts = 0;
    const marker = await fetchSanctionsMarker("us-sdn", {
      signal: new AbortController().signal,
      fetchStreamRequest: async () => {
        attempts += 1;
        return Result.ok({
          body: new Blob([
            '<?xml version="1.0"?><sdnList><sdnEntry><uid>1</uid></sdnEntry></sdnList>',
          ]).stream(),
          headers: new Headers(),
          ok: true,
          status: 200,
        });
      },
    });

    expect(marker.isErr()).toBe(true);
    if (marker.isErr()) {
      expect(marker.error.code).toBe("parse-failed");
    }
    expect(attempts).toBe(1);
  });
});

describe("UK list refresh", () => {
  test("reads the edition from the generation date at the start of the export", async () => {
    const { fetchStreamRequest, requested } = fixtureStream(UK_FIXTURE);
    const marker = await fetchSanctionsMarker("uk", {
      signal: new AbortController().signal,
      fetchStreamRequest,
    });

    const downloadUrl = SANCTIONS_SOURCES.uk.download.urls[0];
    expect(marker.unwrap()).toEqual({
      source: "uk",
      version: { source: "uk", publishedAt: "2026-09-21", fileId: null },
      downloadUrl,
      lastModified: null,
    });
    expect(requested).toEqual([downloadUrl]);
  });

  test("parses the export it identified as the UK source", async () => {
    const marker = (
      await fetchSanctionsMarker("uk", {
        signal: new AbortController().signal,
        fetchStreamRequest: fixtureStream(UK_FIXTURE).fetchStreamRequest,
      })
    ).unwrap();

    const edition = await fetchSanctionsEdition(marker, {
      signal: new AbortController().signal,
      fetchStreamRequest: fixtureStream(UK_FIXTURE).fetchStreamRequest,
    });

    const { parsed, contentHash } = edition.unwrap();
    expect(parsed.version).toEqual(marker.version);
    expect(parsed.entries.length).toBe(3);
    expect(
      parsed.entries.every(
        (entry) => entry.source === "uk" && entry.issuer === "GB",
      ),
    ).toBe(true);
    expect(contentHash).toBe(
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(UK_FIXTURE).arrayBuffer())
        .digest("hex"),
    );
  });

  test("reports an export without a generation date as a parse failure", async () => {
    let attempts = 0;
    const marker = await fetchSanctionsMarker("uk", {
      signal: new AbortController().signal,
      fetchStreamRequest: async () => {
        attempts += 1;
        return Result.ok({
          body: new Blob([
            '<?xml version="1.0"?><Designations><Designation><UniqueID>UK-1</UniqueID></Designation></Designations>',
          ]).stream(),
          headers: new Headers(),
          ok: true,
          status: 200,
        });
      },
    });

    expect(marker.isErr()).toBe(true);
    if (marker.isErr()) {
      expect(marker.error.code).toBe("parse-failed");
    }
    expect(attempts).toBe(1);
  });
});

describe("HTTP validators for same-day editions", () => {
  const options = (
    fixture: string,
    headers: Record<string, string>,
  ): Parameters<typeof fetchSanctionsMarker>[1] => ({
    signal: new AbortController().signal,
    fetchStreamRequest: fixtureStream(fixture, headers).fetchStreamRequest,
  });

  test("keeps the stated OFAC date and adds the Last-Modified of the export", async () => {
    const marker = (
      await fetchSanctionsMarker(
        "us-sdn",
        options(OFAC_SDN_FIXTURE, {
          "Last-Modified": "Wed, 23 Sep 2026 18:42:07 GMT",
        }),
      )
    ).unwrap();
    expect(marker.version.publishedAt).toBe("2026-09-23");
    expect(marker.lastModified).toBe("2026-09-23T18:42:07Z");

    const edition = (
      await fetchSanctionsEdition(
        marker,
        options(OFAC_SDN_FIXTURE, {
          "Last-Modified": "Wed, 23 Sep 2026 18:42:07 GMT",
        }),
      )
    ).unwrap();
    expect(edition.parsed.version).toEqual(marker.version);
    expect(edition.lastModified).toBe("2026-09-23T18:42:07Z");
  });

  test("reads the Last-Modified of the UK export", async () => {
    const marker = (
      await fetchSanctionsMarker(
        "uk",
        options(UK_FIXTURE, {
          "Last-Modified": "Mon, 21 Sep 2026 09:15:00 GMT",
        }),
      )
    ).unwrap();
    expect(marker.version.publishedAt).toBe("2026-09-21");
    expect(marker.lastModified).toBe("2026-09-21T09:15:00Z");
  });

  test("leaves the validator out when the header is missing or unreadable", async () => {
    const missing = await fetchSanctionsMarker("uk", options(UK_FIXTURE, {}));
    expect(missing.unwrap().lastModified).toBeNull();
    const unreadable = await fetchSanctionsMarker(
      "us-non-sdn",
      options(OFAC_NON_SDN_FIXTURE, { "Last-Modified": "yesterday" }),
    );
    expect(unreadable.unwrap().lastModified).toBeNull();
  });

  test("ignores Last-Modified for a source whose marker is not that header", async () => {
    const marker = await fetchSanctionsMarker(
      "un",
      options(UN_FIXTURE, { "Last-Modified": "Wed, 23 Sep 2026 18:42:07 GMT" }),
    );
    expect(marker.unwrap().lastModified).toBeNull();
  });
});
