import { Result } from "better-result";

import { ADAPTER_KEYS, ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  adapterCatch,
  hashContent,
  parseCeDate,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { captureError } from "@/api/lib/posthog";

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
    captureError(new Error("SK Courts adapter: unexpected date format"), {
      adapter: "sk-courts",
    });
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
    captureError(new Error("SK Courts detail fetch failed"), {
      adapter: "sk-courts",
      httpStatus: String(response.status),
    });
    return null;
  }

  const json: unknown = await response.json();
  if (typeof json !== "object" || json === null) {
    return null;
  }
  // SAFETY: structural check above confirms object; fields
  // are all optional so parseItem handles missing properties.
  return json as SkDetailItem;
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

  // Hash only the list-endpoint payload so the
  // change-detection key stays stable regardless of
  // transient detail-fetch failures.
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
    rawHash: hashContent(raw),
  };
};

export const skCourtsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.SK_COURTS,
  name: "Slovak Courts",
  country: "SVK",
  language: "sk",
  minRequestIntervalMs: 2000,

  fetchPage(cursor, _config, signal) {
    return Result.tryPromise({
      try: async () => {
        const page = cursor ? Number.parseInt(cursor, 10) : 0;
        if (Number.isNaN(page)) {
          throw new AdapterFetchError({
            message: "SK Courts adapter: invalid cursor format",
            adapterKey: ADAPTER_KEYS.SK_COURTS,
            cursor,
          });
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
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(ADAPTER_TIMEOUT.LIST),
              ])
            : AbortSignal.timeout(ADAPTER_TIMEOUT.LIST),
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          throw new AdapterFetchError({
            message: `SK Courts API error: ${response.status}`,
            adapterKey: ADAPTER_KEYS.SK_COURTS,
            cursor,
            httpStatus: response.status,
          });
        }

        const json: unknown = await response.json();
        // SAFETY: structural check confirms object; all
        // fields are optional so missing properties
        // degrade gracefully.
        const data: SkApiResponse =
          typeof json === "object" && json !== null
            ? (json as SkApiResponse)
            : {};
        const items = data.rozhodnutieList ?? [];
        const decisions: IngestionResult[] = [];

        for (const item of items) {
          const detail = item.guid
            ? await fetchDetail(item.guid, signal)
            : null;

          const parsed = parseItem(item, detail);
          if (parsed) {
            decisions.push(parsed);
          }
        }

        const total = data.numFound;
        const fetched = page * PAGE_SIZE + items.length;
        const nextCursor =
          items.length >= PAGE_SIZE &&
          (total === null || total === undefined || fetched < total)
            ? String(page + 1)
            : null;

        return { decisions, nextCursor };
      },
      catch: adapterCatch(ADAPTER_KEYS.SK_COURTS, cursor),
    });
  },
};
