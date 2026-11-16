import { panic, Result } from "better-result";
import * as v from "valibot";

import { load } from "@stll/html";
import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import {
  excludedSourceField,
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

const ORIGIN = "https://uoou.gov.cz";
const SITEMAP_URL = `${ORIGIN}/sitemap/cs.xml`;
const DECISIONS_PATH =
  "/cinnost/ochrana-osobnich-udaju/rozhodnuti-predsedy-uradu";
const INSPECTIONS_PATH = "/cinnost/ochrana-osobnich-udaju/ukoncene-kontroly";
const GUIDANCE_PATH = "/profesional/metodiky-a-doporuceni-pro-spravce";
const QA_PROFESSIONAL_PATH = "/profesional/qa-otazky-a-odpovedi";
const QA_PUBLIC_PATH = "/verejnost/qa-otazky-a-odpovedi";
const WALKED_PATHS = [
  GUIDANCE_PATH,
  QA_PROFESSIONAL_PATH,
  QA_PUBLIC_PATH,
  INSPECTIONS_PATH,
] as const;
/** Cards on the guidance index that the Office issued but filed outside its section. */
const CROSS_LINKED_POSITIONS = [
  "/novinky/vse/k-prokazovani-totoznosti-a-zpracovani-osobnich-udaju",
  "/vyjadreni-uradu-k-otazce-zverejnovani-osobnich-udaju-ucastniku-soudnich-jednani",
] as const;
/** A Fundamental Rights Agency handbook the guidance index links; not the Office's work. */
const THIRD_PARTY_GUIDANCE_PATH =
  "/publikace-fra-o-legislative-pro-ochranu-dat-v-evrope";
const DECISION_DOCUMENT_PATH =
  /^\/media\/rozhodnuti\/rozhodnuti-predsedy\/[^/]+\/[^/]+\.pdf$/u;
const DECISIONS_SOURCE_KIND = "Rozhodnutí předsedy úřadu";
const GUIDANCE_SOURCE_KIND = "Metodiky a doporučení pro správce";
const QA_SOURCE_KIND = "Q&A (otázky a odpovědi)";
const INSPECTIONS_SOURCE_KIND = "Ukončené kontroly";
const HTML_TYPES = ["text/html", "application/xhtml+xml"] as const;
const PDF_TYPES = ["application/pdf", "application/octet-stream"] as const;
const ATTACHMENT_TYPES = [
  ...PDF_TYPES,
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
] as const;
/** The sitemap serves about 2,400 URLs; a thin answer is not the whole site. */
const SITEMAP_MINIMUM_URLS = 1000;
/** Ingestion stores one document per page: a page, its body and its attachments. */
const MAX_ATTACHMENTS = 18;
const PAGE_BATCH_LIMIT = 50;
const PLACEHOLDER_DIGEST = "0".repeat(64);
const DIGEST_PATTERN = "[0-9a-f]{64}";
const CURSOR_PATTERN = new RegExp(
  `^(decisions|pages):(0|[1-9]\\d*):(${DIGEST_PATTERN})$`,
  "u",
);
const CZECH_MONTHS = {
  ledna: "01",
  února: "02",
  března: "03",
  dubna: "04",
  května: "05",
  června: "06",
  července: "07",
  srpna: "08",
  září: "09",
  října: "10",
  listopadu: "11",
  prosince: "12",
} as const;

const invalid = (message: string) =>
  Result.err(new SoftLawIngestionError({ message }));
const invalidItem = (message: string) =>
  Result.err(new SoftLawItemError({ message, tag: "invalid_document" }));
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
const publisherUrl = (value: string, base = ORIGIN) =>
  sharedPublisherUrl({ value, base, origin: ORIGIN, publisher: "ÚOOÚ" });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const isUnder = (path: string, root: string) => path.startsWith(`${root}/`);
const hasPdfSignature = (bytes: Uint8Array) =>
  decode(bytes.subarray(0, 5)) === "%PDF-";

/**
 * Some decision PDFs ship a broken font map that reads "." as "/" and "A" as
 * "!": citations come out as "č/ 500/2004 Sb/". The collection-citation form is
 * the one reliable tell, since a damaged file has it where a sound one has "Sb.".
 */
export const hasDamagedPdfTextLayer = (text: string) => {
  const damaged = text.match(/\bSb\/(?!\d)/gu)?.length ?? 0;
  return damaged >= 3 && damaged > (text.match(/\bSb\./gu)?.length ?? 0);
};

type UoouDocumentLink = { url: string; label: string };
type UoouSectionCard = { url: string; title: string };
type UoouPage = {
  title: string;
  body: string;
  documents: readonly UoouDocumentLink[];
  cards: readonly UoouSectionCard[];
  mainHtml: string;
};

/** Every ÚOOÚ page shares this CMS shell; anything else fails instead of shrinking the walk. */
export const parseUoouPage = (html: string) =>
  Result.gen(function* () {
    const $ = load(html);
    const main = $("main#mainblock");
    const title = compact(main.find("h1").first().text());
    if (main.length !== 1 || !title) {
      return yield* invalid("ÚOOÚ response lacks its content shell");
    }
    if (main.find('.pagination, a[rel~="next"]').length) {
      return yield* invalid("ÚOOÚ page contains unsupported pagination");
    }
    const documents: UoouDocumentLink[] = [];
    const documentUrls = new Set<string>();
    for (const element of main
      .find(".u-l-documents a.u-download-button")
      .toArray()) {
      const anchor = $(element);
      const href = anchor.attr("href");
      const label = compact(anchor.find(".u-download-button__name").text());
      if (!href || !label) {
        return yield* invalid("ÚOOÚ document row lacks a locator or a label");
      }
      const url = yield* publisherUrl(href);
      if (documentUrls.has(url)) {
        return yield* invalid("ÚOOÚ page repeats a document locator");
      }
      documentUrls.add(url);
      documents.push({ url, label });
    }
    const cards: UoouSectionCard[] = [];
    for (const element of main.find("a.u-sections-card").toArray()) {
      const anchor = $(element);
      const href = anchor.attr("href");
      const cardTitle = compact(anchor.find(".u-sections-card__title").text());
      if (!href || !cardTitle) {
        return yield* invalid("ÚOOÚ section card lacks a locator or a title");
      }
      cards.push({ url: yield* publisherUrl(href), title: cardTitle });
    }
    const body = main.find("._cms-content");
    return Result.ok({
      title,
      body: body.length ? publisherHtmlText(body) : "",
      documents,
      cards,
      mainHtml: $.html(main),
    } satisfies UoouPage);
  });

type SitemapRow = { url: string; lastmod: string };

export const parseUoouSitemap = (xml: string) =>
  Result.gen(function* () {
    const $ = load(xml, { xml: true });
    const rows: SitemapRow[] = [];
    for (const element of $("url").toArray()) {
      const row = $(element);
      const loc = compact(row.children("loc").text());
      if (!loc) {
        return yield* invalid("ÚOOÚ sitemap row lacks a locator");
      }
      rows.push({
        url: yield* publisherUrl(loc),
        lastmod: compact(row.children("lastmod").text()),
      });
    }
    if ($("urlset").length !== 1 || rows.length < SITEMAP_MINIMUM_URLS) {
      return yield* invalid("ÚOOÚ sitemap lacks its URL set");
    }
    return Result.ok(rows);
  });

type PageClass = { kind: SoftLawMetadata["kind"]; sourceKind: string };

const classifyPage = (path: string, title: string): PageClass | null => {
  if (CROSS_LINKED_POSITIONS.some((linked) => linked === path)) {
    return { kind: "position", sourceKind: GUIDANCE_SOURCE_KIND };
  }
  if (isUnder(path, GUIDANCE_PATH)) {
    if (/^metodik/iu.test(title)) {
      return { kind: "methodology", sourceKind: GUIDANCE_SOURCE_KIND };
    }
    if (/^doporu[cč]en/iu.test(title)) {
      return { kind: "recommendation", sourceKind: GUIDANCE_SOURCE_KIND };
    }
    return { kind: "guideline", sourceKind: GUIDANCE_SOURCE_KIND };
  }
  if (isUnder(path, QA_PROFESSIONAL_PATH) || isUnder(path, QA_PUBLIC_PATH)) {
    return { kind: "faq", sourceKind: QA_SOURCE_KIND };
  }
  if (isUnder(path, INSPECTIONS_PATH)) {
    return { kind: "inspection_report", sourceKind: INSPECTIONS_SOURCE_KIND };
  }
  return null;
};

/** "1. srpna 2024" or "1. 8. 2024" as an ISO date, or null when it is neither. */
const czechDate = (day: string, month: string, year: string) => {
  const monthNumber = /^\d+$/u.test(month)
    ? month.padStart(2, "0")
    : Object.entries(CZECH_MONTHS)
        .find(([name]) => name === month)
        ?.at(1);
  return monthNumber ? `${year}-${monthNumber}-${day.padStart(2, "0")}` : null;
};
const statedDateInBody = (body: string) => {
  const match = /ze dne\s+(\d{1,2})\.\s*([\p{L}\d]+)\.?\s+(\d{4})/iu.exec(
    body.slice(0, 500),
  );
  return match
    ? czechDate(
        match.at(1) ?? "",
        (match.at(2) ?? "").toLocaleLowerCase("cs"),
        match.at(3) ?? "",
      )
    : null;
};
const statedOrAbsent = (value: string | null | undefined) =>
  value
    ? ({ state: "stated", value } as const)
    : ({ state: "not_stated" } as const);
const pageReference = (classified: PageClass, page: UoouPage) => {
  if (classified.kind === "inspection_report") {
    return /\((UOOU-[^()]+)\)\s*$/u.exec(page.title)?.at(1);
  }
  return classified.kind === "methodology" ||
    classified.kind === "recommendation"
    ? /(?<![\p{L}\d])č\.\s*(\d{1,3}\/\d{4})/u
        .exec(`${page.title} ${page.body.slice(0, 500)}`)
        ?.at(1)
    : undefined;
};

const inspectionYearDate = (path: string): Record<string, string> => {
  const year = /\/kontroly-za-rok-(\d{4})(?:[-/]|$)/u.exec(path)?.at(1);
  return year ? { inspectionYear: year } : {};
};

const unversionedCzechExpression = {
  type: "identified",
  language: "cs",
  revision: { state: "not_stated" },
} as const;

type PageMetadataOptions = {
  path: string;
  classified: PageClass;
  title: string;
  reference: string | null | undefined;
  issuedOn: string | null;
};
const pageMetadata = ({
  path,
  classified,
  title,
  reference,
  issuedOn,
}: PageMetadataOptions) =>
  ({
    title,
    kind: classified.kind,
    sourceKind: classified.sourceKind,
    sourceDocumentId: path,
    statedReference: statedOrAbsent(reference),
    issuedOn: statedOrAbsent(issuedOn),
    expression: unversionedCzechExpression,
    stage: { state: "not_stated" },
    relations: [],
    validity: { state: "not_stated", basis: "source_stated" },
  }) as const satisfies SoftLawMetadata;

type DecisionRow = {
  url: string;
  metadata: SoftLawMetadata;
  sourceDates: Readonly<Record<string, string>>;
};

/**
 * A label repeated on one index cannot be a reference: the publisher lists one
 * decision twice under one čj. and the document behind the second row says
 * otherwise, so such rows fall back to the file path as their identity.
 */
const decisionRows = (page: UoouPage) =>
  Result.gen(function* () {
    if (page.documents.length === 0) {
      return yield* invalid("ÚOOÚ decision index lists no documents");
    }
    const labels = new Map<string, number>();
    for (const document of page.documents) {
      labels.set(document.label, (labels.get(document.label) ?? 0) + 1);
    }
    const rows: DecisionRow[] = [];
    for (const document of page.documents) {
      const path = new URL(document.url).pathname;
      if (!DECISION_DOCUMENT_PATH.test(path)) {
        return yield* invalid("ÚOOÚ decision row does not name a decision PDF");
      }
      const year = /\bv roce (\d{4})\b/u.exec(page.title)?.at(1);
      rows.push({
        url: document.url,
        metadata: pageMetadata({
          path,
          classified: { kind: "other", sourceKind: DECISIONS_SOURCE_KIND },
          title: `${DECISIONS_SOURCE_KIND} ${document.label}`,
          reference: labels.get(document.label) === 1 ? document.label : null,
          issuedOn: null,
        }),
        sourceDates: year ? { listingYear: year } : {},
      });
    }
    return Result.ok(rows);
  });

type CapturedSourcePage = {
  role: "page";
  contentBase64: string;
  contentType: string;
  provenance: { url: string; retrievedAt: string; sha256: string };
};
const capturedSourcePage = (
  url: string,
  response: SoftLawResponse,
): CapturedSourcePage => ({
  role: "page",
  contentBase64: Buffer.from(response.bytes).toString("base64"),
  contentType: response.contentType,
  provenance: {
    url,
    retrievedAt: Temporal.Now.instant().toString(),
    sha256: sha256Hex(response.bytes),
  },
});

type Position =
  | { stage: "decisions"; position: number; digest: string | null }
  | { stage: "pages"; position: number; digest: string };
const parseCursor = (cursor: string | null) => {
  if (cursor === null) {
    return Result.ok({
      stage: "decisions",
      position: 0,
      digest: null,
    } satisfies Position);
  }
  const match = CURSOR_PATTERN.exec(cursor);
  const stage = match?.at(1);
  const offset = v.safeParse(
    v.pipe(v.string(), v.toNumber(), v.safeInteger()),
    match?.at(2),
  );
  const digest = match?.at(3);
  if (!stage || !digest || !offset.success) {
    return invalid("Invalid ÚOOÚ discovery cursor");
  }
  return Result.ok({
    stage: stage === "decisions" ? "decisions" : "pages",
    position: offset.output,
    digest,
  } satisfies Position);
};

type DiscoverOptions = {
  position: Position;
  read: SoftLawFetch;
};
const discoverDecisions = async ({ position, read }: DiscoverOptions) =>
  await Result.gen(async function* () {
    const rootUrl = `${ORIGIN}${DECISIONS_PATH}`;
    const rootResponse = yield* await read(rootUrl, {
      expectedContentTypes: HTML_TYPES,
    });
    const root = yield* parseUoouPage(decode(rootResponse.bytes));
    if (root.title !== DECISIONS_SOURCE_KIND || root.cards.length === 0) {
      return yield* invalid("ÚOOÚ decision root lacks its year sections");
    }
    for (const card of root.cards) {
      if (!isUnder(new URL(card.url).pathname, DECISIONS_PATH)) {
        return yield* invalid("ÚOOÚ decision root links outside its section");
      }
    }
    const digest = sha256Hex(
      JSON.stringify(root.cards.map((card) => card.url)),
    );
    // A changed index shifts the sections an offset counts; restart the walk.
    const index = position.digest === digest ? position.position : 0;
    const section = root.cards.at(index);
    if (!section) {
      return yield* invalid("ÚOOÚ decision cursor is past the last section");
    }
    const response = yield* await read(section.url, {
      expectedContentTypes: HTML_TYPES,
    });
    const page = yield* parseUoouPage(decode(response.bytes));
    const rows = yield* decisionRows(page);
    const captured = capturedSourcePage(section.url, response);
    const next = index + 1;
    return Result.ok({
      entries: rows.map(
        (row) =>
          ({
            type: "document",
            url: row.url,
            sourcePages: [rootUrl, section.url],
            sourceRaw: [captured],
            metadata: row.metadata,
            sourceDates: row.sourceDates,
          }) satisfies SoftLawEntry,
      ),
      nextCursor:
        next < root.cards.length
          ? `decisions:${next}:${digest}`
          : `pages:0:${PLACEHOLDER_DIGEST}`,
    });
  });

const walkedPageRows = (rows: readonly SitemapRow[]) => {
  const selected = rows.filter(({ url }) => {
    const path = new URL(url).pathname;
    return WALKED_PATHS.some((root) => isUnder(path, root));
  });
  return [
    ...selected,
    ...CROSS_LINKED_POSITIONS.map((path) => ({
      url: `${ORIGIN}${path}`,
      lastmod: "",
    })),
  ];
};

/** The provisional title is the URL slug; the page's own heading replaces it on read. */
const pageEntry = ({ url, lastmod }: SitemapRow): SoftLawEntry => {
  const path = new URL(url).pathname;
  const slug = path.split("/").at(-1) ?? path;
  const classified =
    classifyPage(path, slug) ?? panic("Walked page has no ÚOOÚ collection");
  return {
    type: "document",
    url,
    sourcePages: [SITEMAP_URL],
    metadata: pageMetadata({
      path,
      classified,
      title: slug,
      reference: null,
      issuedOn: null,
    }),
    // CMS bookkeeping (most rows carry the site-migration date): kept on the
    // discovery receipt but out of the document, whose hash follows content.
    sourceDates: lastmod ? { sitemapLastmod: lastmod } : {},
  };
};

/** Section cards are the publisher's own listing, so an unknown one stops the walk. */
const coveredCardsOrInvalid = async (
  read: SoftLawFetch,
  listedUrls: ReadonlySet<string>,
) =>
  await Result.gen(async function* () {
    const rejected: SoftLawDiscoveryEntry[] = [];
    for (const root of WALKED_PATHS) {
      const url = `${ORIGIN}${root}`;
      const response = yield* await read(url, {
        expectedContentTypes: HTML_TYPES,
      });
      const page = yield* parseUoouPage(decode(response.bytes));
      if (page.cards.length === 0) {
        return yield* invalid("ÚOOÚ section root lists no cards");
      }
      for (const card of page.cards) {
        const path = new URL(card.url).pathname;
        if (path === THIRD_PARTY_GUIDANCE_PATH) {
          rejected.push({
            type: "rejected",
            url: card.url,
            rejection: {
              tag: "invalid_document",
              reason: "Third-party publication linked from the guidance index",
            },
          });
          continue;
        }
        if (
          !isUnder(path, root) &&
          !CROSS_LINKED_POSITIONS.some((linked) => linked === path)
        ) {
          return yield* invalid("ÚOOÚ section root links an unknown page");
        }
        if (!listedUrls.has(card.url)) {
          return yield* invalid(
            "ÚOOÚ section root lists a page its sitemap omits",
          );
        }
      }
    }
    return Result.ok(rejected);
  });

const discoverPages = async ({ position, read }: DiscoverOptions) =>
  await Result.gen(async function* () {
    const response = yield* await read(SITEMAP_URL, {
      expectedContentTypes: ["text/xml", "application/xml"],
    });
    const rows = walkedPageRows(
      yield* parseUoouSitemap(decode(response.bytes)),
    );
    const digest = sha256Hex(JSON.stringify(rows.map((row) => row.url)));
    // A changed sitemap shifts the rows an offset counts; restart the walk.
    const offset = position.digest === digest ? position.position : 0;
    const rejected =
      offset === 0
        ? yield* await coveredCardsOrInvalid(
            read,
            new Set(rows.map((row) => row.url)),
          )
        : [];
    const batch = rows.slice(offset, offset + PAGE_BATCH_LIMIT);
    const next = offset + batch.length;
    return Result.ok({
      entries: [...rejected, ...batch.map(pageEntry)],
      nextCursor: next < rows.length ? `pages:${next}:${digest}` : null,
    });
  });

type FetchDecisionOptions = {
  entry: SoftLawEntry;
  read: SoftLawFetch;
};
const fetchDecisionDocument = async ({ entry, read }: FetchDecisionOptions) =>
  await Result.gen(async function* () {
    const captured =
      entry.sourceRaw?.length === 1 ? entry.sourceRaw.at(0) : undefined;
    const pageBytes = Buffer.from(captured?.contentBase64 ?? "", "base64");
    if (
      !captured ||
      captured.role !== "page" ||
      !captured.provenance ||
      sha256Hex(pageBytes) !== captured.provenance.sha256
    ) {
      return yield* invalidItem(
        "ÚOOÚ decision retry lacks its captured index page",
      );
    }
    // Metadata comes from the captured publisher bytes, not the stored receipt.
    const rows = yield* decisionRows(yield* parseUoouPage(decode(pageBytes)));
    const row = rows.find((candidate) => candidate.url === entry.url);
    if (!row) {
      return yield* invalidItem("ÚOOÚ decision is absent from its index page");
    }
    const document = yield* await read(row.url, {
      expectedContentTypes: PDF_TYPES,
    });
    if (!hasPdfSignature(document.bytes)) {
      return yield* invalidItem("ÚOOÚ decision response is not a PDF");
    }
    const extracted = await extractSoftLawPdfText(document.bytes);
    // The text stays readable for OCR comparison; the quality says not to trust it.
    const extraction =
      extracted.text && hasDamagedPdfTextLayer(extracted.text)
        ? { text: extracted.text, extractionQuality: "needs_ocr" as const }
        : extracted;
    return Result.ok({
      metadata: row.metadata,
      sourceDates: row.sourceDates,
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

const fetchPageDocument = async ({ entry, read }: FetchDecisionOptions) =>
  await Result.gen(async function* () {
    const url = yield* publisherUrl(entry.url);
    const path = new URL(url).pathname;
    const pageResponse = yield* await read(url, {
      expectedContentTypes: HTML_TYPES,
    });
    const retrievedAt = Temporal.Now.instant().toString();
    const page = yield* parseUoouPage(decode(pageResponse.bytes));
    if (!page.body && page.documents.length === 0) {
      return yield* invalidItem(
        "ÚOOÚ section landing page carries no document of its own",
      );
    }
    if (page.documents.length > MAX_ATTACHMENTS) {
      return yield* invalidItem("ÚOOÚ page lists too many attachments");
    }
    const classified = classifyPage(path, page.title);
    if (!classified) {
      return yield* invalidItem(
        "ÚOOÚ page is outside the admitted collections",
      );
    }
    const documentBytes = new TextEncoder().encode(page.mainHtml);
    const metadata = pageMetadata({
      path,
      classified,
      title: page.title,
      reference: pageReference(classified, page),
      issuedOn:
        classified.kind === "methodology" ||
        classified.kind === "recommendation"
          ? statedDateInBody(page.body)
          : null,
    });
    const raw: SoftLawDocumentInput["raw"][number][] = [
      {
        role: "page",
        bytes: pageResponse.bytes,
        contentType: pageResponse.contentType,
        purpose: "discovery",
        provenance: {
          url,
          retrievedAt,
          sha256: sha256Hex(pageResponse.bytes),
        },
      },
      {
        // Only the content element: the surrounding page carries a per-response
        // form token, so hashing it would report a change on every crawl.
        role: "document",
        bytes: documentBytes,
        contentType: "text/html;charset=utf-8",
        purpose: "document",
        provenance: {
          url,
          retrievedAt,
          sha256: sha256Hex(documentBytes),
        },
      },
    ];
    const texts = page.body ? [page.body] : [];
    let quality: "html" | "text_layer" | "needs_ocr" = "html";
    let extractionFailed = false;
    for (const [index, attachment] of page.documents.entries()) {
      const isPdf = /\.pdf$/iu.test(new URL(attachment.url).pathname);
      const response = yield* await read(attachment.url, {
        expectedContentTypes: isPdf ? PDF_TYPES : ATTACHMENT_TYPES,
      });
      if (isPdf) {
        if (!hasPdfSignature(response.bytes)) {
          return yield* invalidItem("ÚOOÚ attachment is not a PDF");
        }
        const extraction = await extractSoftLawPdfText(response.bytes);
        if (extraction.text) {
          texts.push(extraction.text);
          quality = quality === "needs_ocr" ? quality : "text_layer";
        } else {
          extractionFailed ||=
            extraction.extractionQuality === "extraction_failed";
          quality = "needs_ocr";
        }
      }
      raw.push({
        role: `attachment-${index}`,
        bytes: response.bytes,
        contentType: response.contentType,
        purpose: "document",
        provenance: {
          url: attachment.url,
          retrievedAt: Temporal.Now.instant().toString(),
          sha256: sha256Hex(response.bytes),
        },
      });
    }
    const text = texts.join("\n\n");
    const sourceDates = inspectionYearDate(path);
    if (!text) {
      return Result.ok(
        extractionFailed
          ? ({
              metadata,
              sourceDates,
              raw,
              text: null,
              extractionQuality: "extraction_failed",
              extractionFailure: "Could not extract publisher PDF text",
            } satisfies SoftLawDocumentInput)
          : ({
              metadata,
              sourceDates,
              raw,
              text: null,
              extractionQuality: "needs_ocr",
            } satisfies SoftLawDocumentInput),
      );
    }
    return Result.ok({
      metadata,
      sourceDates,
      raw,
      text,
      extractionQuality: quality,
    } satisfies SoftLawDocumentInput);
  });

const SOURCE_FIELDS = [
  "title",
  "body",
  "document-link",
  "document-label",
  "document-format",
  "section-card",
] as const;
const FIELD_SELECTORS = {
  title: "main#mainblock h1",
  body: "main#mainblock ._cms-content",
  "document-link": "main#mainblock a.u-download-button[href]",
  "document-label": "main#mainblock .u-download-button__name",
  "document-format": "main#mainblock .u-download-button__description",
  "section-card": "main#mainblock a.u-sections-card",
} as const satisfies Record<(typeof SOURCE_FIELDS)[number], string>;
const SOURCE_FIELD_DISPOSITIONS = {
  title: {
    disposition: "stored",
    target: { type: "metadata", key: "title" },
  },
  body: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "document",
      path: [],
      reason: "The content element is the document part; its text is the body.",
    },
  },
  "document-link": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "page",
      path: [],
      reason: "Locators stay in the page; each attachment is a raw part.",
    },
  },
  "document-label": {
    disposition: "stored",
    target: { type: "metadata", key: "statedReference" },
  },
  "document-format": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "page",
      path: [],
      reason: "The stated format and size remain verbatim in the page.",
    },
  },
  "section-card": excludedSourceField({
    reason: "publisher_noise",
    justification:
      "Navigation to the sections the walk reaches through the sitemap.",
    pointer: "main#mainblock a.u-sections-card",
  }),
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;
const SOURCE_SURFACES = [
  "page",
  "document",
  "attachment",
  "sitemap",
  "other-collections",
] as const;
const SOURCE_SURFACE_DISPOSITIONS = {
  page: storedSourceSurface("page"),
  document: storedSourceSurface("document"),
  attachment: storedSourceSurface("attachment-0"),
  sitemap: excludedSourceSurface(
    "A corpus-wide index: it enumerates the pages and states nothing about any one document beyond a CMS timestamp.",
  ),
  "other-collections": excludedSourceSurface(
    "News, EDPB translations, FOI answers and court-decision summaries are not guidance the Office issued.",
  ),
} as const satisfies Record<
  (typeof SOURCE_SURFACES)[number],
  SourceSurfaceDisposition
>;

export const uoouCzAdapter = {
  key: "cz-uoou",
  authority: "cz-uoou",
  access: {
    publisherGate: "uoou-cz",
    userAgent: "Stella/1.0 (+https://github.com/stella/stella)",
    window: { type: "any_time" },
  },
  discover: async ({ cursor, fetch: read }) =>
    await Result.gen(async function* () {
      const position = yield* parseCursor(cursor);
      return position.stage === "decisions"
        ? Result.ok(yield* await discoverDecisions({ position, read }))
        : Result.ok(yield* await discoverPages({ position, read }));
    }),
  fetchDocument: async (entry, { fetch: read }) =>
    DECISION_DOCUMENT_PATH.test(new URL(entry.url).pathname)
      ? await fetchDecisionDocument({ entry, read })
      : await fetchPageDocument({ entry, read }),
  ...listingOnlyCoverage(
    "The publisher serves section pages and a sitemap with no count endpoint or date filter.",
  ),
  sourceFields: selectorSourceFields({
    fields: SOURCE_FIELD_DISPOSITIONS,
    selectors: FIELD_SELECTORS,
    part: "page",
  }),
  sourceSurfaces: { surfaces: SOURCE_SURFACE_DISPOSITIONS },
} as const satisfies SoftLawSourceAdapter;
