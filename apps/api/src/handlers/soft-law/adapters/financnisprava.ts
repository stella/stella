import { panic, Result } from "better-result";
import * as v from "valibot";

import { load } from "@stll/html";
import type { Cheerio, CheerioAPI } from "@stll/html";
import type { AnyNode } from "@stll/html/nodes";
import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import {
  excludedSourceSurface,
  storedSourceSurface,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  SourceFieldDisposition,
  SourceSurfaceDisposition,
} from "@/api/lib/legal-search/ingestion-types";
import type { SoftLawFetch } from "@/api/lib/legal-search/soft-law-access-types";
import { extractSoftLawPdfText } from "@/api/lib/legal-search/soft-law-document-text";
import {
  SOFT_LAW_BATCH_LIMIT,
  type SoftLawDiscoveryEntry,
  type SoftLawEntry,
  SoftLawIngestionError,
  SoftLawItemError,
  type SoftLawMetadata,
  type SoftLawRelation,
  type SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";

import { listingOnlyCoverage, selectorSourceFields } from "./listing-only";
import { publisherUrl as sharedPublisherUrl } from "./publisher-url";

const ORIGIN = "https://financnisprava.gov.cz";
const PUBLISHER = "Finanční správa";
const HTML_TYPES = ["text/html", "application/xhtml+xml"] as const;
const PDF_TYPES = ["application/pdf", "application/octet-stream"] as const;
const FRAGMENT_TYPE = "text/html;charset=utf-8";
/** Set by the publisher on every page; the walk refuses another language. */
const LANGUAGE = "cs";
const ATTACHMENT_SOURCE_KIND = "Příloha pokynu";
const YEAR = /^(?:19|20)\d{2}$/u;
const yearSchema = v.pipe(v.string(), v.regex(YEAR));
/** A pokyn number as the series writes it: `GFŘ-D-72`, `GFŘ D - 6`, `D-252`, `MF - 4`. */
const REFERENCE_SOURCE = String.raw`(GFŘ\s*[-–]?\s*D|DS|D|MF)\s*[-–]\s*(\d{1,4})`;
const HEADING = new RegExp(
  String.raw`^Pokyn\s+(?:č\.\s*)?${REFERENCE_SOURCE}$`,
  "u",
);
const ATTACHMENT_HEADING = new RegExp(
  String.raw`příloh.*?${REFERENCE_SOURCE}|${REFERENCE_SOURCE}.*?příloh`,
  "iu",
);
const SUPERSEDED_BY = new RegExp(
  String.raw`nahrazen\w*\s+(?:pokynem\s+)?(?:č\.\s*)?${REFERENCE_SOURCE}`,
  "iu",
);
const SUPERSEDES = new RegExp(
  String.raw`nahrazuje\s+(?:pokyn\s+)?(?:č\.\s*)?${REFERENCE_SOURCE}`,
  "iu",
);
/** A status line of the older series: `ZRUŠEN A NAHRAZEN POKYNEM D-333`, `AKTUÁLNÍ`. */
// `\b` treats accented letters as non-word characters, so letters bound these words.
const STATUS_LINE = /^\(?\s*(?:(?:NE)?AKTUÁLNÍ|ZRUŠEN|NAHRAZEN)(?!\p{Ll})/u;
const STATUS_NOTE = /zrušen|nahrazen|neaktuáln/iu;
const TRAILING_STATUS =
  /\(\s*(?:zrušen|nahrazen)[^)]*\)\s*$|(?<!\p{L})NEAKTUÁLNÍ(?!\p{L}).*$/iu;
const EFFECTIVE_FROM =
  /s\s+účinností\s+od\s+(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/iu;
const DOCUMENT_EFFECTIVE_FROM =
  /nabývá\s+účinnosti\s+dnem\s+(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/iu;

const invalid = (message: string) =>
  Result.err(new SoftLawIngestionError({ message }));
const invalidItem = (message: string) =>
  Result.err(new SoftLawItemError({ message, tag: "invalid_document" }));
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
const publisherUrl = (value: string, base = ORIGIN) =>
  sharedPublisherUrl({ value, base, origin: ORIGIN, publisher: PUBLISHER });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** `GFŘ D - 6` and `GFŘ-D-6` name one pokyn; the older series keeps its own `D-6`. */
const normalizedReference = (series: string, number: string) =>
  `${series
    .toLocaleUpperCase("cs")
    .replace(/\s|[-–]/gu, "")
    .replace("GFŘD", "GFŘ-D")}-${number}`;
const referenceIn = (pattern: RegExp, text: string) => {
  const match = pattern.exec(text);
  const series = match?.slice(1).find((part) => part !== undefined) ?? null;
  const index = match?.slice(1).indexOf(series ?? "") ?? -1;
  const number = match?.at(index + 2);
  return series && number ? normalizedReference(series, number) : null;
};
const isoDate = (match: RegExpExecArray | null) => {
  if (!match) {
    return null;
  }
  const [, day = "", month = "", year = ""] = match;
  return Result.try(() =>
    Temporal.PlainDate.from(
      { year: Number(year), month: Number(month), day: Number(day) },
      { overflow: "reject" },
    ),
  ).unwrapOr(null);
};

export type FinancniSpravaSeries = {
  key: "cz-gfr" | "cz-mf";
  /** The series' year listing, `<path>/<year>`. */
  yearPath: string;
  /** The oldest year page; it always exists, and redirects are never followed. */
  firstYear: string;
  /** The publisher's name for the series. */
  sourceKind: string;
};

type ListingRow = {
  heading: string;
  subject: string;
  note: string;
  /** The download button's link as written; resolved per row. */
  download: string | null;
  fragment: string;
};

/** One `.b-teaser` row: its number, subject, the publisher's status note and download. */
const parseRow = ($: CheerioAPI, element: Cheerio<AnyNode>): ListingRow => {
  const heading = compact(element.find(".v-teaser__link").first().text());
  const text = element.find(".b-teaser__text").first().clone();
  const notes: string[] = [];
  for (const strong of text.find("strong").toArray()) {
    const value = compact($(strong).text());
    if (STATUS_NOTE.test(value)) {
      notes.push(value);
      $(strong).remove();
    }
  }
  const paragraphs = text
    .find("p")
    .toArray()
    .map((paragraph) => compact($(paragraph).text()))
    .filter((paragraph) => paragraph.length > 0);
  const first = paragraphs.at(0);
  if (paragraphs.length > 1 && first !== undefined && STATUS_LINE.test(first)) {
    notes.push(first);
    paragraphs.shift();
  }
  let subject = compact(
    (paragraphs.length ? paragraphs.join(" ") : text.text()).replace(
      /\(\s*\)/gu,
      "",
    ),
  );
  const trailing = TRAILING_STATUS.exec(subject);
  if (trailing) {
    notes.push(compact(trailing[0]));
    subject = compact(subject.slice(0, trailing.index));
  }
  return {
    heading,
    subject,
    note: notes.join(" "),
    download:
      element.find(".b-teaser__extra a[href]").first().attr("href") ?? null,
    fragment: $.html(element),
  };
};

type YearPage = { year: string; years: readonly string[]; rows: ListingRow[] };

/** A year page: its own year, the series' year navigation and every listed row. */
export const parseFinancniSpravaYearPage = (
  html: string,
  series: FinancniSpravaSeries,
) =>
  Result.gen(function* () {
    const $ = load(html);
    const year = compact($("main h1").first().text());
    const active = compact($(".b-pagination__item.is-active").first().text());
    const sections = $('main section[id^="seznam-"]');
    if (
      $("html").attr("lang") !== LANGUAGE ||
      !YEAR.test(year) ||
      active !== year ||
      sections.length !== 1
    ) {
      return yield* invalid(
        `${PUBLISHER} response lacks its ${series.sourceKind} year-page shell`,
      );
    }
    const years = new Set([year]);
    for (const link of $("a.b-pagination__item[href]").toArray()) {
      const target = yield* publisherUrl($(link).attr("href") ?? "");
      const path = new URL(target).pathname;
      const linked = path.slice(series.yearPath.length + 1);
      if (!path.startsWith(`${series.yearPath}/`) || !YEAR.test(linked)) {
        return yield* invalid(
          `${PUBLISHER} year navigation leaves the ${series.sourceKind} series`,
        );
      }
      years.add(linked);
    }
    const rows: ListingRow[] = [];
    for (const element of sections.find(".b-teaser").toArray()) {
      rows.push(parseRow($, $(element)));
    }
    if (rows.length > SOFT_LAW_BATCH_LIMIT) {
      return yield* invalid(
        `${PUBLISHER} year page exceeds the discovery batch limit`,
      );
    }
    return Result.ok({
      year,
      years: [...years].toSorted(),
      rows,
    } satisfies YearPage);
  });

const yearUrl = (series: FinancniSpravaSeries, year: string) =>
  `${ORIGIN}${series.yearPath}/${year}`;

/**
 * Validity as the row's note states it. A repeal that takes effect after
 * `today` leaves the pokyn in force, so it is not yet stated as repealed.
 */
const listingValidity = (note: string, today: Temporal.PlainDate) => {
  const effective = isoDate(EFFECTIVE_FROM.exec(note));
  if (effective && Temporal.PlainDate.compare(effective, today) > 0) {
    return "not_stated" as const;
  }
  if (/nahrazen/iu.test(note)) {
    return "superseded" as const;
  }
  return /zrušen|neaktuáln/iu.test(note)
    ? ("withdrawn" as const)
    : ("not_stated" as const);
};

type RowMetadataOptions = {
  series: FinancniSpravaSeries;
  row: ListingRow;
  pageUrl: string;
  today: Temporal.PlainDate;
};

type RowDisposition =
  | { type: "unassigned" }
  | { type: "rejected"; reason: string }
  | { type: "document"; url: string; metadata: SoftLawMetadata };

/** What one listed row is: a pokyn or attachment PDF, a row no text is read from, or an unused number. */
const rowDisposition = ({
  series,
  row,
  pageUrl,
  today,
}: RowMetadataOptions): RowDisposition => {
  if (row.download === null) {
    // The series lists numbers it never issued ("NEOBSAZENO") without a document.
    return /^NEOBSAZENO$/u.test(row.subject)
      ? { type: "unassigned" }
      : { type: "rejected", reason: "The listed row links no document" };
  }
  const download = publisherUrl(row.download);
  if (download.isErr()) {
    return {
      type: "rejected",
      reason: "The listed row links outside the publisher",
    };
  }
  const reference = referenceIn(HEADING, row.heading);
  const attachment =
    reference === null && referenceIn(ATTACHMENT_HEADING, row.heading) !== null;
  if (reference === null && !attachment) {
    return {
      type: "rejected",
      reason: "The listed row names no pokyn number",
    };
  }
  const path = new URL(download.value).pathname;
  if (!path.startsWith("/assets/") || !/\.pdf$/iu.test(path)) {
    return {
      type: "rejected",
      reason:
        "The publisher serves this row only as an archive, a word-processor file or a web page; no text is extracted",
    };
  }
  const evidence = { url: pageUrl, locator: ".b-teaser__text" };
  const relations: SoftLawRelation[] = [];
  const supersededBy = referenceIn(SUPERSEDED_BY, row.note);
  if (supersededBy) {
    relations.push({
      type: "superseded_by",
      reference: supersededBy,
      evidence: { ...evidence, quote: row.note },
    });
  }
  const supersedes = referenceIn(SUPERSEDES, row.subject);
  if (supersedes) {
    relations.push({
      type: "supersedes",
      reference: supersedes,
      evidence: { ...evidence, quote: row.subject },
    });
  }
  return {
    type: "document",
    url: download.value,
    metadata: {
      title: compact(`${row.heading} ${row.subject}`),
      kind: "guideline",
      sourceKind: attachment ? ATTACHMENT_SOURCE_KIND : series.sourceKind,
      statedReference: {
        state: "stated",
        value: reference ?? row.heading,
      },
      issuedOn: { state: "not_stated" },
      expression: {
        type: "identified",
        language: LANGUAGE,
        revision: { state: "not_stated" },
      },
      stage: { state: "not_stated" },
      relations,
      validity: {
        state: listingValidity(row.note, today),
        basis: "source_stated",
      },
    },
  };
};

const pragueToday = () => Temporal.Now.plainDateISO("Europe/Prague");

const capturedRow = (pageUrl: string, row: ListingRow, retrievedAt: string) => {
  const bytes = new TextEncoder().encode(row.fragment);
  return {
    role: "index",
    contentBase64: Buffer.from(bytes).toString("base64"),
    contentType: FRAGMENT_TYPE,
    provenance: { url: pageUrl, retrievedAt, sha256: sha256Hex(bytes) },
  };
};

/** A rejected row's own link, or one naming the row on its page when it links nothing usable. */
const rejectedRowUrl = (pageUrl: string, row: ListingRow) => {
  const download = row.download === null ? null : publisherUrl(row.download);
  return download?.isOk()
    ? download.value
    : `${pageUrl}#row-${sha256Hex(row.fragment).slice(0, 16)}`;
};

type YearEntriesOptions = {
  series: FinancniSpravaSeries;
  html: string;
  pageUrl: string;
  today: Temporal.PlainDate;
  retrievedAt: string;
};

/** Every entry one year page yields, and the next year the series lists. */
export const financniSpravaYearEntries = ({
  series,
  html,
  pageUrl,
  today,
  retrievedAt,
}: YearEntriesOptions) =>
  Result.gen(function* () {
    const page = yield* parseFinancniSpravaYearPage(html, series);
    if (pageUrl !== yearUrl(series, page.year)) {
      return yield* invalid(
        `${PUBLISHER} answered a different year than requested`,
      );
    }
    const entries: SoftLawDiscoveryEntry[] = [];
    for (const row of page.rows) {
      const disposition = rowDisposition({ series, row, pageUrl, today });
      const sourceRaw = [capturedRow(pageUrl, row, retrievedAt)];
      switch (disposition.type) {
        case "unassigned":
          break;
        case "rejected":
          entries.push({
            type: "rejected",
            url: rejectedRowUrl(pageUrl, row),
            sourceRaw,
            rejection: { tag: "invalid_document", reason: disposition.reason },
          });
          break;
        case "document":
          entries.push({
            type: "document",
            url: disposition.url,
            sourcePages: [pageUrl],
            sourceRaw,
            metadata: disposition.metadata,
            sourceDates: { listedYear: page.year },
          });
          break;
        default:
          disposition satisfies never;
          return panic("Unhandled listing row disposition");
      }
    }
    return Result.ok({
      entries,
      nextCursor: page.years.find((year) => year > page.year) ?? null,
    });
  });

type DiscoverYearOptions = {
  series: FinancniSpravaSeries;
  cursor: string | null;
  read: SoftLawFetch;
};

const discoverYear = async ({ series, cursor, read }: DiscoverYearOptions) =>
  await Result.gen(async function* () {
    const position = v.safeParse(v.nullable(yearSchema), cursor);
    if (!position.success) {
      return yield* invalid(`Invalid ${series.sourceKind} discovery cursor`);
    }
    const pageUrl = yearUrl(series, position.output ?? series.firstYear);
    const response = yield* await read(pageUrl, {
      expectedContentTypes: HTML_TYPES,
    });
    return financniSpravaYearEntries({
      series,
      html: decode(response.bytes),
      pageUrl,
      today: pragueToday(),
      retrievedAt: Temporal.Now.instant().toString(),
    });
  });

type FetchPokynOptions = {
  series: FinancniSpravaSeries;
  entry: SoftLawEntry;
  read: SoftLawFetch;
};

const fetchPokyn = async ({ series, entry, read }: FetchPokynOptions) =>
  await Result.gen(async function* () {
    const captured =
      entry.sourceRaw?.length === 1 ? entry.sourceRaw.at(0) : undefined;
    const bytes = Buffer.from(captured?.contentBase64 ?? "", "base64");
    const pageUrl = captured?.provenance?.url ?? "";
    const year = pageUrl.slice(`${ORIGIN}${series.yearPath}/`.length);
    if (
      !captured ||
      captured.role !== "index" ||
      !captured.provenance ||
      sha256Hex(bytes) !== captured.provenance.sha256 ||
      pageUrl !== yearUrl(series, year) ||
      !YEAR.test(year)
    ) {
      return yield* invalidItem(
        `${series.sourceKind} retry lacks its captured listing row`,
      );
    }
    // Metadata comes from the captured publisher row, not the stored receipt.
    const $ = load(decode(bytes));
    const row = parseRow($, $(".b-teaser").first());
    const disposition = rowDisposition({
      series,
      row,
      pageUrl,
      today: pragueToday(),
    });
    if (disposition.type !== "document" || disposition.url !== entry.url) {
      return yield* invalidItem(
        `${series.sourceKind} row no longer names this document`,
      );
    }
    const document = yield* await read(disposition.url, {
      expectedContentTypes: PDF_TYPES,
    });
    if (decode(document.bytes.subarray(0, 5)) !== "%PDF-") {
      return yield* invalidItem(`${series.sourceKind} response is not a PDF`);
    }
    const extraction = await extractSoftLawPdfText(document.bytes);
    const effectiveFrom = isoDate(
      DOCUMENT_EFFECTIVE_FROM.exec(extraction.text ?? ""),
    );
    return Result.ok({
      metadata: disposition.metadata,
      sourceDates: {
        listedYear: year,
        ...(effectiveFrom ? { effectiveFrom: effectiveFrom.toString() } : {}),
      },
      raw: [
        {
          role: "index",
          bytes,
          contentType: captured.contentType,
          purpose: "discovery" as const,
          provenance: captured.provenance,
        },
        {
          role: "document",
          bytes: document.bytes,
          contentType: document.contentType,
          purpose: "document" as const,
          provenance: {
            url: disposition.url,
            retrievedAt: Temporal.Now.instant().toString(),
            sha256: sha256Hex(document.bytes),
          },
        },
      ],
      ...extraction,
    });
  });

const SOURCE_FIELDS = ["number", "description", "download"] as const;
const FIELD_SELECTORS = {
  number: ".v-teaser__link",
  description: ".b-teaser__text",
  download: ".b-teaser__extra a[href]",
} as const satisfies Record<(typeof SOURCE_FIELDS)[number], string>;
const SOURCE_FIELD_DISPOSITIONS = {
  number: {
    disposition: "stored",
    target: { type: "metadata", key: "statedReference" },
  },
  description: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "index",
      path: [],
      reason:
        "The description holds the subject (in the title) and the publisher's status note (validity and relations); the row stays verbatim in the index part.",
    },
  },
  download: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "index",
      path: [],
      reason:
        "The download locator is the expression's URL; the row remains verbatim in the index part.",
    },
  },
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;
const SOURCE_SURFACES = [
  "index",
  "document",
  "other-formats",
  "tax-view",
  "detail-pages",
] as const;
const SOURCE_SURFACE_DISPOSITIONS = {
  index: storedSourceSurface("index"),
  document: storedSourceSurface("document"),
  "other-formats": excludedSourceSurface(
    "Rows served only as ZIP archives, word-processor files or web pages are recorded as rejected entries; no text extractor reads those formats.",
  ),
  "tax-view": excludedSourceSurface(
    "The per-tax view lists the same pokyny grouped by tax; it renders rows the year pages already hold.",
  ),
  "detail-pages": excludedSourceSurface(
    "Some older rows have a detail page repeating the row; it is reachable only through other rows' status links.",
  ),
} as const satisfies Record<
  (typeof SOURCE_SURFACES)[number],
  SourceSurfaceDisposition
>;

const financniSpravaAdapter = <const Series extends FinancniSpravaSeries>(
  series: Series,
) =>
  ({
    key: series.key,
    authority: series.key,
    access: {
      publisherGate: "financnisprava-cz",
      userAgent: "Stella/1.0 (+https://github.com/stella/stella)",
      window: { type: "any_time" },
    },
    discover: async ({ cursor, fetch: read }) =>
      await discoverYear({ series, cursor, read }),
    fetchDocument: async (entry, { fetch: read }) =>
      await fetchPokyn({ series, entry, read }),
    ...listingOnlyCoverage(
      "The publisher serves one undated listing page per year and no count endpoint.",
    ),
    sourceFields: selectorSourceFields({
      fields: SOURCE_FIELD_DISPOSITIONS,
      selectors: FIELD_SELECTORS,
      part: "index",
    }),
    sourceSurfaces: { surfaces: SOURCE_SURFACE_DISPOSITIONS },
  }) as const satisfies SoftLawSourceAdapter;

export const GFR_SERIES = {
  key: "cz-gfr",
  yearPath: "/cs/dane/legislativa-a-metodika/pokyny-d/casove-cleneni",
  firstYear: "1993",
  sourceKind: "Pokyny řady D",
} as const satisfies FinancniSpravaSeries;

export const MF_SERIES = {
  key: "cz-mf",
  yearPath: "/cs/dane/legislativa-a-metodika/pokyny-mf",
  firstYear: "2013",
  sourceKind: "Pokyny MF",
} as const satisfies FinancniSpravaSeries;

export const gfrAdapter = financniSpravaAdapter(GFR_SERIES);
export const mfAdapter = financniSpravaAdapter(MF_SERIES);
