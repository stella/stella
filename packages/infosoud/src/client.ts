import {
  DEFAULT_BASE_URL,
  DEFAULT_CASE_CACHE_TTL_MS,
  DEFAULT_COURTS_CACHE_TTL_MS,
  DEFAULT_DELAY_MS,
  DEFAULT_DERIVED_COURT_MAP_CACHE_TTL_MS,
  DEFAULT_EVENT_DETAIL_CACHE_TTL_MS,
  DEFAULT_EVENT_DETAIL_EVENT_TYPES,
  DEFAULT_HEARINGS_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  PRAGUE_DISTRICT_CODES,
} from "./constants.js";
import {
  buildCourtMapFromEntries,
  classifyCourtCode,
  resolveCourtCodeAlias,
  resolveCourtCode as resolveCourtCodeFromMap,
} from "./courts.js";
import {
  InfoSoudAPIError,
  InfoSoudParseError,
  InfoSoudRequestError,
} from "./errors.js";
import { enrichCaseEventWithDetail } from "./event-details.js";
import { parseSpisZn, toInfoSoudRequestBody } from "./spis-zn.js";
import type {
  CaseEvent,
  CaseEventLookupInput,
  CaseEventWithDetail,
  CaseMarkId,
  CaseSearchResult,
  CaseSearchResultWithDetails,
  CaseSearchResultWithHearings,
  CourtEntry,
  CourtMap,
  DistrictCourtsInput,
  EventAttribute,
  EventDetailInput,
  EventDetailResult,
  FetchLike,
  HearingEvent,
  HearingsSearchResult,
  InfoSoudCacheOptions,
  InfoSoudClientOptions,
  RelatedCase,
  SearchCaseInput,
  SearchCaseWithDetailsInput,
  SearchCaseWithHearingsInput,
  SearchHearingsInput,
  SpisZn,
} from "./types.js";

type JsonObject = Record<string, unknown>;
type CacheEntry = { expiresAt: number; value: unknown };
type CacheConfig = {
  caseTtlMs: number;
  courtsTtlMs: number;
  derivedCourtMapTtlMs: number;
  enabled: boolean;
  eventDetailTtlMs: number;
  hearingsTtlMs: number;
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertRecord = (value: unknown, context: string): JsonObject => {
  if (!isRecord(value)) {
    throw new InfoSoudParseError(`${context} must be an object`);
  }

  return value;
};

const assertArray = (value: unknown, context: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new InfoSoudParseError(`${context} must be an array`);
  }

  return value;
};

const readNumber = (
  record: JsonObject,
  key: string,
  context: string,
): number => {
  const value = record[key];
  if (typeof value !== "number") {
    throw new InfoSoudParseError(`${context}.${key} must be a number`);
  }

  return value;
};

const readString = (
  record: JsonObject,
  key: string,
  context: string,
): string => {
  const value = record[key];
  if (typeof value !== "string") {
    throw new InfoSoudParseError(`${context}.${key} must be a string`);
  }

  return value;
};

const readNullableBoolean = (
  record: JsonObject,
  key: string,
  context: string,
): boolean | null => {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "boolean") {
    throw new InfoSoudParseError(`${context}.${key} must be a boolean or null`);
  }

  return value;
};

const readNullableNumber = (
  record: JsonObject,
  key: string,
  context: string,
): number | null => {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number") {
    throw new InfoSoudParseError(`${context}.${key} must be a number or null`);
  }

  return value;
};

const readNullableString = (
  record: JsonObject,
  key: string,
  context: string,
): string | null => {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new InfoSoudParseError(`${context}.${key} must be a string or null`);
  }

  return value;
};

const parseCaseMarkId = (value: unknown, context: string): CaseMarkId => {
  const record = assertRecord(value, context);
  return {
    bcVec: readNumber(record, "bcVec", context),
    cisloSenatu: readNumber(record, "cisloSenatu", context),
    druhVeci: readString(record, "druhVeci", context),
    organizace: readString(record, "organizace", context),
    rocnik: readNumber(record, "rocnik", context),
  };
};

const parseRelatedCase = (value: unknown, context: string): RelatedCase => {
  const record = assertRecord(value, context);
  return {
    bcVec: readNumber(record, "bcVec", context),
    cisloSenatu: readNumber(record, "cisloSenatu", context),
    druhVeci: readString(record, "druhVeci", context),
    organizace: readString(record, "organizace", context),
    rocnik: readNumber(record, "rocnik", context),
  };
};

const parseCaseEvent = (value: unknown, context: string): CaseEvent => {
  const record = assertRecord(value, context);
  return {
    datum: readString(record, "datum", context),
    jednani: assertArray(record["jednani"] ?? [], `${context}.jednani`),
    poradi: readNumber(record, "poradi", context),
    udalost: readString(record, "udalost", context),
    udalostId: readNullableNumber(record, "udalostId", context),
    znackaId: parseCaseMarkId(record["znackaId"], `${context}.znackaId`),
    zruseno: (() => {
      const zruseno = record["zruseno"];
      if (typeof zruseno !== "boolean") {
        throw new InfoSoudParseError(`${context}.zruseno must be a boolean`);
      }
      return zruseno;
    })(),
  };
};

const parseHearingEvent = (value: unknown, context: string): HearingEvent => {
  const record = assertRecord(value, context);
  return {
    bcVec: readNullableNumber(record, "bcVec", context),
    cas: readString(record, "cas", context),
    cislo: readNullableNumber(record, "cislo", context),
    datum: readString(record, "datum", context),
    datumZapisuVysledku: readNullableString(
      record,
      "datumZapisuVysledku",
      context,
    ),
    druh: readNullableString(record, "druh", context),
    druhJednani: readNullableString(record, "druhJednani", context),
    jednaciSin: readNullableString(record, "jednaciSin", context),
    jednaniZruseno: readNullableBoolean(record, "jednaniZruseno", context),
    neverejneJednani: readNullableBoolean(record, "neverejneJednani", context),
    predmetJednani: readNullableString(record, "predmetJednani", context),
    resitel: readNullableString(record, "resitel", context),
    rocnik: readNullableNumber(record, "rocnik", context),
    vysledek: readNullableString(record, "vysledek", context),
  };
};

const parseEventAttribute = (
  value: unknown,
  context: string,
): EventAttribute => {
  const record = assertRecord(value, context);
  return {
    hodnota: readString(record, "hodnota", context),
    typ: readString(record, "typ", context),
  };
};

const parseCourtEntry = (value: unknown, context: string): CourtEntry => {
  const record = assertRecord(value, context);
  return {
    kod: readString(record, "kod", context),
    nazev: readString(record, "nazev", context),
  };
};

const parseCaseSearchResult = (value: unknown): CaseSearchResult => {
  const record = assertRecord(value, "CaseSearchResult");
  return {
    bcVec: readNumber(record, "bcVec", "CaseSearchResult"),
    cislo: readNumber(record, "cislo", "CaseSearchResult"),
    druh: readString(record, "druh", "CaseSearchResult"),
    nadrizenaOrganizace: readNullableString(
      record,
      "nadrizenaOrganizace",
      "CaseSearchResult",
    ),
    napad: record["napad"],
    navazneVeci: assertArray(
      record["navazneVeci"] ?? [],
      "CaseSearchResult.navazneVeci",
    ).map((item, index) =>
      parseRelatedCase(item, `CaseSearchResult.navazneVeci[${index}]`),
    ),
    organizace: readString(record, "organizace", "CaseSearchResult"),
    platneK: readNullableString(record, "platneK", "CaseSearchResult"),
    rocnik: readNumber(record, "rocnik", "CaseSearchResult"),
    stav: readNullableString(record, "stav", "CaseSearchResult"),
    stavDatum: readNullableString(record, "stavDatum", "CaseSearchResult"),
    typOrganizace: readString(record, "typOrganizace", "CaseSearchResult"),
    udalosti: assertArray(record["udalosti"], "CaseSearchResult.udalosti").map(
      (item, index) =>
        parseCaseEvent(item, `CaseSearchResult.udalosti[${index}]`),
    ),
  };
};

const parseHearingsSearchResult = (value: unknown): HearingsSearchResult => {
  const record = assertRecord(value, "HearingsSearchResult");
  return {
    bcVec: readNumber(record, "bcVec", "HearingsSearchResult"),
    cislo: readNumber(record, "cislo", "HearingsSearchResult"),
    datum: readNullableString(record, "datum", "HearingsSearchResult"),
    druh: readString(record, "druh", "HearingsSearchResult"),
    jednaciSin: readNullableString(
      record,
      "jednaciSin",
      "HearingsSearchResult",
    ),
    nadrizenaOrganizace: readNullableString(
      record,
      "nadrizenaOrganizace",
      "HearingsSearchResult",
    ),
    organizace: readString(record, "organizace", "HearingsSearchResult"),
    platneK: readNullableString(record, "platneK", "HearingsSearchResult"),
    rocnik: readNumber(record, "rocnik", "HearingsSearchResult"),
    typ: readString(record, "typ", "HearingsSearchResult"),
    udalosti: assertArray(
      record["udalosti"],
      "HearingsSearchResult.udalosti",
    ).map((item, index) =>
      parseHearingEvent(item, `HearingsSearchResult.udalosti[${index}]`),
    ),
  };
};

const parseEventDetailResult = (value: unknown): EventDetailResult => {
  const record = assertRecord(value, "EventDetailResult");
  return {
    atributy: assertArray(record["atributy"], "EventDetailResult.atributy").map(
      (item, index) =>
        parseEventAttribute(item, `EventDetailResult.atributy[${index}]`),
    ),
    bcVec: readNumber(record, "bcVec", "EventDetailResult"),
    cislo: readNumber(record, "cislo", "EventDetailResult"),
    datumUdalost: readNullableString(
      record,
      "datumUdalost",
      "EventDetailResult",
    ),
    druh: readString(record, "druh", "EventDetailResult"),
    nadrizenaOrganizace: readNullableString(
      record,
      "nadrizenaOrganizace",
      "EventDetailResult",
    ),
    napad: record["napad"],
    navazneVeci: assertArray(
      record["navazneVeci"] ?? [],
      "EventDetailResult.navazneVeci",
    ).map((item, index) =>
      parseRelatedCase(item, `EventDetailResult.navazneVeci[${index}]`),
    ),
    organizace: readString(record, "organizace", "EventDetailResult"),
    platneK: readNullableString(record, "platneK", "EventDetailResult"),
    rocnik: readNumber(record, "rocnik", "EventDetailResult"),
    stav: readNullableString(record, "stav", "EventDetailResult"),
    stavDatum: readNullableString(record, "stavDatum", "EventDetailResult"),
    typOrganizace: readString(record, "typOrganizace", "EventDetailResult"),
    typUdalosti: readString(record, "typUdalosti", "EventDetailResult"),
  };
};

const parseCourtEntries = (value: unknown): CourtEntry[] =>
  assertArray(value, "CourtEntry[]").map((item, index) =>
    parseCourtEntry(item, `CourtEntry[${index}]`),
  );

const parseCourtMap = (value: unknown): CourtMap => {
  const record = assertRecord(value, "CourtMap");
  const result: CourtMap = {};

  for (const [courtCode, courtName] of Object.entries(record)) {
    if (typeof courtName !== "string") {
      throw new InfoSoudParseError(`CourtMap.${courtCode} must be a string`);
    }

    result[courtCode] = courtName;
  }

  return result;
};

const parseErrorMessage = (
  body: unknown,
  status: number,
  path: string,
): string => {
  if (typeof body === "string" && body.trim()) {
    return body;
  }

  if (typeof body === "object" && body !== null && "message" in body) {
    const message = body.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return `InfoSoud request failed with ${status} for ${path}`;
};

const delay = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const withTimeoutSignal = (
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) {
    return timeoutSignal;
  }

  return AbortSignal.any([signal, timeoutSignal]);
};

const cloneData = <T>(value: T): T => structuredClone(value);
const toSpisZnFromCaseMarkId = ({
  bcVec,
  cisloSenatu,
  druhVeci,
  rocnik,
}: CaseMarkId): SpisZn => ({
  bcVec,
  cisloSenatu,
  druhVeci,
  rocnik,
});

const isSameCaseMark = (
  result: CaseSearchResult,
  event: Pick<CaseEvent, "znackaId">,
): boolean =>
  event.znackaId.cisloSenatu === result.cislo &&
  event.znackaId.druhVeci === result.druh &&
  event.znackaId.bcVec === result.bcVec &&
  event.znackaId.rocnik === result.rocnik;

const inferPrimaryCourtCode = (result: CaseSearchResult): string | null =>
  result.udalosti
    .find(
      (event) =>
        isSameCaseMark(result, event) &&
        event.znackaId.organizace.trim().length > 0,
    )
    ?.znackaId.organizace.trim() ?? null;

const createEmptyHearingsResult = (
  result: CaseSearchResult,
): HearingsSearchResult => ({
  bcVec: result.bcVec,
  cislo: result.cislo,
  datum: null,
  druh: result.druh,
  jednaciSin: null,
  nadrizenaOrganizace: result.nadrizenaOrganizace,
  organizace: result.organizace,
  platneK: result.platneK,
  rocnik: result.rocnik,
  typ: "SPZN",
  udalosti: [],
});

const buildCacheConfig = (
  options: false | InfoSoudCacheOptions | undefined,
): CacheConfig => {
  if (options === false) {
    return {
      caseTtlMs: 0,
      courtsTtlMs: 0,
      derivedCourtMapTtlMs: 0,
      enabled: false,
      eventDetailTtlMs: 0,
      hearingsTtlMs: 0,
    };
  }

  const cacheOptions = options ?? {};
  return {
    caseTtlMs: cacheOptions.caseTtlMs ?? DEFAULT_CASE_CACHE_TTL_MS,
    courtsTtlMs: cacheOptions.courtsTtlMs ?? DEFAULT_COURTS_CACHE_TTL_MS,
    derivedCourtMapTtlMs:
      cacheOptions.derivedCourtMapTtlMs ??
      DEFAULT_DERIVED_COURT_MAP_CACHE_TTL_MS,
    enabled: cacheOptions.enabled ?? true,
    eventDetailTtlMs:
      cacheOptions.eventDetailTtlMs ?? DEFAULT_EVENT_DETAIL_CACHE_TTL_MS,
    hearingsTtlMs: cacheOptions.hearingsTtlMs ?? DEFAULT_HEARINGS_CACHE_TTL_MS,
  };
};

type RequestArgs<T> = {
  body?: Record<string, string> | undefined;
  cacheKey?: string | undefined;
  cacheTtlMs?: number | undefined;
  method?: "GET" | "POST";
  parse: (value: unknown) => T;
  path: string;
  query?: URLSearchParams | undefined;
  signal?: AbortSignal | undefined;
};

export class InfoSoudClient {
  readonly #baseUrl: string;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #cacheConfig: CacheConfig;
  readonly #delayMs: number;
  readonly #fetchImpl: FetchLike;
  readonly #inFlightRequests = new Map<string, Promise<unknown>>();
  #lastRequestFinishedAt = 0;
  readonly #timeoutMs: number;
  readonly #userAgent: string;

  constructor(options: InfoSoudClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#cacheConfig = buildCacheConfig(options.cache);
    this.#delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.#fetchImpl = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async searchCase({
    courtCode,
    signal,
    spisZn,
  }: SearchCaseInput): Promise<CaseSearchResult> {
    const parsed = this.#parseInput(spisZn);
    const resolvedCourtCode = this.#resolveCourtCode(parsed, courtCode);
    const requestBody = toInfoSoudRequestBody(parsed, resolvedCourtCode);

    if (resolvedCourtCode && this.#isAmbiguousPragueCode(resolvedCourtCode)) {
      const pragueResult = await this.#searchAcrossPragueDistricts({
        parse: parseCaseSearchResult,
        path: "/rizeni/vyhledej",
        signal,
        spisZn: parsed,
      });
      return pragueResult;
    }

    const result = await this.#request({
      body: requestBody,
      cacheKey: this.#buildRequestCacheKey({
        body: requestBody,
        method: "POST",
        path: "/rizeni/vyhledej",
      }),
      cacheTtlMs: this.#cacheConfig.caseTtlMs,
      parse: parseCaseSearchResult,
      path: "/rizeni/vyhledej",
      signal,
    });
    return result;
  }

  async searchHearings({
    courtCode,
    signal,
    spisZn,
  }: SearchHearingsInput): Promise<HearingsSearchResult> {
    const parsed = this.#parseInput(spisZn);
    const resolvedCourtCode = this.#resolveCourtCode(parsed, courtCode);
    const requestBody = {
      ...toInfoSoudRequestBody(parsed, resolvedCourtCode),
      typHledani: "SPZN",
    };

    if (resolvedCourtCode && this.#isAmbiguousPragueCode(resolvedCourtCode)) {
      const pragueResult = await this.#searchAcrossPragueDistricts({
        extraBody: { typHledani: "SPZN" },
        parse: parseHearingsSearchResult,
        path: "/jednani/vyhledej",
        signal,
        spisZn: parsed,
      });
      return pragueResult;
    }

    const result = await this.#request({
      body: requestBody,
      cacheKey: this.#buildRequestCacheKey({
        body: requestBody,
        method: "POST",
        path: "/jednani/vyhledej",
      }),
      cacheTtlMs: this.#cacheConfig.hearingsTtlMs,
      parse: parseHearingsSearchResult,
      path: "/jednani/vyhledej",
      signal,
    });
    return result;
  }

  async searchCaseWithHearings({
    courtCode,
    signal,
    spisZn,
  }: SearchCaseWithHearingsInput): Promise<CaseSearchResultWithHearings> {
    const caseResult = await this.searchCase({ courtCode, signal, spisZn });
    const resolvedCourtCode = inferPrimaryCourtCode(caseResult) ?? courtCode;

    try {
      const hearingsResult = await this.searchHearings({
        courtCode: resolvedCourtCode,
        signal,
        spisZn,
      });

      return {
        case: caseResult,
        hearings: hearingsResult,
      };
    } catch (error) {
      if (error instanceof InfoSoudAPIError && error.status === 400) {
        return {
          case: caseResult,
          hearings: createEmptyHearingsResult(caseResult),
        };
      }

      throw error;
    }
  }

  async getEventDetail({
    courtCode,
    eventOrder,
    eventType,
    signal,
    spisZn,
  }: EventDetailInput): Promise<EventDetailResult> {
    const parsed = this.#parseInput(spisZn);
    const resolvedCourtCode = this.#resolveCourtCode(parsed, courtCode);
    const requestBody = {
      ...toInfoSoudRequestBody(parsed, resolvedCourtCode),
      druhUdalosti: eventType,
      poradiUdalosti: String(eventOrder),
    };

    const result = await this.#request({
      body: requestBody,
      cacheKey: this.#buildRequestCacheKey({
        body: requestBody,
        method: "POST",
        path: "/udalost/vyhledej",
      }),
      cacheTtlMs: this.#cacheConfig.eventDetailTtlMs,
      parse: parseEventDetailResult,
      path: "/udalost/vyhledej",
      signal,
    });
    return result;
  }

  async getCaseEventDetail({
    courtCode,
    event,
    signal,
    spisZn,
  }: CaseEventLookupInput): Promise<EventDetailResult> {
    const detail = await this.getEventDetail({
      courtCode,
      eventOrder: event.poradi,
      eventType: event.udalost,
      signal,
      spisZn,
    });
    return detail;
  }

  async searchCaseWithDetails({
    includeEventTypes,
    ...searchInput
  }: SearchCaseWithDetailsInput): Promise<CaseSearchResultWithDetails> {
    const result = await this.searchCase(searchInput);
    const allowedEventTypes = new Set(
      includeEventTypes ?? DEFAULT_EVENT_DETAIL_EVENT_TYPES,
    );
    const enrichedEvents: CaseEventWithDetail[] = [];

    for (const event of result.udalosti) {
      let detail: EventDetailResult | null = null;

      if (allowedEventTypes.has(event.udalost)) {
        try {
          detail = await this.getCaseEventDetail({
            courtCode: event.znackaId.organizace,
            event,
            signal: searchInput.signal,
            spisZn: toSpisZnFromCaseMarkId(event.znackaId),
          });
        } catch (error) {
          if (!(error instanceof InfoSoudAPIError && error.status === 400)) {
            throw error;
          }
        }
      }

      enrichedEvents.push(enrichCaseEventWithDetail({ detail, event }));
    }

    return { ...result, udalosti: enrichedEvents };
  }

  async getCourts({
    signal,
  }: { signal?: AbortSignal | undefined } = {}): Promise<CourtEntry[]> {
    const result = await this.#request({
      cacheKey: this.#buildRequestCacheKey({
        method: "GET",
        path: "/organizace/lov",
      }),
      cacheTtlMs: this.#cacheConfig.courtsTtlMs,
      parse: parseCourtEntries,
      path: "/organizace/lov",
      signal,
    });
    return result;
  }

  async getDistrictCourts({
    parentCode,
    signal,
  }: DistrictCourtsInput = {}): Promise<CourtEntry[]> {
    const query = parentCode
      ? new URLSearchParams({ kod: resolveCourtCodeAlias(parentCode) })
      : undefined;

    const result = await this.#request({
      cacheKey: this.#buildRequestCacheKey({
        method: "GET",
        path: "/organizace/podrizene/lov",
        query,
      }),
      cacheTtlMs: this.#cacheConfig.courtsTtlMs,
      parse: parseCourtEntries,
      path: "/organizace/podrizene/lov",
      query,
      signal,
    });
    return result;
  }

  async buildCourtMap({
    signal,
  }: { signal?: AbortSignal | undefined } = {}): Promise<CourtMap> {
    const cacheKey = this.#buildDerivedCacheKey("court-map");

    const result = await this.#getCachedOrLoad({
      cacheKey,
      cacheTtlMs: this.#cacheConfig.derivedCourtMapTtlMs,
      deserialize: parseCourtMap,
      load: async () => {
        const [courts, districtCourts] = await Promise.all([
          this.getCourts({ signal }),
          this.getDistrictCourts({ signal }),
        ]);

        return buildCourtMapFromEntries([...courts, ...districtCourts]);
      },
      signal,
    });
    return result;
  }

  async resolveCourtCode(
    query: string,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<string | null> {
    const courtMap = await this.buildCourtMap(options);
    return resolveCourtCodeFromMap(query, courtMap);
  }

  clearCache(): void {
    this.#cache.clear();
    this.#inFlightRequests.clear();
  }

  #parseInput(value: SpisZn | string): SpisZn {
    return typeof value === "string" ? parseSpisZn(value) : value;
  }

  #resolveCourtCode(
    parsed: SpisZn,
    courtCode: string | undefined,
  ): string | undefined {
    const normalizedCourtCode = courtCode?.trim();
    return normalizedCourtCode
      ? resolveCourtCodeAlias(normalizedCourtCode)
      : parsed.courtCode;
  }

  #isAmbiguousPragueCode(code: string): boolean {
    const normalized = resolveCourtCodeAlias(code);
    return normalized === "OSPHA" || normalized === "OSPHA0";
  }

  async #searchAcrossPragueDistricts<TResult>({
    extraBody,
    parse,
    path,
    signal,
    spisZn,
  }: {
    extraBody?: Record<string, string> | undefined;
    parse: (value: unknown) => TResult;
    path: string;
    signal?: AbortSignal | undefined;
    spisZn: SpisZn;
  }): Promise<TResult> {
    for (const districtCode of PRAGUE_DISTRICT_CODES) {
      const requestBody = {
        ...toInfoSoudRequestBody(spisZn, districtCode),
        ...extraBody,
      };

      try {
        return await this.#request({
          body: requestBody,
          cacheKey: this.#buildRequestCacheKey({
            body: requestBody,
            method: "POST",
            path,
          }),
          cacheTtlMs:
            path === "/jednani/vyhledej"
              ? this.#cacheConfig.hearingsTtlMs
              : this.#cacheConfig.caseTtlMs,
          parse,
          path,
          signal,
        });
      } catch (error) {
        if (error instanceof InfoSoudAPIError && error.status === 400) {
          continue;
        }

        throw error;
      }
    }

    throw new InfoSoudRequestError(
      path,
      `Cannot resolve Prague district court for ${spisZn.cisloSenatu} ${spisZn.druhVeci} ${spisZn.bcVec}/${spisZn.rocnik}`,
    );
  }

  async #request<T>({
    body,
    cacheKey,
    cacheTtlMs,
    method = body ? "POST" : "GET",
    parse,
    path,
    query,
    signal,
  }: RequestArgs<T>): Promise<T> {
    const result = await this.#getCachedOrLoad({
      cacheKey,
      cacheTtlMs,
      deserialize: parse,
      load: async () => {
        await this.#throttle();

        const url = new URL(`${this.#baseUrl}${path}`);
        if (query) {
          url.search = query.toString();
        }

        const timeoutSignal = withTimeoutSignal(signal, this.#timeoutMs);

        try {
          const response = await this.#fetchImpl(url, {
            ...(body ? { body: JSON.stringify(body) } : {}),
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "User-Agent": this.#userAgent,
            },
            method,
            signal: timeoutSignal,
          });

          const responseBody = await this.#readResponseBody(response);
          this.#lastRequestFinishedAt = Date.now();

          if (!response.ok) {
            throw new InfoSoudAPIError({
              message: parseErrorMessage(responseBody, response.status, path),
              path,
              responseBody,
              status: response.status,
            });
          }

          return parse(responseBody);
        } catch (error) {
          if (
            error instanceof InfoSoudAPIError ||
            error instanceof InfoSoudParseError ||
            error instanceof InfoSoudRequestError
          ) {
            throw error;
          }

          throw new InfoSoudRequestError(path, `Request failed for ${path}`, {
            cause: error,
          });
        }
      },
      signal,
    });
    return result;
  }

  async #readResponseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const result: unknown = await response.json();
      return result;
    }

    const result = await response.text();
    return result;
  }

  async #throttle(): Promise<void> {
    const elapsed = Date.now() - this.#lastRequestFinishedAt;
    const remainingDelay = this.#delayMs - elapsed;
    await delay(remainingDelay);
  }

  #buildRequestCacheKey({
    body,
    method,
    path,
    query,
  }: {
    body?: Record<string, string> | undefined;
    method: "GET" | "POST";
    path: string;
    query?: URLSearchParams | undefined;
  }): string | undefined {
    if (!this.#cacheConfig.enabled) {
      return undefined;
    }

    return JSON.stringify([
      "request",
      method,
      path,
      query?.toString() ?? null,
      body ?? null,
    ]);
  }

  #buildDerivedCacheKey(key: string): string | undefined {
    if (!this.#cacheConfig.enabled) {
      return undefined;
    }

    return `derived:${key}`;
  }

  #getCachedValue<T>({
    cacheKey,
    deserialize,
  }: {
    cacheKey?: string | undefined;
    deserialize: (value: unknown) => T;
  }): T | null {
    if (!cacheKey || !this.#cacheConfig.enabled) {
      return null;
    }

    const cachedValue = this.#cache.get(cacheKey);
    if (!cachedValue) {
      return null;
    }

    if (cachedValue.expiresAt <= Date.now()) {
      this.#cache.delete(cacheKey);
      return null;
    }

    return deserialize(cloneData(cachedValue.value));
  }

  #setCachedValue<T>(
    cacheKey: string | undefined,
    cacheTtlMs: number | undefined,
    value: T,
  ): void {
    if (
      !cacheKey ||
      cacheTtlMs === undefined ||
      cacheTtlMs <= 0 ||
      !this.#cacheConfig.enabled
    ) {
      return;
    }

    this.#cache.set(cacheKey, {
      expiresAt: Date.now() + cacheTtlMs,
      value: cloneData(value),
    });
  }

  async #getCachedOrLoad<T>({
    cacheKey,
    cacheTtlMs,
    deserialize,
    load,
    signal,
  }: {
    cacheKey?: string | undefined;
    cacheTtlMs?: number | undefined;
    deserialize: (value: unknown) => T;
    load: () => Promise<T>;
    signal?: AbortSignal | undefined;
  }): Promise<T> {
    const cachedValue = this.#getCachedValue({ cacheKey, deserialize });
    if (cachedValue !== null) {
      return cachedValue;
    }

    if (
      !cacheKey ||
      cacheTtlMs === undefined ||
      cacheTtlMs <= 0 ||
      !this.#cacheConfig.enabled
    ) {
      return load();
    }

    if (!signal) {
      const inFlightRequest = this.#inFlightRequests.get(cacheKey);
      if (inFlightRequest) {
        return deserialize(cloneData(await inFlightRequest));
      }
    }

    const loadPromise = (async () => {
      const result = await load();
      this.#setCachedValue(cacheKey, cacheTtlMs, result);
      return result;
    })();

    if (!signal) {
      this.#inFlightRequests.set(cacheKey, loadPromise);
    }

    try {
      return await loadPromise;
    } finally {
      if (!signal) {
        this.#inFlightRequests.delete(cacheKey);
      }
    }
  }
}

export const classifyRequestCourtCode = (
  spisZn: SpisZn,
  courtCode?: string,
): string => {
  const resolvedCourtCode = courtCode ?? spisZn.courtCode;
  if (!resolvedCourtCode) {
    throw new InfoSoudParseError("Court code is required for this request");
  }

  return classifyCourtCode(resolveCourtCodeAlias(resolvedCourtCode));
};
