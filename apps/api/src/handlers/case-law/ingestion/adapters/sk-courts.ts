import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import {
  hashContent,
  parseCeDate,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseSkDecisionPdf } from "@/api/handlers/case-law/ingestion/parsers/sk-courts";

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
  dokument?: SkDokument & { size?: number };
  updateDate?: string;
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
    // eslint-disable-next-line no-console -- adapter diagnostic
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
    // eslint-disable-next-line no-console -- adapter diagnostic
    console.warn(`SK Courts detail fetch failed: ${response.status}`, guid);
    return null;
  }

  const json: unknown = await response.json();
  if (typeof json !== "object" || json === null) {
    return null;
  }
  // SAFETY: structural check above confirms object; fields
  // are all optional so parseItem handles missing properties.
  return json as SkDetailItem; // eslint-disable-line typescript-eslint/no-unsafe-type-assertion, typescript/consistent-type-assertions
};

/**
 * Fetch a PDF from the SK courts document endpoint.
 * Returns raw bytes for @libpdf/core parsing.
 */
const fetchPdfBytes = async (
  documentUrl: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> => {
  try {
    const response = await fetch(documentUrl, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return undefined;
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return undefined;
  }
};

/**
 * Build the public source URL for a decision.
 *
 * The infosud viewer (obcan.justice.sk/infosud/...) is a
 * Liferay portlet that frequently returns "item not found"
 * for valid decisions. Use the direct PDF content URL
 * instead — it's always available and is the actual document.
 */
const sourceUrlForDecision = (
  guid: string,
  documentUrl: string | undefined,
): string => documentUrl ?? `${BASE_URL}/${encodeURIComponent(guid)}`;

const parseItemWithDetail = async (
  raw: unknown,
  signal?: AbortSignal,
): Promise<IngestionResult | null> => {
  // SAFETY: items come from extractItems which returns
  // data.rozhodnutieList (SkApiItem[]); all fields are
  // optional so missing properties degrade gracefully.
  const item = raw as SkApiItem; // eslint-disable-line typescript-eslint/no-unsafe-type-assertion, typescript/consistent-type-assertions

  if (!item.spisovaZnacka || !item.sud?.nazov) {
    return null;
  }

  const detail = item.guid ? await fetchDetail(item.guid, signal) : null;

  // Fetch PDF bytes for parsing
  const pdfBytes = detail?.dokument?.url
    ? await fetchPdfBytes(detail.dokument.url, signal)
    : undefined;

  // Hash only the list-endpoint payload so the
  // change-detection key stays stable regardless of
  // transient detail-fetch failures.
  const rawJson = JSON.stringify(item);

  const caseNumber = item.spisovaZnacka;
  const decisionDate = parseSkDate(item.datumVydania);
  const decisionType = item.formaRozhodnutia;
  const court = item.sud.nazov;
  const ecli = detail?.ecli;

  // Parse PDF into structured AST using @libpdf/core
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- AST container
  let documentAst: DocumentAst | EmptyAst = EMPTY_AST;
  let fulltext: string | undefined;

  if (pdfBytes) {
    try {
      const parsed = await parseSkDecisionPdf({
        pdfBytes,
        caseNumber,
        ecli,
        court,
        decisionDate,
        decisionType: decisionType?.toLowerCase(),
      });
      documentAst = parsed.documentAst;
      fulltext = parsed.fulltext;
    } catch {
      // Parser failed; keep empty AST + no fulltext
    }
  }

  return {
    caseNumber,
    ecli,
    court,
    country: "SVK",
    language: "sk",
    decisionDate,
    decisionType,
    fulltext,
    sourceUrl: item.guid
      ? sourceUrlForDecision(item.guid, detail?.dokument?.url)
      : undefined,
    documentUrl: detail?.dokument?.url,
    metadata: {
      caseNumber,
      ecli,
      court,
      decisionDate,
      decisionType,
      guid: item.guid,
      identifikacneCislo: item.identifikacneCislo,
      judge: item.sudca?.meno,
      judgeRegistreGuid: item.sudca?.registreGuid,
      courtRegistreGuid: item.sud?.registreGuid,
      decisionNature: item.povaha,
      subArea: detail?.podOblast,
      referencedLegislation: detail?.odkazovanePredpisy,
      documentName: detail?.dokument?.name,
      documentExtension: detail?.dokument?.fileExtension,
      documentSize: detail?.dokument?.size,
      updateDate: detail?.updateDate,
    },
    rawHash: hashContent(rawJson),
    parserVersion: PARSER_VERSION,
    documentAst,
    sourceRaw: JSON.stringify({ listItem: item, detail }),
    sourceRawBytes: pdfBytes,
    sourceRawContentType: pdfBytes ? "application/pdf" : "application/json",
  };
};

export const skCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.SK_COURTS,
  name: "obcan.justice.sk",
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
        ? (json as SkApiResponse) // eslint-disable-line typescript-eslint/no-unsafe-type-assertion, typescript/consistent-type-assertions
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
