import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";

/**
 * Slovak Courts adapter.
 *
 * Fetches decisions from the obcan.justice.sk REST API.
 * Page-based pagination (0-indexed, 25 items per page).
 *
 * Cursor format: page number as string (e.g. "0", "1").
 */

const BASE_URL =
  "https://obcan.justice.sk/pilot/api/ress-isu-service/v1/rozhodnutie";
const PAGE_SIZE = 25;

const hashResult = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
};

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

/**
 * Parse the Slovak date format "DD.MM.YYYY" to ISO
 * "YYYY-MM-DD".
 */
const SK_DATE_PATTERN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

const parseSkDate = (raw: string | undefined): string | undefined => {
  if (!raw) {
    return;
  }
  const match = raw.match(SK_DATE_PATTERN);
  if (!match) {
    // biome-ignore lint/suspicious/noConsole: adapter logging
    console.error(`SK Courts adapter: unexpected date format: "${raw}"`);
    return;
  }
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
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
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    // biome-ignore lint/suspicious/noConsole: adapter logging
    console.error(`SK Courts detail error for ${guid}: ${response.status}`);
    return null;
  }

  return response.json() as Promise<SkDetailItem>;
};

const sourceUrlForGuid = (guid: string): string => {
  const docId = guid.split(":").at(-1);
  return docId
    ? `https://obcan.justice.sk/infosud/-/infosud/i-detail/rozhodnutie/${docId}`
    : `${BASE_URL}/${encodeURIComponent(guid)}`;
};

const parseItem = (
  item: SkApiItem,
  detail: SkDetailItem | null,
): IngestionResult | null => {
  if (!item.spisovaZnacka || !item.sud?.nazov) {
    return null;
  }

  // Hash only the list-endpoint payload so the change-detection
  // key stays stable regardless of transient detail-fetch failures.
  const raw = JSON.stringify(item);

  return {
    caseNumber: item.spisovaZnacka,
    ecli: detail?.ecli,
    court: item.sud.nazov,
    country: "SVK",
    language: "sk",
    decisionDate: parseSkDate(item.datumVydania),
    decisionType: item.formaRozhodnutia,
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
    rawHash: hashResult(raw),
  };
};

export const skCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.SK_COURTS,
  name: "Slovak Courts",
  country: "SVK",
  language: "sk",
  minRequestIntervalMs: 2000,

  async fetchPage(cursor, _config, signal): Promise<SyncPage> {
    const page = cursor ? Number.parseInt(cursor, 10) : 0;
    if (Number.isNaN(page)) {
      throw new Error(`SK Courts adapter: invalid cursor "${cursor}"`);
    }

    const params = new URLSearchParams({
      page: String(page),
      size: String(PAGE_SIZE),
      sortProperty: "datumVydania",
      sortDirection: "DESC",
    });

    const url = `${BASE_URL}?${params}`;

    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`SK Courts API error: ${response.status}`);
    }

    const data: SkApiResponse = await response.json();
    const items = data.rozhodnutieList ?? [];
    const decisions: IngestionResult[] = [];

    for (const item of items) {
      const detail = item.guid ? await fetchDetail(item.guid, signal) : null;

      const parsed = parseItem(item, detail);
      if (parsed) {
        decisions.push(parsed);
      }
    }

    const total = data.numFound;
    const fetched = page * PAGE_SIZE + items.length;
    const nextCursor =
      items.length >= PAGE_SIZE && (total == null || fetched < total)
        ? String(page + 1)
        : null;

    return { decisions, nextCursor };
  },
};
