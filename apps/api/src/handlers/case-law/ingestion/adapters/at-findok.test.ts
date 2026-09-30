import { describe, expect, it } from "bun:test";
import JSZip from "jszip";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  assembleAtFindokDecision,
  atFindokNextSlice,
  atFindokPreviousSlice,
  createAtFindokAdapter,
  parseFindokManifest,
} from "@/api/handlers/case-law/ingestion/adapters/at-findok";
import { loadDocxArchive } from "@/api/lib/docx-archive";

import { storedRawReparseInputOf } from "./test-utils";

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

type ManifestFixture = Record<string, unknown>;

const xmlFixture = async (): Promise<string> =>
  await Bun.file(
    new URL("../parsers/__fixtures__/at-findok-bfg-2026.xml", import.meta.url),
  ).text();

const manifestResponse = (
  items: readonly ManifestFixture[] = [MANIFEST_ITEM],
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
    const decision = page.decisions.at(0);
    if (decision === undefined) {
      throw new TypeError("Expected the listed Findok decision");
    }
    expect(decision).toMatchObject({
      sourceDocumentId: DOCUMENT_ID,
      caseNumber: "RV/7500368/2026",
      ecli: "ECLI:AT:BFG:2026:RV.7500368.2026",
      court: "BFG",
      country: "AUT",
      language: "de",
      decisionDate: "2026-07-14",
    });
    expect(decision.sourceRaw).toContain("<Segmente>");
    expect(urls).toEqual([
      "https://findok.bmf.gv.at/findok/iwg/bestandsliste-bfg.gz",
      "https://findok.bmf.gv.at/findok/iwg/152/152257/152257.zip",
    ]);

    const reparse = adapter.reparseStoredRaw;
    const requestsBeforeReplay = urls.length;
    expect(await reparse(storedRawReparseInputOf(decision))).toEqual({
      type: "parsed",
      result: decision,
    });
    expect(urls).toHaveLength(requestsBeforeReplay);

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

  it("rejects malformed active rows instead of silently under-ingesting", () => {
    expect(() =>
      parseFindokManifest(
        "bfg",
        JSON.stringify({
          generierungsdatum: "07.08.2026 06:16",
          data: [{ gueltig: true }, MANIFEST_ITEM],
        }),
      ),
    ).toThrow("invalid item at 0");
  });

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
    expect(decision.metadata["headnoteNumbers"]).toEqual(["1"]);
    expect(decision.metadata["headnoteStatutes"]).not.toEqual([]);
    expect(decision.metadata["subjectCodes"]).not.toEqual([]);
    expect(decision.metadata["findokGid"]).toContain("_");

    let requests = 0;
    const adapter = createAtFindokAdapter({
      request: async () => {
        requests += 1;
        throw new Error("reparseStoredRaw must not contact Findok");
      },
      sleep: async () => {},
    });
    const reparse = adapter.reparseStoredRaw;
    expect(await reparse(storedRawReparseInputOf(decision))).toEqual({
      type: "parsed",
      result: decision,
    });
    expect(requests).toBe(0);
  });

  it("rejects invalid stored payloads and mismatched Findok collection", async () => {
    const documentXml = await xmlFixture();
    const manifest = parseFindokManifest(
      "bfg",
      JSON.stringify({
        generierungsdatum: "07.08.2026 06:16",
        data: [MANIFEST_ITEM],
      }),
    );
    const item = manifest.items.at(0);
    if (item === undefined) {
      throw new TypeError("The manifest fixture states no row");
    }
    const decision = assembleAtFindokDecision(
      { collection: "bfg", item },
      { documentXml },
    );
    const adapter = createAtFindokAdapter({
      request: async () => {
        throw new Error("reparseStoredRaw must not contact Findok");
      },
      sleep: async () => {},
    });
    const reparse = adapter.reparseStoredRaw;

    const stored = storedRawReparseInputOf(decision);
    const expectedIncomplete = {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
    };
    expect(await reparse({ ...stored, raw: new Uint8Array() })).toMatchObject(
      expectedIncomplete,
    );
    expect(
      await reparse({
        ...stored,
        raw: new TextEncoder().encode("not-json"),
      }),
    ).toMatchObject(expectedIncomplete);

    const { collection: _collection, ...metadataWithoutCollection } =
      stored.metadata;
    expect(
      await reparse({ ...stored, metadata: metadataWithoutCollection }),
    ).toMatchObject(expectedIncomplete);
    expect(
      await reparse({
        ...stored,
        metadata: { ...stored.metadata, collection: "unknown" },
      }),
    ).toMatchObject(expectedIncomplete);
    expect(
      await reparse({ ...stored, sourceDocumentId: "another-document" }),
    ).toMatchObject({
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
    });

    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    const listing = parts?.["listing"];
    if (listing === undefined) {
      throw new TypeError("The captured Findok envelope has no listing part");
    }
    expect(
      await reparse({
        ...stored,
        raw: new TextEncoder().encode(encodeSourceRawEnvelope({ listing })),
      }),
    ).toMatchObject({
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
    });
  });

  it("replays the stored pre-envelope Findok JSON shape", async () => {
    const documentXml = await xmlFixture();
    const manifest = parseFindokManifest(
      "bfg",
      JSON.stringify({
        generierungsdatum: "07.08.2026 06:16",
        data: [MANIFEST_ITEM],
      }),
    );
    const item = manifest.items.at(0);
    if (item === undefined) {
      throw new TypeError("The manifest fixture states no row");
    }
    const decision = assembleAtFindokDecision(
      { collection: "bfg", item },
      { documentXml },
    );
    const adapter = createAtFindokAdapter({
      request: async () => {
        throw new Error("reparseStoredRaw must not contact Findok");
      },
      sleep: async () => {},
    });
    const reparse = adapter.reparseStoredRaw;

    const legacyRaw = JSON.stringify({
      listing: { collection: "bfg", item },
      documentXml,
    });
    const replayed = await reparse({
      ...storedRawReparseInputOf(decision),
      raw: new TextEncoder().encode(legacyRaw),
      contentType: "application/json",
    });
    expect(replayed).toEqual({ type: "parsed", result: decision });
  });
});
