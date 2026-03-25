import { extractText as extractPdfText } from "unpdf";

import { ADAPTER_KEYS, ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import {
  hashContent,
  parseCeDate,
} from "@/api/handlers/case-law/ingestion/adapters/utils";

/**
 * Slovak Courts adapter.
 *
 * Fetches decisions from the obcan.justice.sk REST API.
 * Page-based pagination (0-indexed, 25 items per page).
 *
 * Each list item is enriched with a detail fetch for
 * ECLI, document URL, and referenced legislation.
 *
 * Cursor format: page number as string (e.g. "0", "1").
 */

const BASE_URL =
  "https://obcan.justice.sk/pilot/api/ress-isu-service/v1/rozhodnutie";
const PAGE_SIZE = 25;

type SkSud = {
  registreGuid?: string;
  nazov?: string;
};

type SkSudca = {
  registreGuid?: string;
  meno?: string;
};

type SkApiItem = {
  guid?: string;
  spisovaZnacka?: string;
  identifikacneCislo?: string;
  sud?: SkSud;
  sudca?: SkSudca;
  datumVydania?: string;
  formaRozhodnutia?: string;
  povaha?: string[];
};

type SkDokument = {
  name?: string;
  fileExtension?: string;
  url?: string;
};

type SkOdkazovanyPredpis = {
  nazov?: string;
  url?: string;
};

type SkDetailItem = SkApiItem & {
  ecli?: string;
  podOblast?: string[];
  odkazovanePredpisy?: SkOdkazovanyPredpis[];
  dokument?: SkDokument;
};

type SkApiResponse = {
  rozhodnutieList?: SkApiItem[];
  numFound?: number;
};

/** Parse Slovak date "DD.MM.YYYY" to ISO "YYYY-MM-DD". */
const parseSkDate = (raw: string | undefined): string | undefined => {
  if (!raw) {
    return;
  }
  const result = parseCeDate(raw);
  if (!result) {
    console.warn("SK Courts adapter: unexpected date format", raw);
  }
  return result;
};

/**
 * Fetch full detail for a single decision (includes ECLI,
 * document URL, and referenced legislation).
 */
const fetchDetail = async (
  guid: string,
  signal?: AbortSignal,
): Promise<SkDetailItem | null> => {
  const url = `${BASE_URL}/${encodeURIComponent(guid)}`;
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST)])
      : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    console.warn(`SK Courts detail fetch failed: ${response.status}`, guid);
    return null;
  }

  const json: unknown = await response.json();
  if (typeof json !== "object" || json === null) {
    return null;
  }
  // SAFETY: structural check above confirms object; fields
  // are all optional so parseItem handles missing properties.
  return json as SkDetailItem; // eslint-disable-line typescript-eslint/no-unsafe-type-assertion
};

/**
 * Fetch a PDF from the SK courts document endpoint and extract
 * text using unpdf. Returns undefined on any failure.
 */
const fetchPdfFulltext = async (
  documentUrl: string,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  try {
    const response = await fetch(documentUrl, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (!response.ok) return undefined;

    const buffer = new Uint8Array(await response.arrayBuffer());
    const result = await extractPdfText(buffer, { mergePages: true });
    const text = result.text?.trim();
    return text && text.length > 100 ? text : undefined;
  } catch {
    return undefined;
  }
};

const sourceUrlForGuid = (guid: string): string => {
  const docId = guid.split(":").at(-1);
  return docId
    ? `https://obcan.justice.sk/infosud/-/infosud/i-detail/rozhodnutie/${docId}`
    : `${BASE_URL}/${encodeURIComponent(guid)}`;
};

const parseItemWithDetail = async (
  raw: unknown,
  signal?: AbortSignal,
): Promise<IngestionResult | null> => {
  // SAFETY: items come from extractItems which returns
  // data.rozhodnutieList (SkApiItem[]); all fields are
  // optional so missing properties degrade gracefully.
  const item = raw as SkApiItem; // eslint-disable-line typescript-eslint/no-unsafe-type-assertion

  if (!item.spisovaZnacka || !item.sud?.nazov) {
    return null;
  }

  const detail = item.guid ? await fetchDetail(item.guid, signal) : null;

  // Fetch fulltext from the PDF document
  const fulltext = detail?.dokument?.url
    ? await fetchPdfFulltext(detail.dokument.url, signal)
    : undefined;

  // Hash only the list-endpoint payload so the
  // change-detection key stays stable regardless of
  // transient detail-fetch failures.
  const rawJson = JSON.stringify(item);

  return {
    caseNumber: item.spisovaZnacka,
    ecli: detail?.ecli,
    court: item.sud.nazov,
    country: "SVK",
    language: "sk",
    decisionDate: parseSkDate(item.datumVydania),
    decisionType: item.formaRozhodnutia,
    fulltext,
    sourceUrl: item.guid ? sourceUrlForGuid(item.guid) : undefined,
    documentUrl: detail?.dokument?.url,
    metadata: {
      guid: item.guid,
      identifikacneCislo: item.identifikacneCislo,
      judge: item.sudca?.meno,
      decisionNature: item.povaha?.join(", "),
      subArea: detail?.podOblast,
      referencedLegislation: detail?.odkazovanePredpisy,
    },
    rawHash: hashContent(rawJson),
  };
};

export const skCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.SK_COURTS,
  name: "Slovak Courts",
  country: "SVK",
  language: "sk",
  minRequestIntervalMs: 300,

  fetchPage: createPagePaginatedFetch<SkApiResponse>({
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    pageSize: PAGE_SIZE,
    zeroIndexed: true,

    buildRequest: (page) => ({
      url: `${BASE_URL}?${new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
        sortProperty: "datumVydania",
        sortDirection: "DESC",
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
      return typeof json === "object" && json !== null
        ? (json as SkApiResponse) // eslint-disable-line typescript-eslint/no-unsafe-type-assertion
        : {};
    },

    extractItems: (data) => ({
      items: data.rozhodnutieList ?? [],
      total: data.numFound,
    }),

    // SAFETY: parseItemWithDetail accepts unknown as first
    // arg via the SkApiItem cast inside it; signature
    // matches PagePaginationOptions["parseItem"].
    parseItem: parseItemWithDetail,
  }),
};
