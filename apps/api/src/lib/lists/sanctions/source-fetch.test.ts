import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { SANCTIONS_SOURCES, readUnListVersion } from "@stll/sanctions";
import type { SanctionsSource } from "@stll/sanctions";

import {
  fetchStreamWithResolvedAddress,
  parseSafeOutboundUrl,
  validateOutboundFetchTarget,
  type safeOutboundFetchStream,
} from "@/api/lib/safe-outbound-fetch";

import { SANCTIONS_SOURCE_CONFIG } from "./source-config";
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
const SECO_FIXTURE = path.join(FIXTURES, "seco.xml");

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

test("every source carries its canonical redirect policy into API configuration", () => {
  for (const source of Object.values(SANCTIONS_SOURCES)) {
    expect(SANCTIONS_SOURCE_CONFIG[source.id].allowedRedirectHosts).toBe(
      source.allowedRedirectHosts,
    );
    for (const host of source.allowedRedirectHosts) {
      expect(parseSafeOutboundUrl(`https://${host}/`).isOk()).toBe(true);
      expect(host).not.toContain("*");
      if (source.download.kind === "direct") {
        expect(host).not.toBe(new URL(source.download.urls[0]).hostname);
      }
    }
  }
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
  test.each(["relative", "declared"] as const)(
    "loads %s redirects for every streamed publisher over HTTP transport",
    async (mode) => {
      const fixtures = {
        eu: "eu.xml",
        un: "un.xml",
        "us-sdn": "ofac-sdn.xml",
        "us-non-sdn": "ofac-non-sdn.xml",
        uk: "uk.xml",
        ch: "seco.xml",
      } as const satisfies Record<Exclude<SanctionsSource, "cz">, string>;
      for (const source of Object.values(SANCTIONS_SOURCES)) {
        if (source.id === "cz") {
          continue;
        }
        const sourceId = source.id;
        const canonicalUrl = SANCTIONS_SOURCES[sourceId].download.urls[0];
        const redirectHost =
          SANCTIONS_SOURCES[sourceId].allowedRedirectHosts.at(0);
        let redirects = 0;
        let downloads = 0;
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) => {
            if (
              (mode === "declared" && redirectHost === undefined) ||
              new URL(request.url).pathname === "/published.xml"
            ) {
              downloads += 1;
              return new Response(
                Bun.file(path.join(FIXTURES, fixtures[sourceId])),
              );
            }
            redirects += 1;
            return new Response(null, {
              status: 302,
              headers: {
                Location:
                  mode === "relative"
                    ? "/published.xml"
                    : `https://${String(redirectHost)}/published.xml`,
              },
            });
          },
        });
        const fetchStreamRequest: typeof safeOutboundFetchStream = async (
          options,
        ) => {
          const parsed = parseSafeOutboundUrl(String(options.url));
          if (parsed.isErr()) {
            return parsed;
          }
          const transportUrl = new URL(parsed.value);
          transportUrl.protocol = "http:";
          transportUrl.port = String(server.port);
          return await fetchStreamWithResolvedAddress({
            ...options,
            url: transportUrl,
            addresses: [{ address: "127.0.0.1", family: 4 }],
          });
        };
        try {
          const options = {
            signal: new AbortController().signal,
            fetchStreamRequest,
            euXmlUrlOverride: canonicalUrl,
          };
          const marker = await fetchSanctionsMarker(source.id, options);
          expect(marker.isOk()).toBe(true);
          const fetchedMarker = marker.unwrap();
          expect(fetchedMarker.downloadUrl).toBe(canonicalUrl);
          const edition = await fetchSanctionsEdition(fetchedMarker, options);
          expect(edition.isOk()).toBe(true);
          expect(edition.unwrap().parsed.entries.length).toBeGreaterThan(0);
          expect(redirects).toBe(
            mode === "declared" && redirectHost === undefined ? 0 : 2,
          );
          expect(downloads).toBe(2);
        } finally {
          await server.stop(true);
        }
      }
    },
  );

  test("refuses undeclared destinations, credentials and unsafe protocols before transport", async () => {
    for (const location of [
      "https://undeclared.test/file?token=secret",
      "https://127.0.0.1/private",
      "http://unsolprodfiles.blob.core.windows.net/file",
      "http://scsanctions.un.org/new-path",
      "https://scsanctions.un.org:444/new-path",
      "https://user:secret@unsolprodfiles.blob.core.windows.net/file",
    ]) {
      const transportTargets: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(null, {
            status: 302,
            headers: { Location: location },
          }),
      });
      try {
        const result = await fetchSanctionsMarker("un", {
          signal: new AbortController().signal,
          fetchStreamRequest: async (options) => {
            transportTargets.push(String(options.url));
            const transportUrl = new URL(options.url);
            transportUrl.protocol = "http:";
            transportUrl.port = String(server.port);
            return await fetchStreamWithResolvedAddress({
              ...options,
              url: transportUrl,
              addresses: [{ address: "127.0.0.1", family: 4 }],
            });
          },
        });
        expect(result.isErr()).toBe(true);
        expect(transportTargets.length).toBeGreaterThan(0);
        expect(
          transportTargets.every(
            (target) => target === SANCTIONS_SOURCES.un.download.urls[0],
          ),
        ).toBe(true);
        if (result.isErr()) {
          expect(result.error.message).not.toContain("secret");
          expect(result.error.code).toBe(
            location.includes("undeclared") || location.includes(":444")
              ? "access-denied"
              : "fetch-failed",
          );
        }
      } finally {
        await server.stop(true);
      }
    }
  });

  test("declared redirect hosts cannot resolve to nonpublic addresses", async () => {
    for (const blockedAddress of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
    ]) {
      const declaredHost = SANCTIONS_SOURCE_CONFIG.un.allowedRedirectHosts[0];
      const resolutions: { hostname: string; address: string }[] = [];
      const transports: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(null, {
            status: 302,
            headers: { Location: `https://${declaredHost}/published.xml` },
          }),
      });
      try {
        const result = await fetchSanctionsMarker("un", {
          signal: new AbortController().signal,
          fetchStreamRequest: async (options) => {
            const target = await validateOutboundFetchTarget(options.url, {
              signal: options.signal,
              timeoutMs: options.timeoutMs,
              resolveAddresses: async (hostname) => {
                const address =
                  hostname === declaredHost ? blockedAddress : "93.184.216.34";
                resolutions.push({ hostname, address });
                return Result.ok([
                  { address, family: address.includes(":") ? 6 : 4 },
                ]);
              },
            });
            if (target.isErr()) {
              expect(target.error.message).toBe("URL host is not allowed");
              return target;
            }
            transports.push(target.value.url.hostname);
            const transportUrl = new URL(target.value.url);
            transportUrl.protocol = "http:";
            transportUrl.port = String(server.port);
            return await fetchStreamWithResolvedAddress({
              ...options,
              url: transportUrl,
              addresses: [{ address: "127.0.0.1", family: 4 }],
            });
          },
        });
        expect(result.isErr()).toBe(true);
        expect(
          resolutions.filter(({ hostname }) => hostname === declaredHost),
        ).toEqual(
          Array.from({ length: 3 }, () => ({
            hostname: declaredHost,
            address: blockedAddress,
          })),
        );
        expect(transports).toEqual(
          Array.from({ length: 3 }, () => "scsanctions.un.org"),
        );
      } finally {
        await server.stop(true);
      }
    }
  });

  test("limits declared redirect chains to three hops including loops", async () => {
    for (const scenario of ["chain", "loop"] as const) {
      let requests = 0;
      let cancelled = 0;
      const signal = new AbortController();
      const result = await fetchSanctionsMarker("un", {
        signal: signal.signal,
        fetchStreamRequest: async ({ headers }) => {
          expect(new Headers(headers).has("authorization")).toBe(false);
          expect(new Headers(headers).has("cookie")).toBe(false);
          requests += 1;
          if (requests === 4) {
            signal.abort();
          }
          return Result.ok({
            ok: false,
            status: 302,
            headers: new Headers({
              Location: `https://unsolprodfiles.blob.core.windows.net/${scenario === "loop" ? "loop" : requests}`,
            }),
            body: new ReadableStream<Uint8Array>({
              cancel() {
                cancelled += 1;
              },
            }),
          });
        },
      });
      expect(result.isErr()).toBe(true);
      expect(requests).toBe(4);
      expect(cancelled).toBe(requests);
    }
  });

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
                  () => {
                    controller.error(signal.reason);
                  },
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

describe("SECO list refresh", () => {
  test("reads the edition from the root date at the start of the export", async () => {
    const { fetchStreamRequest, requested } = fixtureStream(SECO_FIXTURE);
    const marker = await fetchSanctionsMarker("ch", {
      signal: new AbortController().signal,
      fetchStreamRequest,
    });

    const downloadUrl = SANCTIONS_SOURCES.ch.download.urls[0];
    expect(marker.unwrap()).toEqual({
      source: "ch",
      version: { source: "ch", publishedAt: "2026-09-04", fileId: null },
      downloadUrl,
      lastModified: null,
    });
    expect(requested).toEqual([downloadUrl]);
  });

  test("parses the export it identified as the SECO source", async () => {
    const marker = (
      await fetchSanctionsMarker("ch", {
        signal: new AbortController().signal,
        fetchStreamRequest: fixtureStream(SECO_FIXTURE).fetchStreamRequest,
      })
    ).unwrap();

    const edition = await fetchSanctionsEdition(marker, {
      signal: new AbortController().signal,
      fetchStreamRequest: fixtureStream(SECO_FIXTURE).fetchStreamRequest,
    });

    const { parsed, contentHash } = edition.unwrap();
    expect(parsed.version).toEqual(marker.version);
    expect(parsed.entries.length).toBe(3);
    expect(
      parsed.entries.every(
        (entry) => entry.source === "ch" && entry.issuer === "CH",
      ),
    ).toBe(true);
    expect(contentHash).toBe(
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(SECO_FIXTURE).arrayBuffer())
        .digest("hex"),
    );
  });

  test("reports an export without a root date as a parse failure", async () => {
    let attempts = 0;
    const marker = await fetchSanctionsMarker("ch", {
      signal: new AbortController().signal,
      fetchStreamRequest: async () => {
        attempts += 1;
        return Result.ok({
          body: new Blob([
            '<?xml version="1.0"?><swiss-sanctions-list list-type="whole-list"><target ssid="1"/></swiss-sanctions-list>',
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
