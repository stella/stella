import { panic, Result } from "better-result";
import { load } from "cheerio";
import * as slimdom from "slimdom";
import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { GBR_EWHC_DIVISIONS } from "@stll/api-contract/decision-docket-grammar";
import { readCappedBytes } from "@stll/skills/streaming";
import { Temporal } from "@stll/time";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  defineSourceAdapter,
  excludedSourceSurface,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceFieldDisposition,
  SourceRawParts,
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

import { publisherRequestIntervalMs } from "./publisher-policy";
import { readPublisher, unreadPublisherError } from "./publisher-read";
import {
  buildUkFclDecision,
  readUkFclFeed,
  reparseUkFclStoredRaw,
} from "./uk-fcl-feed";
import { adapterCatch, INGESTION_USER_AGENT } from "./utils";

const ORIGIN = "https://caselaw.nationalarchives.gov.uk";
const KEY = ADAPTER_KEYS.UK_FCL;
const FIRST_YEAR = 2001;
const PER_PAGE = 50;
const MAX_EMPTY_SLICES = 16;
const MAX_BYTES = 16 * 1024 * 1024;
export const UK_FCL_COURTS = [
  ...new Set([
    "uksc",
    "ewca/civ",
    "ewca/crim",
    ...GBR_EWHC_DIVISIONS.map(
      (division) =>
        `ewhc/${division === "Costs" ? "scco" : division.toLowerCase()}`,
    ),
  ]),
];
const fail = (message: string) =>
  new AdapterFetchError({ message, adapterKey: KEY, cursor: null });
const xml = (raw: string) => load(raw, { xml: true });
const instant = (value: string) =>
  Result.try({
    try: () => Temporal.Instant.from(value).epochMilliseconds,
    catch: () => fail("Invalid publisher timestamp"),
  }).unwrap();
const request = async (url: string, signal?: AbortSignal) => {
  const target = restrictOutboundUrl({
    rawUrl: url,
    hostPolicy: { type: "exact-origin", origins: [ORIGIN] },
  });
  if (target === null) {
    throw fail("Invalid publisher URL");
  }
  const outcome = await readPublisher(target, {
    adapterKey: KEY,
    fetchStage: target.pathname === "/atom.xml" ? "listing" : "document",
    retryPolicy: "publisher-backoff",
    redirect: "error",
    headers: { "User-Agent": INGESTION_USER_AGENT },
    signal,
    timeoutMs: 30_000,
  });
  switch (outcome.type) {
    case "present":
      break;
    case "absent":
    case "refused":
    case "unavailable":
      throw unreadPublisherError({
        outcome,
        adapterKey: KEY,
        cursor: null,
        message: "Publisher response could not be read",
      });
    default:
      outcome satisfies never;
      return panic("Unexpected publisher read outcome");
  }
  const response = outcome.value;
  const bytes =
    response.body === null
      ? null
      : await readCappedBytes(response.body, MAX_BYTES);
  if (bytes === null) {
    throw fail("Unreadable publisher response");
  }
  return new TextDecoder().decode(bytes);
};
type FeedUrlOptions = { year?: number; court?: string; page?: number };
const feedUrl = ({ year, court, page = 1 }: FeedUrlOptions = {}) => {
  const url = new URL("/atom.xml", ORIGIN);
  url.search = new URLSearchParams({
    order: year === undefined ? "-transformation" : "date",
    per_page: String(PER_PAGE),
    page: String(page),
    ...(court === undefined ? {} : { court }),
    ...(year === undefined
      ? {}
      : {
          from_date_0: "1",
          from_date_1: "1",
          from_date_2: String(year),
          to_date_0: "31",
          to_date_1: "12",
          to_date_2: String(year),
        }),
  }).toString();
  if (court === undefined) {
    for (const slug of UK_FCL_COURTS) {
      url.searchParams.append("court", slug);
    }
  }
  return url.toString();
};

const payloadSchema = v.strictObject({
  feed: v.string(),
  sourceDocumentId: v.string(),
});
type UkFclPayload = v.InferOutput<typeof payloadSchema>;
export const fetchUkFclDecision = async (
  payload: UkFclPayload,
  signal?: AbortSignal,
) => {
  const listed = readUkFclFeed(payload.feed, PER_PAGE).unwrap();
  if (
    !listed.entries.some(
      ({ sourceDocumentId }) => sourceDocumentId === payload.sourceDocumentId,
    )
  ) {
    throw fail("Document identity absent from feed");
  }
  return buildUkFclDecision({
    ...payload,
    document: await request(
      `${ORIGIN}/${payload.sourceDocumentId}/data.xml`,
      signal,
    ),
  }).unwrap();
};

const sweepSchema = v.strictObject({
  type: v.literal("sweep"),
  boundary: v.string(),
  year: v.pipe(v.number(), v.integer(), v.minValue(FIRST_YEAR)),
  court: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(UK_FCL_COURTS.length - 1),
  ),
  url: v.string(),
});
const tipSchema = v.strictObject({
  type: v.literal("tip"),
  frontier: v.string(),
  pending: v.string(),
  url: v.string(),
});
const cursorSchema = v.variant("type", [sweepSchema, tipSchema]);
const tip = (frontier: string) =>
  ({ type: "tip", frontier, pending: frontier, url: feedUrl() }) as const;
const currentYear = () => Temporal.Now.plainDateISO("UTC").year;
const fetchPage = async (
  cursor: string | null,
  signal?: AbortSignal,
): Promise<SyncPage> => {
  let state;
  if (cursor === null) {
    const head = readUkFclFeed(
      await request(feedUrl(), signal),
      PER_PAGE,
    ).unwrap();
    let boundary = "1970-01-01T00:00:00Z";
    for (const entry of head.entries) {
      if (instant(entry.updated) > instant(boundary)) {
        boundary = entry.updated;
      }
    }
    state = {
      type: "sweep",
      boundary,
      year: FIRST_YEAR,
      court: 0,
      url: feedUrl({ year: FIRST_YEAR, court: UK_FCL_COURTS.at(0) }),
    } as const;
  } else {
    const decoded = Result.try({
      try: (): unknown => JSON.parse(cursor),
      catch: () => fail("Invalid crawl cursor"),
    });
    if (decoded.isErr()) {
      throw decoded.error;
    }
    const parsed = v.safeParse(cursorSchema, decoded.value);
    if (!parsed.success) {
      throw fail("Invalid crawl cursor");
    }
    state = parsed.output;
    switch (state.type) {
      case "sweep":
        instant(state.boundary);
        break;
      case "tip":
        if (instant(state.pending) < instant(state.frontier)) {
          throw fail("Invalid daily frontier");
        }
        break;
      default:
        state satisfies never;
        return panic("Unexpected UK crawl state");
    }
  }
  for (let empty = 0; empty < MAX_EMPTY_SLICES; empty++) {
    const sourceUrl = state.url;
    const target = restrictOutboundUrl({
      rawUrl: sourceUrl,
      hostPolicy: { type: "exact-origin", origins: [ORIGIN] },
    });
    if (target?.pathname !== "/atom.xml") {
      throw fail("Invalid listing URL");
    }
    const feed = await request(sourceUrl, signal);
    const listed = readUkFclFeed(feed, PER_PAGE).unwrap();
    if (listed.next === sourceUrl) {
      throw fail("Listing continuation repeats its page");
    }
    const decisions: IngestionResult[] = [];
    let reached = listed.next === null;
    let newest = state.type === "tip" ? state.pending : state.boundary;
    for (const entry of listed.entries) {
      const updated = entry.updated;
      if (state.type === "tip" && instant(updated) < instant(state.frontier)) {
        reached = true;
        break;
      }
      if (instant(updated) > instant(newest)) {
        newest = updated;
      }
      // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- Publisher exposes one XML endpoint per decision; the shared gate serializes requests.
      decisions.push(
        await fetchUkFclDecision(
          { feed, sourceDocumentId: entry.sourceDocumentId },
          signal,
        ),
      );
    }
    switch (state.type) {
      case "tip":
        return {
          decisions,
          sourceUrl,
          nextCursor: JSON.stringify(
            reached
              ? tip(newest)
              : {
                  type: "tip",
                  frontier: state.frontier,
                  pending: newest,
                  url: listed.next,
                },
          ),
        };
      case "sweep": {
        if (listed.next !== null) {
          return {
            decisions,
            sourceUrl,
            nextCursor: JSON.stringify({
              type: "sweep",
              boundary: state.boundary,
              year: state.year,
              court: state.court,
              url: listed.next,
            }),
          };
        }
        const court = (state.court + 1) % UK_FCL_COURTS.length;
        const year = state.year + (court === 0 ? 1 : 0);
        state =
          year > currentYear()
            ? tip(state.boundary)
            : {
                type: "sweep",
                boundary: state.boundary,
                year,
                court,
                url: feedUrl({ year, court: UK_FCL_COURTS.at(court) }),
              };
        if (
          decisions.length > 0 ||
          state.type === "tip" ||
          empty === MAX_EMPTY_SLICES - 1
        ) {
          return { decisions, sourceUrl, nextCursor: JSON.stringify(state) };
        }
        break;
      }
      default:
        state satisfies never;
        return panic("Unexpected UK crawl state");
    }
  }
  throw fail("Crawl did not return a checkpoint");
};

const storedXmlField = {
  disposition: "stored",
  target: { type: "metadata", key: "xmlFields" },
} as const satisfies SourceFieldDisposition;
const storedFeedField = {
  disposition: "stored",
  target: { type: "metadata", key: "feedFields" },
} as const satisfies SourceFieldDisposition;
export const UK_FCL_SOURCE_FIELDS = {
  "{http://www.w3.org/2005/Atom}title": storedFeedField,
  "{http://www.w3.org/2005/Atom}published": storedFeedField,
  "{http://www.w3.org/2005/Atom}updated": storedFeedField,
  "{http://www.w3.org/2005/Atom}author": storedFeedField,
  "{http://www.w3.org/2005/Atom}name": storedFeedField,
  "{http://www.w3.org/2005/Atom}id": storedFeedField,
  "{http://www.w3.org/2005/Atom}link": storedFeedField,
  "{https://caselaw.nationalarchives.gov.uk}uri": storedFeedField,
  "{https://caselaw.nationalarchives.gov.uk}identifier": storedFeedField,
  "{https://caselaw.nationalarchives.gov.uk}contenthash": storedFeedField,
  "{https://caselaw.nationalarchives.gov.uk}assets_base": storedFeedField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}akomaNtoso":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}judgment": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}meta": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}identification":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRWork": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRthis": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRuri": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRdate": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRauthor":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRcountry":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRnumber":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRname": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRExpression":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRlanguage":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}FRBRManifestation":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}references":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}TLCOrganization":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}TLCPerson": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}TLCRole": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}proprietary":
    storedXmlField,
  "{https://caselaw.nationalarchives.gov.uk/akn}court": storedXmlField,
  "{https://caselaw.nationalarchives.gov.uk/akn}year": storedXmlField,
  "{https://caselaw.nationalarchives.gov.uk/akn}number": storedXmlField,
  "{https://caselaw.nationalarchives.gov.uk/akn}cite": storedXmlField,
  "{https://caselaw.nationalarchives.gov.uk/akn}parser": storedXmlField,
  "{https://caselaw.nationalarchives.gov.uk/akn}hash": storedXmlField,
  "{https://caselaw.nationalarchives.gov.uk/akn}tna-enrichment-engine":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}header": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}p": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}neutralCitation":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}party": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}judge": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}docDate": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}block": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}ref": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}judgmentBody":
    storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}decision": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}level": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}heading": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}paragraph": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}num": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}content": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}b": storedXmlField,
  "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}img": storedXmlField,
} as const satisfies Record<string, SourceFieldDisposition>;
const SOURCE_SURFACES = [
  "listing",
  "document",
  "html",
  "pdf",
  "images",
] as const;
const sourceSurfaces = {
  surfaces: {
    listing: storedSourceSurface("listing"),
    document: storedSourceSurface("document"),
    html: excludedSourceSurface("HTML renders the stored LegalDocML document"),
    pdf: excludedSourceSurface("Print rendition of the stored judgment"),
    images: excludedSourceSurface(
      "Image acquisition is outside the text ingestion surface",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;
type SliceCoordinates = { year: number; court: number };
const slice = ({ year, court }: SliceCoordinates) =>
  `${year}-${String(court).padStart(2, "0")}`;
const parseSlice = (value: string) => {
  const matched = /^(\d{4})-(\d{2})$/u.exec(value);
  const year = parseIntegerToken(matched?.at(1), {
    sign: "unsigned",
    min: FIRST_YEAR,
  });
  const court = parseIntegerToken(matched?.at(2), {
    sign: "unsigned",
    min: 0,
    max: UK_FCL_COURTS.length - 1,
  });
  if (year.isErr() || court.isErr()) {
    throw fail("Invalid decision slice");
  }
  return { year: year.value, court: court.value };
};
export const ukFclAdapter = defineSourceAdapter({
  key: KEY,
  documentStage: "inline",
  language: "en",
  minRequestIntervalMs: publisherRequestIntervalMs(KEY),
  pageTimeoutMs: 120_000,
  maxSyncPages: 10,
  sourceSurfaces,
  sourceFields: {
    status: "declared",
    fields: UK_FCL_SOURCE_FIELDS,
    listSourceFields: (parts: SourceRawParts) => [
      ...new Set(
        readUkFclFeed(parts["listing"] ?? "", PER_PAGE)
          .unwrap()
          .entries.flatMap((entry) => Object.keys(entry.fields)),
      ),
      ...Array.from(
        slimdom
          .parseXmlDocument(parts["document"] ?? "")
          .getElementsByTagNameNS("*", "*"),
        (element) => `{${element.namespaceURI ?? ""}}${element.localName}`,
      ),
    ],
  },
  reparseStoredRaw: reparseUkFclStoredRaw,
  async getTotalCount(signal) {
    const counted = await Result.tryPromise({
      try: async () => {
        const raw = await request(
          `${ORIGIN}/atom.xml?per_page=10&court=uksc&court=ewca%2Fciv&court=ewca%2Fcrim&${UK_FCL_COURTS.filter(
            (court) => court.startsWith("ewhc/"),
          )
            .map((court) => `court=${encodeURIComponent(court)}`)
            .join("&")}`,
          signal,
        );
        const $ = xml(raw);
        const count = parseIntegerToken(
          $("opensearch\\:totalResults").text().trim(),
          { sign: "unsigned", min: 0 },
        );
        if ($("opensearch\\:totalResults").length !== 1 || count.isErr()) {
          throw fail("Publisher total unavailable");
        }
        return sourceTotalRead(count.value);
      },
      catch: adapterCatch(KEY, null),
    });
    return counted.isOk()
      ? counted.value
      : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD);
  },
  reconciliation: {
    firstSlice: slice({ year: FIRST_YEAR, court: 0 }),
    sliceOf: (now) =>
      slice({
        year: Temporal.Instant.fromEpochMilliseconds(
          now.getTime(),
        ).toZonedDateTimeISO("UTC").year,
        court: UK_FCL_COURTS.length - 1,
      }),
    tipWindowDays: UK_FCL_COURTS.length * 2,
    nextSlice(value) {
      const { year, court } = parseSlice(value);
      const next = slice({
        year: year + (court + 1 === UK_FCL_COURTS.length ? 1 : 0),
        court: (court + 1) % UK_FCL_COURTS.length,
      });
      return next >
        slice({ year: currentYear(), court: UK_FCL_COURTS.length - 1 })
        ? null
        : next;
    },
    previousSlice(value) {
      const { year, court } = parseSlice(value);
      const previous = slice({
        year: year - (court === 0 ? 1 : 0),
        court: (court + UK_FCL_COURTS.length - 1) % UK_FCL_COURTS.length,
      });
      return previous < slice({ year: FIRST_YEAR, court: 0 }) ? null : previous;
    },
    revisionOf: (payload) => {
      const parsed = v.safeParse(payloadSchema, payload);
      if (!parsed.success) {
        return null;
      }
      const entry = readUkFclFeed(parsed.output.feed, PER_PAGE)
        .unwrap()
        .entries.find(
          (item) => item.sourceDocumentId === parsed.output.sourceDocumentId,
        );
      if (entry === undefined) {
        throw fail("Document identity absent from feed");
      }
      return {
        sourceDocumentId: entry.sourceDocumentId,
        contentHash: entry.contentHash,
        updated: entry.updated,
      };
    },
    async listSlicePage({ slice: value, page, signal }) {
      const { year, court } = parseSlice(value);
      const feed = await request(
        feedUrl({ year, court: UK_FCL_COURTS.at(court), page: page + 1 }),
        signal,
      );
      const listed = readUkFclFeed(feed, PER_PAGE).unwrap();
      return {
        items: listed.entries.map((entry) => ({
          identity: {
            type: "document" as const,
            sourceDocumentId: entry.sourceDocumentId,
          },
          payload: { feed, sourceDocumentId: entry.sourceDocumentId },
        })),
        totalPages: page + (listed.next === null ? 1 : 2),
      };
    },
    async buildDecision(payload, signal) {
      const parsed = v.safeParse(payloadSchema, payload);
      return !parsed.success
        ? { type: "unkeyable" }
        : {
            type: "built",
            decision: await fetchUkFclDecision(parsed.output, signal),
          };
    },
  },
  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: () => fetchPage(cursor, signal),
      catch: adapterCatch(KEY, cursor),
    });
  },
});
