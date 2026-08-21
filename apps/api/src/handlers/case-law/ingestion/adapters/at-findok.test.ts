import { describe, expect, it } from "bun:test";
import JSZip from "jszip";

import {
  atFindokNextSlice,
  atFindokPreviousSlice,
  createAtFindokAdapter,
  parseFindokManifest,
} from "@/api/handlers/case-law/ingestion/adapters/at-findok";

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
});
