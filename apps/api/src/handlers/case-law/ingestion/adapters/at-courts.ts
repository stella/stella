import { ADAPTER_KEYS, ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import {
  hashContent,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";

/**
 * Austrian Courts adapter (RIS Judikatur).
 *
 * Fetches court decisions from the RIS Open Government
 * Data API (data.bka.gv.at). The API returns JSON with
 * structured metadata and direct links to fulltext in
 * HTML, XML, RTF, and PDF formats. No authentication
 * required.
 *
 * Cursor format: page number as string (e.g. "1", "2").
 * Each page fetches PAGE_SIZE items.
 */

const API_URL = "https://data.bka.gv.at/ris/api/v2.6/Judikatur";
/** RIS API enforces a maximum page size of 20. */
const PAGE_SIZE = 20;

type RisContentUrl = {
  DataType?: string;
  Url?: string;
};

type RisEntscheidungstext = {
  Geschaeftszahl?: string;
  Dokumenttyp?: string;
  Gericht?: string;
  Entscheidungsart?: string;
  Entscheidungsdatum?: string;
  DokumentUrl?: string;
};

type RisJustiz = {
  Rechtsgebiete?: { item?: string | string[] };
  Gericht?: string;
  Rechtssatznummern?: {
    item?: string | string[];
  };
  Entscheidungstexte?: {
    item?: RisEntscheidungstext | RisEntscheidungstext[];
  };
};

type RisJudikatur = {
  Dokumenttyp?: string;
  Geschaeftszahl?: { item?: string | string[] };
  Normen?: { item?: string | string[] };
  Entscheidungsdatum?: string;
  EuropeanCaseLawIdentifier?: string;
  Justiz?: RisJustiz;
};

type RisMetadaten = {
  Technisch?: {
    ID?: string;
    Applikation?: string;
    Organ?: string;
  };
  Allgemein?: {
    Veroeffentlicht?: string;
    Geaendert?: string;
    DokumentUrl?: string;
  };
  Judikatur?: RisJudikatur;
};

type RisDocumentReference = {
  Data?: {
    Metadaten?: RisMetadaten;
    Dokumentliste?: {
      ContentReference?: {
        Urls?: {
          ContentUrl?: RisContentUrl[] | RisContentUrl;
        };
      };
    };
  };
};

type RisApiResponse = {
  OgdSearchResult?: {
    OgdDocumentResults?: {
      Hits?: {
        "@pageNumber"?: string;
        "@pageSize"?: string;
        "#text"?: string;
      };
      OgdDocumentReference?:
        | RisDocumentReference[]
        | RisDocumentReference
        | null;
    };
  };
};

/** Normalize item fields that can be string or string[]. */
const toArray = (val: string | string[] | undefined | null): string[] => {
  if (val === undefined || val === null) {
    return [];
  }
  return Array.isArray(val) ? val : [val];
};

/** Find the HTML fulltext URL from content URLs. */
const findHtmlUrl = (doc: RisDocumentReference): string | undefined => {
  const raw = doc.Data?.Dokumentliste?.ContentReference?.Urls?.ContentUrl;
  if (!raw) {
    return;
  }
  const urls = Array.isArray(raw) ? raw : [raw];
  return urls.find((u) => u.DataType === "Html")?.Url;
};

/** Fetch fulltext HTML and strip to plain text. */
const fetchFulltext = async (
  htmlUrl: string,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  try {
    const response = await fetch(htmlUrl, {
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
          ])
        : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
    });

    if (!response.ok) {
      console.warn(
        "AT Courts: fulltext fetch failed",
        response.status,
        htmlUrl,
      );
      return;
    }

    const html = await response.text();
    return stripHtml(html);
  } catch (error) {
    // Re-throw abort/timeout so pipeline detects
    // cancellation.
    if (error instanceof DOMException) {
      throw error;
    }
    return;
  }
};

/** Extract Entscheidungsart from the first Entscheidungstext. */
const extractEntscheidungsart = (
  justiz: RisJustiz | undefined,
): string | undefined => {
  if (!justiz?.Entscheidungstexte?.item) {
    return;
  }
  const items = Array.isArray(justiz.Entscheidungstexte.item)
    ? justiz.Entscheidungstexte.item
    : [justiz.Entscheidungstexte.item];
  return items[0]?.Entscheidungsart;
};

const parseRisItem = async (
  raw: unknown,
  signal?: AbortSignal,
): Promise<IngestionResult | null> => {
  // SAFETY: items come from extractItems which returns
  // OgdDocumentReference[].
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const doc = raw as RisDocumentReference;

  const meta = doc.Data?.Metadaten;
  const jud = meta?.Judikatur;
  const justiz = jud?.Justiz;

  const caseNumbers = toArray(jud?.Geschaeftszahl?.item);
  const caseNumber = caseNumbers.at(0);
  const court = justiz?.Gericht ?? meta?.Technisch?.Organ;

  if (!caseNumber || !court) {
    return null;
  }

  const htmlUrl = findHtmlUrl(doc);
  const fulltext = htmlUrl ? await fetchFulltext(htmlUrl, signal) : undefined;

  const raw_ = JSON.stringify(doc.Data?.Metadaten);

  return {
    caseNumber,
    ecli: jud?.EuropeanCaseLawIdentifier,
    court,
    country: "AUT",
    language: "de",
    decisionDate: jud?.Entscheidungsdatum,
    decisionType: jud?.Dokumenttyp,
    fulltext,
    sourceUrl: meta?.Allgemein?.DokumentUrl,
    documentUrl: htmlUrl,
    metadata: {
      risId: meta?.Technisch?.ID,
      applikation: meta?.Technisch?.Applikation,
      normen: toArray(jud?.Normen?.item),
      rechtsgebiete: toArray(justiz?.Rechtsgebiete?.item),
      entscheidungsart: extractEntscheidungsart(justiz),
      additionalCaseNumbers:
        caseNumbers.length > 1 ? caseNumbers.slice(1) : undefined,
      published: meta?.Allgemein?.Veroeffentlicht,
      modified: meta?.Allgemein?.Geaendert,
    },
    rawHash: hashContent(raw_),
  };
};

export const atCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.AT_COURTS,
  name: "Austrian Courts (RIS)",
  country: "AUT",
  language: "de",
  minRequestIntervalMs: 1000,
  pageTimeoutMs: 220_000,

  fetchPage: createPagePaginatedFetch<RisApiResponse>({
    adapterKey: ADAPTER_KEYS.AT_COURTS,
    pageSize: PAGE_SIZE,

    buildRequest: (page) => ({
      url: `${API_URL}?${new URLSearchParams({
        Seitennummer: String(page),
        Seitengroesse: String(PAGE_SIZE),
        Sortierung: "Aenderungsdatum",
        Aufsteigend: "false",
      }).toString()}`,
      init: {
        headers: { Accept: "application/json" },
      },
    }),

    parseResponse: async (response) => {
      const json: unknown = await response.json();
      // SAFETY: structural check confirms object; all
      // fields are optional so missing properties
      // degrade gracefully.
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      return typeof json === "object" && json !== null
        ? (json as RisApiResponse)
        : {};
    },

    extractItems: (data) => {
      const results = data.OgdSearchResult?.OgdDocumentResults;
      const rawTotal = results?.Hits?.["#text"]
        ? Number.parseInt(results.Hits["#text"], 10)
        : undefined;
      // Guard against NaN from malformed API response
      const total =
        rawTotal !== undefined && !Number.isNaN(rawTotal)
          ? rawTotal
          : undefined;
      // XML-to-JSON may return a single object instead
      // of an array when there's only one result.
      const ref = results?.OgdDocumentReference;
      const items =
        ref === null || ref === undefined
          ? []
          : Array.isArray(ref)
            ? ref
            : [ref];
      return { items, total };
    },

    parseItem: parseRisItem,
  }),
};
