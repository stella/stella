import { panic, Result } from "better-result";
import * as v from "valibot";

import { load } from "@stll/html";
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
import type {
  SoftLawFetch,
  SoftLawResponse,
} from "@/api/lib/legal-search/soft-law-access-types";
import { extractSoftLawPdfText } from "@/api/lib/legal-search/soft-law-document-text";
import {
  type SoftLawDiscoveryEntry,
  type SoftLawDocumentInput,
  type SoftLawEntry,
  SoftLawIngestionError,
  SoftLawItemError,
  type SoftLawMetadata,
  type SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";

import { listingOnlyCoverage, selectorSourceFields } from "./listing-only";
import { publisherHtmlText } from "./publisher-html-text";
import { publisherUrl as sharedPublisherUrl } from "./publisher-url";

const ORIGIN = "https://suip.gov.cz";
const BASE_PATH = "/web/suip";
const FAQ_SOURCE_KIND = "Otázky a odpovědi";
const CASE_STUDY_SOURCE_KIND = "Kazuistiky";
const METHODOLOGY_SOURCE_KIND = "Metodický pokyn generálního inspektora";
type Collection = { slug: string } & (
  | { type: "faq" }
  | { type: "methodology" }
  | { type: "case-studies" }
  | { type: "documents"; kind: "annual_report" | "guideline" }
);
const COLLECTIONS = [
  { slug: "bezpecnost-prace-otazky-a-odpovedi", type: "faq" },
  { slug: "pracovne-pravni-vztahy-otazky-a-odpovedi", type: "faq" },
  { slug: "zamestnanost-otazky-a-odpovedi", type: "faq" },
  { slug: "otazky-a-odpovedi1", type: "faq" },
  {
    slug: "srovnatelne-podminky-pri-agenturnim-zamestnavani-metodika",
    type: "methodology",
  },
  { slug: "kazuistiky-vsechny", type: "case-studies" },
  {
    slug: "o-vysledcich-kontrolnich-akci",
    type: "documents",
    kind: "annual_report",
  },
  { slug: "zpravy-o-cinnosti-suip", type: "documents", kind: "annual_report" },
  { slug: "publikace", type: "documents", kind: "guideline" },
  { slug: "informacni-letaky", type: "documents", kind: "guideline" },
] as const satisfies readonly Collection[];
/**
 * The leaflet page also lists a publication under another title. Ingesting it
 * twice would swap its metadata on every crawl, so the publication list owns it.
 */
const LEAFLETS_SLUG = "informacni-letaky";
const PUBLICATIONS_SLUG = "publikace";
const HTML_TYPES = ["text/html", "application/xhtml+xml"] as const;
const PDF_TYPES = ["application/pdf", "application/octet-stream"] as const;
const BATCH_LIMIT = 50;
const PLACEHOLDER_DIGEST = "0".repeat(64);
const CURSOR_PATTERN = /^(0|[1-9]\d*):(0|[1-9]\d*):([0-9a-f]{64})$/u;
const DOCUMENT_PATH = /^\/documents\/\d+\/\d+\/[^/]+\/([0-9a-f-]{36})$/iu;
const LEGACY_FILE_PATH = /^\/_files\/[^/]+\/[^/]+\.pdf$/iu;
const CASE_STUDY_PATH =
  /^\/web\/suip\/novinky\/-\/asset_publisher\/[^/]+\/content\/[^/]+$/u;
const ANCHOR_PATTERN = /^[\p{L}\d._~/-]+$/u;

const invalid = (message: string) =>
  Result.err(new SoftLawIngestionError({ message }));
const invalidItem = (message: string) =>
  Result.err(new SoftLawItemError({ message, tag: "invalid_document" }));
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
const publisherUrl = (value: string, base = ORIGIN) =>
  sharedPublisherUrl({ value, base, origin: ORIGIN, publisher: "SÚIP" });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const hasPdfSignature = (bytes: Uint8Array) =>
  decode(bytes.subarray(0, 5)) === "%PDF-";
const collectionUrl = (slug: string) => `${ORIGIN}${BASE_PATH}/${slug}`;

/** "29. 8. 2025" as an ISO date. */
const numericDateIso = (value: string) => {
  const match = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/u.exec(value);
  if (!match) {
    return null;
  }
  const [, day = "", month = "", year = ""] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
};
const statedOrAbsent = (value: string | null | undefined) =>
  value
    ? ({ state: "stated", value } as const)
    : ({ state: "not_stated" } as const);

const czechExpression = {
  type: "identified",
  language: "cs",
  revision: { state: "not_stated" },
} as const;
type MetadataOptions = {
  title: string;
  kind: SoftLawMetadata["kind"];
  sourceKind: string;
  sourceDocumentId: string;
  reference?: string | null;
  issuedOn?: string | null;
};
const metadataOf = ({
  title,
  kind,
  sourceKind,
  sourceDocumentId,
  reference,
  issuedOn,
}: MetadataOptions) =>
  ({
    title,
    kind,
    sourceKind,
    sourceDocumentId,
    statedReference: statedOrAbsent(reference),
    issuedOn: statedOrAbsent(issuedOn),
    expression: czechExpression,
    stage: { state: "not_stated" },
    relations: [],
    validity: { state: "not_stated", basis: "source_stated" },
  }) as const satisfies SoftLawMetadata;

const pageShell = (html: string, slug: string) =>
  Result.gen(function* () {
    const $ = load(html);
    const canonicalHref = $('link[rel="canonical"]').attr("href");
    const canonical = canonicalHref
      ? new URL(yield* publisherUrl(canonicalHref)).pathname
      : "";
    if (canonical !== `/${slug}` || $("main #main-content").length !== 1) {
      return yield* invalid("SÚIP response lacks its content shell");
    }
    if ($('main .pagination, main a[rel~="next"]').length) {
      return yield* invalid("SÚIP page contains unsupported pagination");
    }
    return Result.ok($);
  });

type FaqItem = { anchor: string; title: string; fragment: string };
export const parseSuipFaq = (html: string, slug: string) =>
  Result.gen(function* () {
    const $ = yield* pageShell(html, slug);
    const items: FaqItem[] = [];
    const counts = new Map<string, number>();
    for (const element of $("main .accordion").toArray()) {
      const row = $(element);
      const id = row.attr("id") ?? "";
      const title = compact(row.find(".accordion__title").first().text());
      if (
        !ANCHOR_PATTERN.test(id) ||
        !title ||
        !row.find(".accordion__body").length
      ) {
        return yield* invalid("SÚIP Q&A row lacks an anchor, title or body");
      }
      // Headings repeat under several topics; the ordinal keeps each anchor distinct.
      const seen = (counts.get(id) ?? 0) + 1;
      counts.set(id, seen);
      items.push({
        anchor: seen === 1 ? id : `${id}~${seen}`,
        title,
        fragment: $.html(element),
      });
    }
    if (items.length === 0) {
      return yield* invalid("SÚIP Q&A page lists no questions");
    }
    return Result.ok(items);
  });

const parseFaqItem = (fragment: string) =>
  Result.gen(function* () {
    const $ = load(fragment);
    const row = $(".accordion").first();
    const title = compact(row.find(".accordion__title").first().text());
    const body = publisherHtmlText(row.find(".accordion__body").first());
    if (!title || !body) {
      return yield* invalidItem("SÚIP Q&A row has no question or answer");
    }
    return Result.ok({ title, body });
  });

type DocumentRow = {
  url: string;
  title: string;
  sourceDocumentId: string;
};
type DocumentListing = {
  heading: string;
  reference: string | null;
  rows: readonly DocumentRow[];
  unsupported: readonly { url: string; title: string }[];
};

const rowTitle = (attribute: string | undefined, text: string) =>
  compact(
    attribute || compact(text).replace(/ ?\(\d[\d,. ]*[kKMG]?[bB]\)$/u, ""),
  );

export const parseSuipDocuments = (html: string, slug: string) =>
  Result.gen(function* () {
    const $ = yield* pageShell(html, slug);
    const article = $("main .journal-content-article");
    const heading = compact(article.find("h2").first().text());
    if (article.length !== 1 || !heading) {
      return yield* invalid("SÚIP document page lacks its article");
    }
    const rows: DocumentRow[] = [];
    const unsupported: { url: string; title: string }[] = [];
    const seen = new Set<string>();
    for (const element of article.find("a[href]").toArray()) {
      const anchor = $(element);
      const href = anchor.attr("href") ?? "";
      if (!URL.canParse(href, ORIGIN)) {
        continue;
      }
      const parsed = new URL(href, ORIGIN);
      if (parsed.origin !== ORIGIN) {
        continue;
      }
      const uuid = DOCUMENT_PATH.exec(parsed.pathname)?.at(1);
      const isLegacy = LEGACY_FILE_PATH.test(parsed.pathname);
      if (!uuid && !isLegacy) {
        continue;
      }
      const sourceDocumentId = uuid ?? parsed.pathname;
      // A file served under two names keeps its publisher id; the first row names it.
      if (seen.has(sourceDocumentId)) {
        continue;
      }
      seen.add(sourceDocumentId);
      parsed.search = "";
      const url = yield* publisherUrl(parsed.href);
      const title = rowTitle(anchor.attr("title"), anchor.text());
      if (!title) {
        return yield* invalid("SÚIP document row lacks a title");
      }
      if (!/\.pdf/iu.test(parsed.pathname)) {
        unsupported.push({ url, title });
        continue;
      }
      rows.push({ url, title, sourceDocumentId });
    }
    if (rows.length === 0) {
      return yield* invalid("SÚIP document page lists no documents");
    }
    const reference =
      /(?<![\p{L}\d])č\.\s*(\d{1,3}\/\d{4})/u
        .exec(compact(article.find(".text-justify").text()))
        ?.at(1) ?? null;
    return Result.ok({
      heading,
      reference,
      rows,
      unsupported,
    } satisfies DocumentListing);
  });

type CaseStudyRow = { url: string; title: string };
const parseSuipCaseStudies = (html: string, slug: string) =>
  Result.gen(function* () {
    const $ = yield* pageShell(html, slug);
    const article = $("main .journal-content-article");
    if (article.length !== 1) {
      return yield* invalid("SÚIP case-study page lacks its article");
    }
    const rows: CaseStudyRow[] = [];
    for (const element of article.find("a[href]").toArray()) {
      const anchor = $(element);
      const href = anchor.attr("href") ?? "";
      if (!URL.canParse(href, ORIGIN)) {
        continue;
      }
      const parsed = new URL(href, ORIGIN);
      if (parsed.origin !== ORIGIN || !CASE_STUDY_PATH.test(parsed.pathname)) {
        continue;
      }
      const title = compact(anchor.text());
      if (!title || parsed.search) {
        return yield* invalid("SÚIP case-study row lacks a title or locator");
      }
      rows.push({ url: yield* publisherUrl(parsed.href), title });
    }
    if (rows.length === 0) {
      return yield* invalid("SÚIP case-study page lists no entries");
    }
    return Result.ok(rows);
  });

const parseSuipCaseStudy = (html: string) =>
  Result.gen(function* () {
    const $ = load(html);
    const content = $("main .asset-content .journal-content-article");
    const title = compact(content.find("h2").first().text());
    const body = publisherHtmlText(content.find(".text-block").first());
    const assetId = content.attr("data-analytics-asset-id") ?? "";
    if (content.length !== 1 || !title || !body || !/^\d+$/u.test(assetId)) {
      return yield* invalid("SÚIP case study lacks its article, body or id");
    }
    const published = /Publikováno:\s*(.+)/u
      .exec(compact(content.find("p.smaller").first().text()))
      ?.at(1);
    return Result.ok({
      title,
      body,
      assetId,
      published: published ? numericDateIso(published) : null,
      articleHtml: $.html(content),
    });
  });

type Position = { collection: number; offset: number; digest: string };
const parseCursor = (cursor: string | null) => {
  if (cursor === null) {
    return Result.ok({
      collection: 0,
      offset: 0,
      digest: PLACEHOLDER_DIGEST,
    } satisfies Position);
  }
  const match = CURSOR_PATTERN.exec(cursor);
  const collection = v.safeParse(
    v.pipe(v.string(), v.toNumber(), v.safeInteger()),
    match?.at(1),
  );
  const offset = v.safeParse(
    v.pipe(v.string(), v.toNumber(), v.safeInteger()),
    match?.at(2),
  );
  const digest = match?.at(3);
  if (
    !digest ||
    !collection.success ||
    !offset.success ||
    collection.output >= COLLECTIONS.length
  ) {
    return invalid("Invalid SÚIP discovery cursor");
  }
  return Result.ok({
    collection: collection.output,
    offset: offset.output,
    digest,
  } satisfies Position);
};

const capturedPage = (url: string, response: SoftLawResponse) => ({
  role: "page",
  contentBase64: Buffer.from(response.bytes).toString("base64"),
  contentType: response.contentType,
  provenance: {
    url,
    retrievedAt: Temporal.Now.instant().toString(),
    sha256: sha256Hex(response.bytes),
  },
});

type CollectionEntry = SoftLawDiscoveryEntry;
type CollectionEntriesOptions = {
  collection: (typeof COLLECTIONS)[number];
  pageUrl: string;
  response: SoftLawResponse;
  ownedElsewhere: ReadonlySet<string>;
};
const collectionEntries = ({
  collection,
  pageUrl,
  response,
  ownedElsewhere,
}: CollectionEntriesOptions) =>
  Result.gen(function* () {
    const html = decode(response.bytes);
    const retrievedAt = Temporal.Now.instant().toString();
    switch (collection.type) {
      case "faq": {
        const items = yield* parseSuipFaq(html, collection.slug);
        return Result.ok(
          items.map((item): CollectionEntry => {
            const fragmentBytes = new TextEncoder().encode(item.fragment);
            return {
              type: "document",
              url: `${pageUrl}#${item.anchor}`,
              sourcePages: [pageUrl],
              // The whole category page runs to 800 kB and serves up to 150
              // questions; each entry keeps only its own element.
              sourceRaw: [
                {
                  role: "document",
                  contentBase64: Buffer.from(fragmentBytes).toString("base64"),
                  contentType: "text/html;charset=utf-8",
                  provenance: {
                    url: pageUrl,
                    retrievedAt,
                    sha256: sha256Hex(fragmentBytes),
                  },
                },
              ],
              metadata: metadataOf({
                title: item.title,
                kind: "faq",
                sourceKind: FAQ_SOURCE_KIND,
                sourceDocumentId: `${collection.slug}#${item.anchor}`,
              }),
              sourceDates: {},
            };
          }),
        );
      }
      case "case-studies": {
        const rows = yield* parseSuipCaseStudies(html, collection.slug);
        return Result.ok(
          rows.map((row): CollectionEntry => ({
            type: "document",
            url: row.url,
            sourcePages: [pageUrl],
            metadata: metadataOf({
              title: row.title,
              kind: "other",
              sourceKind: CASE_STUDY_SOURCE_KIND,
              sourceDocumentId: new URL(row.url).pathname,
            }),
            sourceDates: {},
          })),
        );
      }
      case "methodology":
      case "documents": {
        const listing = yield* parseSuipDocuments(html, collection.slug);
        const captured = capturedPage(pageUrl, response);
        const methodology = collection.type === "methodology";
        if (methodology && listing.rows.length !== 1) {
          return yield* invalid("SÚIP methodology page must name one document");
        }
        const kind = methodology ? "methodology" : collection.kind;
        const sourceKind = methodology
          ? METHODOLOGY_SOURCE_KIND
          : listing.heading;
        return Result.ok([
          ...listing.rows
            .filter((row) => !ownedElsewhere.has(row.sourceDocumentId))
            .map((row): CollectionEntry => ({
              type: "document",
              url: row.url,
              sourcePages: [pageUrl],
              sourceRaw: [captured],
              metadata: metadataOf({
                title: methodology ? listing.heading : row.title,
                kind,
                sourceKind,
                sourceDocumentId: row.sourceDocumentId,
                reference: methodology ? listing.reference : null,
              }),
              sourceDates: {},
            })),
          ...listing.unsupported.map((row): CollectionEntry => ({
            type: "rejected",
            url: row.url,
            rejection: {
              tag: "invalid_document",
              reason:
                "The publisher serves this document only as an archive; no text is extracted",
            },
          })),
        ]);
      }
      default:
        collection satisfies never;
        return panic("Unknown SÚIP collection type");
    }
  });

const publicationIds = async (read: SoftLawFetch) =>
  await Result.gen(async function* () {
    const response = yield* await read(collectionUrl(PUBLICATIONS_SLUG), {
      expectedContentTypes: HTML_TYPES,
    });
    const listing = yield* parseSuipDocuments(
      decode(response.bytes),
      PUBLICATIONS_SLUG,
    );
    return Result.ok(new Set(listing.rows.map((row) => row.sourceDocumentId)));
  });

const fetchFaqDocument = (entry: SoftLawEntry) =>
  Result.gen(function* () {
    const captured =
      entry.sourceRaw?.length === 1 ? entry.sourceRaw.at(0) : undefined;
    const bytes = Buffer.from(captured?.contentBase64 ?? "", "base64");
    if (
      !captured ||
      captured.role !== "document" ||
      !captured.provenance ||
      sha256Hex(bytes) !== captured.provenance.sha256 ||
      !entry.metadata.sourceDocumentId ||
      entry.metadata.kind !== "faq"
    ) {
      return yield* invalidItem("SÚIP Q&A retry lacks its captured element");
    }
    const { title, body } = yield* parseFaqItem(decode(bytes));
    return Result.ok({
      metadata: metadataOf({
        title,
        kind: "faq",
        sourceKind: FAQ_SOURCE_KIND,
        sourceDocumentId: entry.metadata.sourceDocumentId,
      }),
      sourceDates: {},
      raw: [
        {
          role: "document",
          bytes,
          contentType: captured.contentType,
          purpose: "document" as const,
          provenance: captured.provenance,
        },
      ],
      text: `${title}\n\n${body}`,
      extractionQuality: "html" as const,
    } satisfies SoftLawDocumentInput);
  });

const fetchCaseStudyDocument = async (
  entry: SoftLawEntry,
  read: SoftLawFetch,
) =>
  await Result.gen(async function* () {
    const url = yield* publisherUrl(entry.url);
    const response = yield* await read(url, {
      expectedContentTypes: HTML_TYPES,
    });
    const retrievedAt = Temporal.Now.instant().toString();
    const study = yield* parseSuipCaseStudy(decode(response.bytes));
    const documentBytes = new TextEncoder().encode(study.articleHtml);
    return Result.ok({
      metadata: metadataOf({
        title: study.title,
        kind: "other",
        sourceKind: CASE_STUDY_SOURCE_KIND,
        sourceDocumentId: study.assetId,
        issuedOn: study.published,
      }),
      sourceDates: study.published ? { publishedOn: study.published } : {},
      raw: [
        {
          role: "page",
          bytes: response.bytes,
          contentType: response.contentType,
          purpose: "discovery" as const,
          provenance: { url, retrievedAt, sha256: sha256Hex(response.bytes) },
        },
        {
          // The surrounding page rotates cache-busting tokens on every response.
          role: "document",
          bytes: documentBytes,
          contentType: "text/html;charset=utf-8",
          purpose: "document" as const,
          provenance: {
            url,
            retrievedAt,
            sha256: sha256Hex(documentBytes),
          },
        },
      ],
      text: `${study.title}\n\n${study.body}`,
      extractionQuality: "html" as const,
    } satisfies SoftLawDocumentInput);
  });

const collectionOfPage = (pageUrl: string) =>
  COLLECTIONS.find((candidate) => collectionUrl(candidate.slug) === pageUrl);

const fetchListedDocument = async (entry: SoftLawEntry, read: SoftLawFetch) =>
  await Result.gen(async function* () {
    const captured =
      entry.sourceRaw?.length === 1 ? entry.sourceRaw.at(0) : undefined;
    const pageBytes = Buffer.from(captured?.contentBase64 ?? "", "base64");
    const collection = captured?.provenance
      ? collectionOfPage(captured.provenance.url)
      : undefined;
    if (
      !captured ||
      captured.role !== "page" ||
      !captured.provenance ||
      sha256Hex(pageBytes) !== captured.provenance.sha256 ||
      !collection ||
      (collection.type !== "documents" && collection.type !== "methodology")
    ) {
      return yield* invalidItem(
        "SÚIP document retry lacks its captured listing",
      );
    }
    const listing = yield* parseSuipDocuments(
      decode(pageBytes),
      collection.slug,
    );
    const row = listing.rows.find((candidate) => candidate.url === entry.url);
    if (!row) {
      return yield* invalidItem("SÚIP document is absent from its listing");
    }
    const methodology = collection.type === "methodology";
    const metadata = metadataOf({
      title: methodology ? listing.heading : row.title,
      kind: methodology ? "methodology" : collection.kind,
      sourceKind: methodology ? METHODOLOGY_SOURCE_KIND : listing.heading,
      sourceDocumentId: row.sourceDocumentId,
      reference: methodology ? listing.reference : null,
    });
    const document = yield* await read(row.url, {
      expectedContentTypes: PDF_TYPES,
    });
    if (!hasPdfSignature(document.bytes)) {
      return yield* invalidItem("SÚIP document response is not a PDF");
    }
    const extraction = await extractSoftLawPdfText(document.bytes);
    return Result.ok({
      metadata,
      sourceDates: {},
      raw: [
        {
          role: "page",
          bytes: pageBytes,
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
            url: row.url,
            retrievedAt: Temporal.Now.instant().toString(),
            sha256: sha256Hex(document.bytes),
          },
        },
      ],
      ...extraction,
    } satisfies SoftLawDocumentInput);
  });

const SOURCE_FIELDS = [
  "question-title",
  "question-body",
  "topic-heading",
  "article-heading",
  "document-link",
  "case-study-date",
  "case-study-body",
] as const;
const FIELD_SELECTORS = {
  "question-title": "main .accordion__title",
  "question-body": "main .accordion__body",
  "topic-heading": "main h3.h2, main h4.h3",
  "article-heading": "main .journal-content-article h2",
  "document-link": 'main a[href*="/documents/"]',
  "case-study-date": "main p.smaller",
  "case-study-body": "main .text-block",
} as const satisfies Record<(typeof SOURCE_FIELDS)[number], string>;
const SOURCE_FIELD_DISPOSITIONS = {
  "question-title": {
    disposition: "stored",
    target: { type: "metadata", key: "title" },
  },
  "question-body": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "document",
      path: [],
      reason: "The accordion element is the document part.",
    },
  },
  "topic-heading": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "page",
      path: [],
      reason:
        "Topic headings stay in the category page; the anchor ties a question to its topic.",
    },
  },
  "article-heading": {
    disposition: "stored",
    target: { type: "metadata", key: "title" },
  },
  "document-link": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "page",
      path: [],
      reason: "The locator is the expression URL; the row stays in the page.",
    },
  },
  "case-study-date": {
    disposition: "stored",
    target: { type: "metadata", key: "issuedOn" },
  },
  "case-study-body": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "document",
      path: [],
      reason: "The article element is the document part.",
    },
  },
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;
const SOURCE_SURFACES = ["page", "document", "other-collections"] as const;
const SOURCE_SURFACE_DISPOSITIONS = {
  page: storedSourceSurface("page"),
  document: storedSourceSurface("document"),
  "other-collections": excludedSourceSurface(
    "News posts, statistics, the inspection-plan pages and the /rest endpoints that robots.txt disallows are not guidance the inspectorate issued.",
  ),
} as const satisfies Record<
  (typeof SOURCE_SURFACES)[number],
  SourceSurfaceDisposition
>;

export const suipAdapter = {
  key: "cz-suip",
  authority: "cz-suip",
  access: {
    publisherGate: "suip-cz",
    userAgent: "Stella/1.0 (+https://github.com/stella/stella)",
    window: { type: "any_time" },
  },
  discover: async ({ cursor, fetch: read }) =>
    await Result.gen(async function* () {
      const position = yield* parseCursor(cursor);
      const collection = COLLECTIONS.at(position.collection);
      if (!collection) {
        return yield* invalid("SÚIP cursor is past the last collection");
      }
      const pageUrl = collectionUrl(collection.slug);
      const response = yield* await read(pageUrl, {
        expectedContentTypes: HTML_TYPES,
      });
      const ownedElsewhere =
        collection.slug === LEAFLETS_SLUG
          ? yield* await publicationIds(read)
          : new Set<string>();
      const entries = yield* collectionEntries({
        collection,
        pageUrl,
        response,
        ownedElsewhere,
      });
      const digest = sha256Hex(
        JSON.stringify(entries.map((entry) => entry.url)),
      );
      // A changed listing shifts the rows an offset counts; restart it.
      const offset = position.digest === digest ? position.offset : 0;
      const batch = entries.slice(offset, offset + BATCH_LIMIT);
      const next = offset + batch.length;
      const nextCursor = (() => {
        if (next < entries.length) {
          return `${position.collection}:${next}:${digest}`;
        }
        return position.collection + 1 < COLLECTIONS.length
          ? `${position.collection + 1}:0:${PLACEHOLDER_DIGEST}`
          : null;
      })();
      return Result.ok({ entries: batch, nextCursor });
    }),
  fetchDocument: async (entry, { fetch: read }) => {
    if (new URL(entry.url).hash) {
      return fetchFaqDocument(entry);
    }
    return CASE_STUDY_PATH.test(new URL(entry.url).pathname)
      ? await fetchCaseStudyDocument(entry, read)
      : await fetchListedDocument(entry, read);
  },
  ...listingOnlyCoverage(
    "The publisher serves a fixed set of section pages with no count endpoint or date filter.",
  ),
  sourceFields: selectorSourceFields({
    fields: SOURCE_FIELD_DISPOSITIONS,
    selectors: FIELD_SELECTORS,
    part: "page",
  }),
  sourceSurfaces: { surfaces: SOURCE_SURFACE_DISPOSITIONS },
} as const satisfies SoftLawSourceAdapter;
