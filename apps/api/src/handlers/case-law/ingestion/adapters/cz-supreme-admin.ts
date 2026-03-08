import { Result } from "better-result";

import { ADAPTER_KEYS, ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

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
  AplikovanaZakonnaUstanoveni?: Array<{
    Cislo?: string;
    Paragraf?: string;
  }>;
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

  fetchPage(cursor, _config, signal) {
    return Result.tryPromise({
      try: async () => {
        const page = cursor ? Number.parseInt(cursor, 10) : 1;

        const response = await fetch(BASE_URL, {
          method: "POST",
          signal: signal ?? AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            Page: page,
            PageSize: PAGE_SIZE,
          }),
        });

        if (!response.ok) {
          throw new AdapterFetchError({
            message: `CZ Supreme Admin API error: ${response.status}`,
            adapterKey: ADAPTER_KEYS.CZ_SUPREME_ADMIN,
            cursor,
            httpStatus: response.status,
          });
        }

        const json: unknown = await response.json();
        const data: NssoudApiItem[] = Array.isArray(json) ? json : [];
        const decisions: IngestionResult[] = [];

        for (const item of data) {
          const parsed = parseItem(item);
          if (parsed) {
            decisions.push(parsed);
          }
        }

        const nextCursor = data.length >= PAGE_SIZE ? String(page + 1) : null;

        return { decisions, nextCursor };
      },
      catch: adapterCatch(ADAPTER_KEYS.CZ_SUPREME_ADMIN, cursor),
    });
  },
};
