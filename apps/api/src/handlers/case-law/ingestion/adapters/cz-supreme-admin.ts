import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import { hashContent } from "@/api/handlers/case-law/ingestion/adapters/utils";

/**
 * Czech Supreme Administrative Court adapter.
 *
 * Uses the JSON POST API at vyhledavac.nssoud.cz. Results
 * are page-based (40 items per page) with rich metadata
 * including reporting judge, area of law, and applied
 * EU legislation.
 *
 * Cursor format: page number as string (e.g. "1", "2").
 */

const BASE_URL = "https://vyhledavac.nssoud.cz/Home/MyResTRowsCont";
const PAGE_SIZE = 40;

type NssoudApiItem = {
  SpisovaZnacka?: string;
  Ecli?: string;
  DatumRozhodnuti?: string;
  TypRozhodnuti?: string;
  SoudceZpravodaj?: string;
  OblastPrava?: string;
  AplikovanaZakonnaUstanoveni?: {
    Cislo?: string;
    Paragraf?: string;
  }[];
  AplikovanaUniiniPravniPredpis?: string[];
  Prejudikatura?: string[];
  PravniVeta?: string;
  OdkazNaText?: string;
};

const parseItem = (item: NssoudApiItem): IngestionResult | null => {
  if (!item.SpisovaZnacka) {
    return null;
  }

  const raw = JSON.stringify(item);

  return {
    caseNumber: item.SpisovaZnacka,
    ecli: item.Ecli,
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
    decisionDate: item.DatumRozhodnuti,
    decisionType: item.TypRozhodnuti,
    sourceUrl: item.OdkazNaText,
    documentUrl: item.OdkazNaText,
    metadata: {
      reportingJudge: item.SoudceZpravodaj,
      areaOfLaw: item.OblastPrava,
      appliedLegalProvisions: item.AplikovanaZakonnaUstanoveni,
      appliedEuLaw: item.AplikovanaUniiniPravniPredpis,
      prejudication: item.Prejudikatura,
      legalSentence: item.PravniVeta,
    },
    rawHash: hashContent(raw),
  };
};

export const czSupremeAdminAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.CZ_SUPREME_ADMIN,
  name: "Czech Supreme Administrative Court",
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 1500,

  fetchPage: createPagePaginatedFetch<NssoudApiItem[]>({
    adapterKey: ADAPTER_KEYS.CZ_SUPREME_ADMIN,
    pageSize: PAGE_SIZE,

    buildRequest: (page) => ({
      url: BASE_URL,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          Page: page,
          PageSize: PAGE_SIZE,
        }),
      },
    }),

    parseResponse: async (response) => {
      const json: unknown = await response.json();
      if (!Array.isArray(json)) {
        return [];
      }
      // SAFETY: Array.isArray guard above confirms array;
      // items are structurally checked by parseItem.
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      return json as NssoudApiItem[];
    },

    extractItems: (data) => ({
      items: data,
    }),

    // SAFETY: items come from extractItems which returns data (NssoudApiItem[]).
    parseItem: async (raw) =>
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      await Promise.resolve(parseItem(raw as NssoudApiItem)),
  }),
};
