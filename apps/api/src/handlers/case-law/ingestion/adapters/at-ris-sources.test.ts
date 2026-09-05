import { describe, expect, it } from "bun:test";

import { AT_ASYLGH_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-asylgh";
import { AT_BKS_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-bks";
import { AT_BVWG_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-bvwg";
import { createAtRisSourceAdapter } from "@/api/handlers/case-law/ingestion/adapters/at-courts";
import { AT_LVWG_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-lvwg";
import { AT_UBAS_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-ubas";
import { AT_UMSE_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-umse";
import { AT_UVS_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-uvs";
import { AT_VERG_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-verg";
import { AT_VFGH_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-vfgh";
import { AT_VWGH_SOURCE } from "@/api/handlers/case-law/ingestion/adapters/at-vwgh";

import { requireReconciliation } from "./test-utils";

const SOURCES = [
  {
    source: AT_VFGH_SOURCE,
    id: "JFT_20260115_G00042_00",
    caseNumber: "G 42/2026",
    court: "Verfassungsgerichtshof (VfGH)",
    courtField: "Gericht",
    decisionDate: "2026-01-15",
  },
  {
    source: AT_VWGH_SOURCE,
    id: "JWT_2026010012_20260115X00",
    caseNumber: "Ra 2026/01/0012",
    court: "Verwaltungsgerichtshof (VwGH)",
    courtField: "Gericht",
    decisionDate: "2026-01-15",
  },
  {
    source: AT_BVWG_SOURCE,
    id: "BVWGT_20260115_W221_2345678_1_00",
    caseNumber: "W221 2345678-1",
    court: "Bundesverwaltungsgericht",
    courtField: "Gericht",
    decisionDate: "2026-01-15",
  },
  {
    source: AT_LVWG_SOURCE,
    id: "LVWGT_WI_20260115_VGW_001_001_2026_00",
    caseNumber: "VGW-001/001/2026",
    court: "Verwaltungsgericht Wien",
    courtField: "Gericht",
    decisionDate: "2026-01-15",
  },
  {
    source: AT_ASYLGH_SOURCE,
    id: "ASYLGHT_20131211_E1_436234_1_2013_00",
    caseNumber: "E1 436234-1/2013",
    court: "Asylgerichtshof",
    courtField: "Gericht",
    decisionDate: "2013-12-11",
  },
  {
    source: AT_UBAS_SOURCE,
    id: "UBAST_20080627_319_718_1_III_12_08_00",
    caseNumber: "319.718-1/III/12/08",
    court: "Unabhängiger Bundesasylsenat",
    courtField: "EntscheidendeBehoerde",
    decisionDate: "2008-06-27",
  },
  {
    source: AT_UVS_SOURCE,
    id: "JUT_WI_20131217_06FM463_2013_00",
    caseNumber: "06/FM/46/3/2013",
    court: "Unabhängiger Verwaltungssenat Wien",
    courtField: "EntscheidendeBehoerde",
    decisionDate: "2013-12-17",
  },
  {
    source: AT_VERG_SOURCE,
    id: "VERGT_20131219_N_0117_BVA_11_2013_00",
    caseNumber: "N/0117-BVA/11/2013",
    court: "Bundesvergabeamt",
    courtField: "EntscheidendeBehoerde",
    decisionDate: "2013-12-19",
  },
  {
    source: AT_UMSE_SOURCE,
    id: "UMSET_20131202_US_4B_2013_8_00",
    caseNumber: "US 4B/2013/8",
    court: "Umweltsenat",
    courtField: "EntscheidendeBehoerde",
    decisionDate: "2013-12-02",
  },
  {
    source: AT_BKS_SOURCE,
    id: "BKST_20131211_611_997_0001_BKS_2013_00",
    caseNumber: "611.997/0001-BKS/2013",
    court: "Bundeskommunikationssenat",
    courtField: "EntscheidendeBehoerde",
    decisionDate: "2013-12-11",
  },
] as const;

const xmlFixture = async (): Promise<string> =>
  await Bun.file(
    new URL("../parsers/__fixtures__/at-ris-jjt-1925.xml", import.meta.url),
  ).text();

const documentUrl = (application: string, id: string, extension: string) =>
  `https://www.ris.bka.gv.at/Dokumente/${application}/${id}/${id}.${extension}`;

const listingResponse = ({
  application,
  caseNumber,
  court,
  courtField,
  decisionDate,
  id,
}: {
  application: string;
  caseNumber: string;
  court: string;
  courtField: "EntscheidendeBehoerde" | "Gericht";
  decisionDate: string;
  id: string;
}): Response =>
  Response.json({
    OgdSearchResult: {
      OgdDocumentResults: {
        Hits: { "@pageNumber": "1", "@pageSize": "100", "#text": "1" },
        OgdDocumentReference: {
          Data: {
            Metadaten: {
              Technisch: { ID: id, Applikation: application, Organ: court },
              Allgemein: {
                DokumentUrl: `https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=${application}&Dokumentnummer=${id}`,
              },
              Judikatur: {
                Dokumenttyp: "Text",
                Geschaeftszahl: { item: caseNumber },
                Entscheidungsdatum: decisionDate,
                EuropeanCaseLawIdentifier: "ECLI:AT:TEST:2026:RIS.001",
                [application]: {
                  [courtField]: court,
                  Entscheidungsart: "Erkenntnis",
                },
              },
            },
            Dokumentliste: {
              ContentReference: {
                Urls: {
                  ContentUrl: [
                    {
                      DataType: "Xml",
                      Url: documentUrl(application, id, "xml"),
                    },
                    {
                      DataType: "Html",
                      Url: documentUrl(application, id, "html"),
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  });

describe("Austrian official RIS court sources", () => {
  it("uses each publisher application, identity, metadata branch, and path", async () => {
    const xml = await xmlFixture();

    for (const {
      source,
      id,
      caseNumber,
      court,
      courtField,
      decisionDate,
    } of SOURCES) {
      const urls: string[] = [];
      const responses = [
        listingResponse({
          application: source.application,
          caseNumber,
          court,
          courtField,
          decisionDate,
          id,
        }),
        new Response(xml),
      ];
      const adapter = createAtRisSourceAdapter(source, {
        now: () => new Date("2026-02-01T00:00:00Z"),
        request: async (url) => {
          urls.push(url);
          const response = responses.shift();
          if (response === undefined) {
            throw new Error(`Unexpected RIS request: ${url}`);
          }
          return response;
        },
        sleep: async () => {},
      });

      const result = await adapter.fetchPage(null, {});
      expect(result.isOk()).toBe(true);
      const decision = result.unwrap().decisions.at(0);
      expect(decision?.sourceDocumentId).toBe(id);
      expect(decision?.caseNumber).toBe(caseNumber);
      expect(decision?.court).toBe(court);
      expect(decision?.decisionType).toBe("erkenntnis");
      expect(new URL(urls.at(0) ?? "").searchParams.get("Applikation")).toBe(
        source.application,
      );
      expect(urls.at(1)).toBe(documentUrl(source.application, id, "xml"));
    }
  });

  it("parks the closed AsylGH archive at its publisher terminal month", () => {
    const adapter = createAtRisSourceAdapter(AT_ASYLGH_SOURCE, {
      now: () => new Date("2026-08-12T00:00:00Z"),
    });
    const reconciliation = requireReconciliation(adapter);
    expect(reconciliation.sliceOf(new Date())).toBe("2013-12");
    expect(reconciliation.nextSlice("2013-12")).toBeNull();
  });
});
