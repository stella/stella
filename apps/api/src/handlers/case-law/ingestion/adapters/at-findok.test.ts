import { describe, expect, it } from "bun:test";
import JSZip from "jszip";

import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import {
  assembleAtFindokDecision,
  atFindokNextSlice,
  atFindokPreviousSlice,
  createAtFindokAdapter,
  parseFindokManifest,
} from "@/api/handlers/case-law/ingestion/adapters/at-findok";
import { loadDocxArchive } from "@/api/lib/docx-archive";

import { PublisherPageError } from "./publisher-page";

const DOCUMENT_ID = "b68202a0-55e4-4dea-9e93-971f0b71ae32";
const MANIFEST_ITEM = {
  stammNr: 152_257,
  pathZip: "152/152257/152257.zip",
  pathPdf: "152/152257/152257.1.pdf",
  dokumenttyp: "Bescheidbeschwerde - Einzel - Erkenntnis",
  behoerde: "BFG",
  appdat: "14.07.2026",
  gz: "RV/7500368/2026",
  titel: "Parkometerfall, 15 Minuten-Parkscheine verwendet",
  gueltigAb: "",
  inFindokSeitDate: "2026-08-06T14:54:41.882132",
  inFindokSeit: "06.08.2026 02:54:41",
  gueltig: true,
  dokumentId: DOCUMENT_ID,
} as const;

const xmlFixture = async (): Promise<string> =>
  await Bun.file(
    new URL("../parsers/__fixtures__/at-findok-bfg-2026.xml", import.meta.url),
  ).text();

const manifestResponse = (
  items: readonly unknown[] = [MANIFEST_ITEM],
): Response =>
  new Response(
    Bun.gzipSync(
      JSON.stringify({ generierungsdatum: "07.08.2026 06:16", data: items }),
    ),
  );

const detailResponse = async (): Promise<Response> => {
  const zip = new JSZip();
  zip.file("Gesamt/152257.Entscheidungstext.xml", await xmlFixture());
  return new Response(await zip.generateAsync({ type: "uint8array" }));
};

const reconciliationOf = (adapter: ReturnType<typeof createAtFindokAdapter>) =>
  adapter.reconciliation;

describe("Austrian Findok adapter", () => {
  it("quarantines a rejected title while storing later items and advancing the cursor", async () => {
    const poisonId = "b68202a0-55e4-4dea-9e93-971f0b71ae33";
    const poison = {
      ...MANIFEST_ITEM,
      dokumentId: poisonId,
      titel: "<br/>",
    };
    const detailBytes = await (await detailResponse()).arrayBuffer();
    const documentRequests: string[] = [];
    let listingRead = false;
    const adapter = createAtFindokAdapter({
      now: () => new Date("2026-08-12T00:00:00Z"),
      request: async (url) => {
        if (!listingRead) {
          listingRead = true;
          return manifestResponse([poison, MANIFEST_ITEM]);
        }
        documentRequests.push(String(url));
        return new Response(detailBytes);
      },
      sleep: async () => {},
    });
    const page = (await adapter.fetchPage(null, {})).unwrap();
    expect(page.itemBuildFailures).toEqual({
      type: "item_build_failed",
      count: 1,
    });
    expect(
      page.decisions.filter(({ isListingOnly }) => !isListingOnly),
    ).toHaveLength(1);
    const quarantine = page.decisions.find(
      ({ sourceDocumentId }) => sourceDocumentId === poisonId,
    );
    expect(quarantine?.isListingOnly).toBe(true);
    expect(quarantine?.textFields.summary.type).toBe("absent");
    expect(
      decodeSourceRawEnvelope(quarantine?.sourceRaw ?? "")?.["listing"],
    ).toContain('"titel":"<br/>"');
    expect(documentRequests).toEqual([
      `https://findok.bmf.gv.at/findok/iwg/${MANIFEST_ITEM.pathZip}`,
    ]);
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor).toContain("verify");
  });
  it("replay rejects a manifest title even when the archive states a valid subject", async () => {
    const manifest = parseFindokManifest(
      "bfg",
      JSON.stringify({
        generierungsdatum: "07.08.2026 06:16",
        data: [{ ...MANIFEST_ITEM, titel: "<br/>" }],
      }),
    );
    const item = manifest.items.at(0);
    if (item === undefined) {
      throw new TypeError("The manifest fixture must contain a row");
    }
    const documentXml = await xmlFixture();
    const decision = assembleAtFindokDecision(
      { collection: "bfg", item },
      { documentXml },
    );
    expect(decision.plainTextOutcome.type).toBe("item_build_failed");
    expect(decision.isListingOnly).toBe(true);
    expect(decision.sourceDocumentId).toBe(DOCUMENT_ID);
    expect(
      decodeSourceRawEnvelope(decision.sourceRaw ?? "")?.["document-xml"],
    ).toBe(documentXml);
  });
  for (const fixture of [
    { name: "HTML challenge", body: "<html><form><input></form></html>" },
    { name: "empty JSON", body: "{}" },
    { name: "missing timestamp", body: '{"data":[]}' },
    { name: "truncated manifest", body: '{"data":[' },
    { name: "empty manifest bytes", body: "" },
  ]) {
    it(`rejects a 200 ${fixture.name} before advancing the listing`, async () => {
      const adapter = createAtFindokAdapter({
        now: () => new Date("2026-08-12T00:00:00Z"),
        request: async () => new Response(fixture.body),
        sleep: async () => {},
      });
      const result = await adapter.fetchPage(null, {});
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(PublisherPageError);
      }
    });
  }
  for (const fixture of [
    { name: "HTML challenge", body: "<html><script></script></html>" },
    { name: "empty JSON", body: "{}" },
    { name: "missing archive field", body: '{"data":[]}' },
    { name: "truncated ZIP", body: new Uint8Array([0x50, 0x4b, 3, 4]) },
  ]) {
    it(`isolates a 200 ${fixture.name} document and advances past it`, async () => {
      const healthyId = "c68202a0-55e4-4dea-9e93-971f0b71ae32";
      const responses = [
        manifestResponse([
          MANIFEST_ITEM,
          { ...MANIFEST_ITEM, dokumentId: healthyId },
        ]),
        new Response(fixture.body),
        await detailResponse(),
      ];
      const adapter = createAtFindokAdapter({
        now: () => new Date("2026-08-12T00:00:00Z"),
        request: async () =>
          responses.shift() ?? new Response(null, { status: 500 }),
        sleep: async () => {},
      });
      const page = (await adapter.fetchPage(null, {})).unwrap();
      expect(responses).toHaveLength(0);
      expect(page.itemBuildFailures).toEqual({
        type: "item_build_failed",
        count: 1,
      });
      expect(page.decisions).toHaveLength(2);
      expect(page.decisions.at(0)).toMatchObject({
        sourceDocumentId: DOCUMENT_ID,
        isListingOnly: true,
      });
      expect(page.decisions.at(1)?.sourceDocumentId).toBe(healthyId);
      expect(page.decisions.at(1)?.isListingOnly).not.toBe(true);
      expect(page.nextCursor).not.toBeNull();
    });
  }
  it("accepts a small manifest with its required envelope and no active rows", async () => {
    const adapter = createAtFindokAdapter({
      now: () => new Date("2026-08-12T00:00:00Z"),
      request: async () => manifestResponse([]),
      sleep: async () => {},
    });
    const page = (await adapter.fetchPage(null, {})).unwrap();
    expect(page.decisions).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
  });
  for (const xml of [
    "<html><form></form></html>",
    "<root/>",
    "<Segmente><Segment></Segmente>",
    "<Segmente><Segment>",
  ]) {
    it(`isolates malformed or unexpected decision XML ${xml}`, async () => {
      const zip = new JSZip();
      zip.file("Gesamt/152257.Entscheidungstext.xml", xml);
      const bytes = await zip.generateAsync({ type: "uint8array" });
      let requests = 0;
      const adapter = createAtFindokAdapter({
        now: () => new Date("2026-08-12T00:00:00Z"),
        request: async () =>
          ++requests === 1 ? manifestResponse() : new Response(bytes),
        sleep: async () => {},
      });
      const result = await adapter.fetchPage(null, {});
      expect(requests).toBe(2);
      const page = result.unwrap();
      expect(page.itemBuildFailures).toEqual({
        type: "item_build_failed",
        count: 1,
      });
      expect(page.decisions.at(0)).toMatchObject({
        sourceDocumentId: DOCUMENT_ID,
        isListingOnly: true,
      });
      expect(page.nextCursor).not.toBeNull();
    });
  }
  it("keeps HTTP detail failures at the page failure boundary", async () => {
    const responses = [manifestResponse(), new Response(null, { status: 503 })];
    const adapter = createAtFindokAdapter({
      now: () => new Date("2026-08-12T00:00:00Z"),
      request: async () =>
        responses.shift() ?? new Response(null, { status: 500 }),
      sleep: async () => {},
    });
    const page = await adapter.fetchPage(null, {});
    expect(page.isErr()).toBe(true);
    if (page.isErr()) {
      expect(page.error.httpStatus).toBe(503);
    }
  });

  it("retains the listing when a complete archive has no decision XML", async () => {
    const zip = new JSZip();
    zip.file("Gesamt/152257.Rechtssaetze.xml", "<root/>");
    const responses = [
      manifestResponse(),
      new Response(await zip.generateAsync({ type: "uint8array" })),
    ];
    const adapter = createAtFindokAdapter({
      now: () => new Date("2026-08-12T00:00:00Z"),
      request: async () =>
        responses.shift() ?? new Response(null, { status: 500 }),
      sleep: async () => {},
    });
    const page = (await adapter.fetchPage(null, {})).unwrap();
    expect(page.itemBuildFailures).toEqual({
      type: "item_build_failed",
      count: 1,
    });
    expect(page.decisions.at(0)).toMatchObject({
      sourceDocumentId: DOCUMENT_ID,
      isListingOnly: true,
    });
    expect(page.nextCursor).not.toBeNull();
  });

  it("walks the UFS to BFG successor chain in lexical order", () => {
    expect(atFindokNextSlice("2012-ufs")).toBe("2013-ufs");
    expect(atFindokNextSlice("2013-ufs")).toBe("2014-bfg");
    expect(atFindokPreviousSlice("2014-bfg")).toBe("2013-ufs");
    expect(atFindokPreviousSlice("2003-ufs")).toBeNull();
  });

  it("adopts the manifest UUID and parses the listed ZIP artifact", async () => {
    const urls: string[] = [];
    const responses = [manifestResponse(), await detailResponse()];
    const adapter = createAtFindokAdapter({
      now: () => new Date("2026-08-12T00:00:00Z"),
      request: async (url) => {
        urls.push(url);
        const response = responses.shift();
        if (response === undefined) {
          throw new Error(`Unexpected Findok request: ${url}`);
        }
        return response;
      },
      sleep: async () => {},
    });

    const first = await adapter.fetchPage(null, {});
    expect(first.isOk()).toBe(true);
    const page = first.unwrap();
    expect(page.decisions.at(0)).toMatchObject({
      sourceDocumentId: DOCUMENT_ID,
      caseNumber: "RV/7500368/2026",
      ecli: "ECLI:AT:BFG:2026:RV.7500368.2026",
      court: "BFG",
      country: "AUT",
      language: "de",
      decisionDate: "2026-07-14",
    });
    expect(page.decisions.at(0)?.sourceRaw).toContain("<Segmente>");
    expect(urls).toEqual([
      "https://findok.bmf.gv.at/findok/iwg/bestandsliste-bfg.gz",
      "https://findok.bmf.gv.at/findok/iwg/152/152257/152257.zip",
    ]);

    const verified = await adapter.fetchPage(page.nextCursor, {});
    expect(verified.unwrap().decisions).toEqual([]);
  });

  it("reports the two publisher inventories as one source total", async () => {
    const adapter = createAtFindokAdapter({
      now: () => new Date("2026-08-12T00:00:00Z"),
      request: async () => manifestResponse(),
      sleep: async () => {},
    });
    expect(await adapter.getTotalCount(new AbortController().signal)).toEqual({
      type: "count",
      total: 2,
    });
  });

  it("throws on a malformed manifest rather than banking an empty source", async () => {
    const adapter = createAtFindokAdapter({
      now: () => new Date("2026-08-12T00:00:00Z"),
      request: async () =>
        new Response(Bun.gzipSync(JSON.stringify({ data: [] }))),
      sleep: async () => {},
    });
    expect((await adapter.fetchPage(null, {})).isErr()).toBe(true);
  });

  it("ignores malformed rows the publisher marks outside its active inventory", () => {
    const manifest = parseFindokManifest(
      "bfg",
      JSON.stringify({
        generierungsdatum: "07.08.2026 06:16",
        data: [{ gueltig: false }, MANIFEST_ITEM],
      }),
    );

    expect(manifest.items.map(({ dokumentId }) => dokumentId)).toEqual([
      DOCUMENT_ID,
    ]);
  });

  for (const rejected of [
    { gueltig: true },
    { ...MANIFEST_ITEM, pathZip: "https://invalid.example/document.zip" },
    { ...MANIFEST_ITEM, appdat: "invalid" },
    null,
    MANIFEST_ITEM,
  ]) {
    it(`quarantines a rejected manifest member ${JSON.stringify(rejected)} and advances alongside a healthy decision`, async () => {
      const responses = [
        manifestResponse([MANIFEST_ITEM, rejected]),
        await detailResponse(),
      ];
      const adapter = createAtFindokAdapter({
        now: () => new Date("2026-08-12T00:00:00Z"),
        request: async () =>
          responses.shift() ?? new Response(null, { status: 500 }),
        sleep: async () => {},
      });
      const page = (await adapter.fetchPage(null, {})).unwrap();
      expect(responses).toHaveLength(0);
      expect(page.decisions).toHaveLength(2);
      expect(page.itemBuildFailures).toEqual({
        type: "item_build_failed",
        count: 1,
      });
      const quarantined = page.decisions.find(
        ({ isListingOnly }) => isListingOnly,
      );
      expect(quarantined?.sourceDocumentId).toStartWith("findok-quarantine:");
      expect(quarantined?.documentUrl).toBeUndefined();
      expect(String(quarantined?.metadata["detailStatus"])).toBe(
        "item_build_failed",
      );
      expect(quarantined?.sourceRaw).toBeDefined();
      const parts = decodeSourceRawEnvelope(quarantined?.sourceRaw ?? "");
      expect(JSON.parse(parts?.["listing"] ?? "null")).toEqual(rejected);
      expect(
        page.decisions.find(
          ({ sourceDocumentId }) => sourceDocumentId === DOCUMENT_ID,
        )?.isListingOnly,
      ).not.toBe(true);
      expect(page.nextCursor).not.toBeNull();
      const repeated = parseFindokManifest(
        "bfg",
        JSON.stringify({
          generierungsdatum: "07.08.2026 06:16",
          data: [MANIFEST_ITEM, rejected],
        }),
      );
      expect(
        repeated.items.find(({ type }) => type === "quarantine")?.dokumentId,
      ).toBe(quarantined?.sourceDocumentId);
    });
  }

  it("quarantines an invalid publisher UUID without hiding later documents", async () => {
    const invalidIdentity = {
      ...MANIFEST_ITEM,
      stammNr: 152_256,
      pathZip: "152/152256/152256.zip",
      pathPdf: "152/152256/152256.1.pdf",
      gz: "RV/4100260/2026",
      dokumentId: "not-a-uuid",
    };
    const adapter = createAtFindokAdapter({
      now: () => new Date("2026-08-12T00:00:00Z"),
      request: async () => manifestResponse([invalidIdentity, MANIFEST_ITEM]),
      sleep: async () => {},
    });
    const reconciliation = reconciliationOf(adapter);
    const listing = await reconciliation.listSlicePage({
      slice: "2026-bfg",
      page: 0,
    });
    expect(listing.items).toHaveLength(2);
    expect(
      listing.items.some(
        ({ identity }) =>
          identity.type === "document" &&
          identity.sourceDocumentId.startsWith("findok-quarantine:"),
      ),
    ).toBe(true);
    expect(
      listing.items.some(
        ({ identity }) =>
          identity.type === "document" &&
          identity.sourceDocumentId === DOCUMENT_ID,
      ),
    ).toBe(true);
    const quarantine = listing.items.find(
      ({ identity }) =>
        identity.type === "document" &&
        identity.sourceDocumentId.startsWith("findok-quarantine:"),
    );
    expect(await reconciliation.buildDecision(quarantine?.payload)).toEqual({
      type: "detail-unavailable",
    });
  });

  it("lists year slices with the crawl identity and parks absent detail", async () => {
    const responses = [manifestResponse(), new Response(null, { status: 404 })];
    const adapter = createAtFindokAdapter({
      now: () => new Date("2026-08-12T00:00:00Z"),
      request: async () => {
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("Unexpected Findok request");
        }
        return response;
      },
      sleep: async () => {},
    });
    const reconciliation = reconciliationOf(adapter);
    const listing = await reconciliation.listSlicePage({
      slice: "2026-bfg",
      page: 0,
    });
    expect(listing.items.at(0)?.identity).toEqual({
      type: "document",
      sourceDocumentId: DOCUMENT_ID,
    });
    expect(
      await reconciliation.buildDecision(listing.items.at(0)?.payload),
    ).toEqual({ type: "detail-unavailable" });
  });
  it("reads both entries of the archive it already downloaded", async () => {
    // The capture is one decision as the ministry files it: the text of the
    // decision and the headnotes drawn from it, in one archive.
    const archive = await loadDocxArchive(
      await Bun.file(
        new URL(
          "../parsers/__fixtures__/at-findok-152649.zip",
          import.meta.url,
        ),
      ).bytes(),
      { maxEntries: 20, maxEntryBytes: 4_000_000, maxTotalBytes: 4_000_000 },
    );
    const documentXml = await archive.readEntryString(
      "Gesamt/152649.Entscheidungstext.xml",
    );
    const headnoteXml = await archive.readEntryString(
      "Gesamt/152649.Rechtssaetze.xml",
    );
    if (documentXml === null || headnoteXml === null) {
      throw new Error("the captured archive is missing an entry");
    }
    const manifest = parseFindokManifest(
      "bfg",
      JSON.stringify({
        generierungsdatum: "18.09.2026 06:17",
        data: [
          {
            ...MANIFEST_ITEM,
            stammNr: 152_649,
            pathZip: "152/152649/152649.zip",
            pathPdf: "152/152649/152649.1.pdf",
            gz: "RV/2100968/2026",
            dokumentId: "ffa6f670-dc36-42cc-ae37-52683327a048",
          },
        ],
      }),
    );
    const item = manifest.items.at(0);
    if (item === undefined) {
      throw new Error("the manifest fixture states no row");
    }

    const decision = assembleAtFindokDecision(
      { collection: "bfg", item },
      { documentXml, headnoteXml },
    );

    expect(
      Object.keys(decodeSourceRawEnvelope(decision.sourceRaw ?? "") ?? {}),
    ).toEqual(["listing", "document-xml", "headnote-xml"]);
    // The sentence lives in an element of its own, which a reader of the
    // decision text's body element never finds.
    expect(decision.textFields.legalSentence).toMatchObject({
      type: "present",
    });
    expect(decision.textFields.summary).toMatchObject({ type: "present" });
    expect(Bun.deepEquals(decision.metadata["headnoteNumbers"], ["1"])).toBe(
      true,
    );
    expect(decision.metadata["headnoteStatutes"]).not.toEqual([]);
    expect(decision.metadata["subjectCodes"]).not.toEqual([]);
    expect(decision.metadata["findokGid"]).toContain("_");
  });
});
