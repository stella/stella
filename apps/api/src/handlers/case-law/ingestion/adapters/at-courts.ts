import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
} from "@/api/handlers/case-law/consts";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createPagePaginatedFetch } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import {
  isArrayOf,
  isNullishOneOrArrayOf,
  isNullishString,
  isNullishValue,
  hashContent,
  stripHtml,
  toOptionalValue,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Austrian Courts adapter (RIS Judikatur).
 *
 * Fetches court decisions from the RIS Open Government
 * Data API (data.bka.gv.at). The API returns JSON with
 * structured metadata and direct links to fulltext in
 * HTML, XML, RTF, and PDF formats. No authentication
 * required.
 *
 * Cursor format: item offset as string (e.g. "offset:20").
 * Each page fetches PAGE_SIZE items.
 */

const API_URL = "https://data.bka.gv.at/ris/api/v2.6/Judikatur";
/** RIS API enforces a maximum page size of 20. */
const PAGE_SIZE = 20;

type RisContentUrl = {
  DataType?: string | null;
  Url?: string | null;
};

type RisEntscheidungstext = {
  Geschaeftszahl?: string | null;
  Dokumenttyp?: string | null;
  Gericht?: string | null;
  Entscheidungsart?: string | null;
  Entscheidungsdatum?: string | null;
  DokumentUrl?: string | null;
};

type RisJustiz = {
  Rechtsgebiete?: { item?: string | string[] | null } | null;
  Gericht?: string | null;
  Rechtssatznummern?: {
    item?: string | string[] | null;
  } | null;
  Entscheidungstexte?: {
    item?: RisEntscheidungstext | RisEntscheidungstext[] | null;
  } | null;
};

type RisJudikatur = {
  Dokumenttyp?: string | null;
  Geschaeftszahl?: { item?: string | string[] | null } | null;
  Normen?: { item?: string | string[] | null } | null;
  Entscheidungsdatum?: string | null;
  EuropeanCaseLawIdentifier?: string | null;
  Justiz?: RisJustiz | null;
};

type RisMetadaten = {
  Technisch?: {
    ID?: string | null;
    Applikation?: string | null;
    Organ?: string | null;
  } | null;
  Allgemein?: {
    Veroeffentlicht?: string | null;
    Geaendert?: string | null;
    DokumentUrl?: string | null;
  } | null;
  Judikatur?: RisJudikatur | null;
};

type RisDocumentReference = {
  Data?: {
    Metadaten?: RisMetadaten | null;
    Dokumentliste?: {
      ContentReference?: {
        Urls?: {
          ContentUrl?: RisContentUrl[] | RisContentUrl | null;
        } | null;
      } | null;
    } | null;
  } | null;
};

type RisApiResponse = {
  OgdSearchResult?: {
    OgdDocumentResults?: {
      Hits?: {
        "@pageNumber"?: string | null;
        "@pageSize"?: string | null;
        "#text"?: string | null;
      } | null;
      OgdDocumentReference?:
        | RisDocumentReference[]
        | RisDocumentReference
        | null;
    } | null;
  } | null;
};

const isOptionalStringList = (
  value: unknown,
): value is string | string[] | null | undefined =>
  value === undefined ||
  value === null ||
  typeof value === "string" ||
  isArrayOf(value, (item): item is string => typeof item === "string");

const isRisContentUrl = (value: unknown): value is RisContentUrl =>
  isRecord(value) &&
  isNullishString(value["DataType"]) &&
  isNullishString(value["Url"]);

const isRisEntscheidungstext = (
  value: unknown,
): value is RisEntscheidungstext =>
  isRecord(value) &&
  isNullishString(value["Geschaeftszahl"]) &&
  isNullishString(value["Dokumenttyp"]) &&
  isNullishString(value["Gericht"]) &&
  isNullishString(value["Entscheidungsart"]) &&
  isNullishString(value["Entscheidungsdatum"]) &&
  isNullishString(value["DokumentUrl"]);

const isRisStringItems = (
  value: unknown,
): value is { item?: string | string[] | null } =>
  isRecord(value) && isOptionalStringList(value["item"]);

const isRisEntscheidungstextItems = (
  value: unknown,
): value is {
  item?: RisEntscheidungstext | RisEntscheidungstext[] | null;
} =>
  isRecord(value) &&
  isNullishOneOrArrayOf(value["item"], isRisEntscheidungstext);

const isRisJustiz = (value: unknown): value is RisJustiz =>
  isRecord(value) &&
  isNullishValue(value["Rechtsgebiete"], isRisStringItems) &&
  isNullishString(value["Gericht"]) &&
  isNullishValue(value["Rechtssatznummern"], isRisStringItems) &&
  isNullishValue(value["Entscheidungstexte"], isRisEntscheidungstextItems);

const isRisJudikatur = (value: unknown): value is RisJudikatur =>
  isRecord(value) &&
  isNullishString(value["Dokumenttyp"]) &&
  isNullishValue(value["Geschaeftszahl"], isRisStringItems) &&
  isNullishValue(value["Normen"], isRisStringItems) &&
  isNullishString(value["Entscheidungsdatum"]) &&
  isNullishString(value["EuropeanCaseLawIdentifier"]) &&
  isNullishValue(value["Justiz"], isRisJustiz);

const isRisMetadaten = (value: unknown): value is RisMetadaten =>
  isRecord(value) &&
  isNullishValue(
    value["Technisch"],
    (technical): technical is NonNullable<RisMetadaten["Technisch"]> =>
      isRecord(technical) &&
      isNullishString(technical["ID"]) &&
      isNullishString(technical["Applikation"]) &&
      isNullishString(technical["Organ"]),
  ) &&
  isNullishValue(
    value["Allgemein"],
    (general): general is NonNullable<RisMetadaten["Allgemein"]> =>
      isRecord(general) &&
      isNullishString(general["Veroeffentlicht"]) &&
      isNullishString(general["Geaendert"]) &&
      isNullishString(general["DokumentUrl"]),
  ) &&
  isNullishValue(value["Judikatur"], isRisJudikatur);

const isRisUrls = (
  value: unknown,
): value is { ContentUrl?: RisContentUrl[] | RisContentUrl | null } =>
  isRecord(value) &&
  isNullishOneOrArrayOf(value["ContentUrl"], isRisContentUrl);

const isRisContentReference = (
  value: unknown,
): value is {
  Urls?: { ContentUrl?: RisContentUrl[] | RisContentUrl | null } | null;
} => isRecord(value) && isNullishValue(value["Urls"], isRisUrls);

const isRisDokumentliste = (
  value: unknown,
): value is {
  ContentReference?: {
    Urls?: {
      ContentUrl?: RisContentUrl[] | RisContentUrl | null;
    } | null;
  } | null;
} =>
  isRecord(value) &&
  isNullishValue(value["ContentReference"], isRisContentReference);

const isRisData = (
  value: unknown,
): value is {
  Metadaten?: RisMetadaten | null;
  Dokumentliste?: {
    ContentReference?: {
      Urls?: {
        ContentUrl?: RisContentUrl[] | RisContentUrl | null;
      } | null;
    } | null;
  } | null;
} =>
  isRecord(value) &&
  isNullishValue(value["Metadaten"], isRisMetadaten) &&
  isNullishValue(value["Dokumentliste"], isRisDokumentliste);

const isRisDocumentReference = (
  value: unknown,
): value is RisDocumentReference =>
  isRecord(value) && isNullishValue(value["Data"], isRisData);

const isRisApiResponse = (value: unknown): value is RisApiResponse =>
  isRecord(value) &&
  isNullishValue(
    value["OgdSearchResult"],
    (
      searchResult,
    ): searchResult is NonNullable<RisApiResponse["OgdSearchResult"]> =>
      isRecord(searchResult) &&
      isNullishValue(
        searchResult["OgdDocumentResults"],
        (
          documentResults,
        ): documentResults is NonNullable<
          NonNullable<RisApiResponse["OgdSearchResult"]>["OgdDocumentResults"]
        > =>
          isRecord(documentResults) &&
          isNullishValue(
            documentResults["Hits"],
            (
              hits,
            ): hits is NonNullable<
              NonNullable<
                NonNullable<
                  RisApiResponse["OgdSearchResult"]
                >["OgdDocumentResults"]
              >["Hits"]
            > =>
              isRecord(hits) &&
              isNullishString(hits["@pageNumber"]) &&
              isNullishString(hits["@pageSize"]) &&
              isNullishString(hits["#text"]),
          ) &&
          isNullishOneOrArrayOf(
            documentResults["OgdDocumentReference"],
            isRisDocumentReference,
          ),
      ),
  );

/** Normalize item fields that can be string or string[]. */
const toArray = (
  val: string | readonly string[] | undefined | null,
): string[] => {
  if (val === undefined || val === null) {
    return [];
  }
  if (typeof val === "string") {
    return [val];
  }
  return [...val];
};

/** Find the HTML fulltext URL from content URLs. */
const findHtmlUrl = (doc: RisDocumentReference): string | undefined => {
  const raw = doc.Data?.Dokumentliste?.ContentReference?.Urls?.ContentUrl;
  if (!raw) {
    return undefined;
  }
  const urls = Array.isArray(raw) ? raw : [raw];
  return toOptionalValue(urls.find((u) => u.DataType === "Html")?.Url);
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
      // eslint-disable-next-line no-console -- adapter diagnostic
      console.warn(
        "AT Courts: fulltext fetch failed",
        response.status,
        htmlUrl,
      );
      return undefined;
    }

    const html = await response.text();
    return stripHtml(html);
  } catch (error) {
    // Re-throw abort/timeout so pipeline detects
    // cancellation.
    if (error instanceof DOMException) {
      throw error;
    }
    return undefined;
  }
};

/** Extract Entscheidungsart from the first Entscheidungstext. */
const extractEntscheidungsart = (
  justiz: RisJustiz | null | undefined,
): string | undefined => {
  if (!justiz?.Entscheidungstexte?.item) {
    return undefined;
  }
  const items = Array.isArray(justiz.Entscheidungstexte.item)
    ? justiz.Entscheidungstexte.item
    : [justiz.Entscheidungstexte.item];
  return toOptionalValue(items[0]?.Entscheidungsart);
};

const parseRisItem = async (
  raw: unknown,
  signal?: AbortSignal,
): Promise<IngestionResult | null> => {
  if (!isRisDocumentReference(raw)) {
    return null;
  }
  const doc = raw;

  const meta = doc.Data?.Metadaten;
  const jud = meta?.Judikatur;
  const justiz = jud?.Justiz;

  const caseNumbers = toArray(jud?.Geschaeftszahl?.item);
  const caseNumber = caseNumbers.at(0);
  const court =
    toOptionalValue(justiz?.Gericht) ?? toOptionalValue(meta?.Technisch?.Organ);

  if (!caseNumber || !court) {
    return null;
  }

  const htmlUrl = findHtmlUrl(doc);
  const fulltext = htmlUrl ? await fetchFulltext(htmlUrl, signal) : undefined;

  const raw_ = JSON.stringify(doc.Data?.Metadaten);

  return {
    caseNumber,
    ecli: toOptionalValue(jud?.EuropeanCaseLawIdentifier),
    court,
    country: "AUT",
    language: "de",
    decisionDate: toOptionalValue(jud?.Entscheidungsdatum),
    decisionType: toOptionalValue(jud?.Dokumenttyp),
    fulltext,
    sourceUrl: toOptionalValue(meta?.Allgemein?.DokumentUrl),
    documentUrl: htmlUrl,
    metadata: {
      risId: toOptionalValue(meta?.Technisch?.ID),
      applikation: toOptionalValue(meta?.Technisch?.Applikation),
      normen: toArray(jud?.Normen?.item),
      rechtsgebiete: toArray(justiz?.Rechtsgebiete?.item),
      entscheidungsart: extractEntscheidungsart(justiz),
      additionalCaseNumbers:
        caseNumbers.length > 1 ? caseNumbers.slice(1) : undefined,
      published: toOptionalValue(meta?.Allgemein?.Veroeffentlicht),
      modified: toOptionalValue(meta?.Allgemein?.Geaendert),
    },
    rawHash: hashContent(raw_),
    parserVersion: PARSER_VERSION,
    // TODO: integrate court-specific parser for AST
    documentAst: EMPTY_AST,
    sourceRaw: undefined,
    sourceRawContentType: "text/html",
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
    legacyPageSize: PAGE_SIZE,

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
      return isRisApiResponse(json) ? json : {};
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
