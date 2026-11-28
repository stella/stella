import { Result } from "better-result";

import {
  excludedSourceSurface,
  storedSourceSurface,
} from "@stll/case-law-ingestion-core/ingestion-types";
import type {
  SourceFieldDisposition,
  SourceSurfaceDisposition,
} from "@stll/case-law-ingestion-core/ingestion-types";
import { load } from "@stll/html";
import type { Cheerio, CheerioAPI } from "@stll/html";
import type { AnyNode } from "@stll/html/nodes";
import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { extractSoftLawPdfText } from "@/api/lib/legal-search/soft-law-document-text";
import {
  SOFT_LAW_SERVE_MODE,
  softLawServingSettingOf,
} from "@/api/lib/legal-search/soft-law-serving";
import {
  type SoftLawDocumentInput,
  type SoftLawEntry,
  SoftLawIngestionError,
  SoftLawItemError,
  type SoftLawMetadata,
  type SoftLawRelation,
  type SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";

import {
  listingOnlyCoverage,
  parseListingOffsetCursor,
  resumeListingOffset,
  selectorSourceFields,
} from "./listing-only";
import { publisherHtmlText } from "./publisher-html-text";
import { publisherUrl as sharedPublisherUrl } from "./publisher-url";

const AUTHORITY = "cz-mv-psmv";
const ORIGIN = "https://mv.gov.cz";
export const MV_PSMV_PAGE_URL = `${ORIGIN}/zavery-poradniho-sboru-ministra-vnitra-ke-spravnimu-radu-a-spravnimu-trestani`;
const PUBLISHER = "MV";
const HEADING =
  "Závěry Poradního sboru ministra vnitra ke správnímu řádu a správnímu trestání";
const SOURCE_KIND = "Závěr poradního sboru ministra vnitra";
const ADDENDUM_SOURCE_KIND = "Dodatek k závěru poradního sboru ministra vnitra";
const LANGUAGE = "cs";
const HTML_TYPES = ["text/html", "application/xhtml+xml"] as const;
const PDF_TYPES = ["application/pdf", "application/octet-stream"] as const;
const FRAGMENT_TYPE = "text/html;charset=utf-8";
const DOCUMENT_PATH = /^\/documents\/[a-z0-9-]+$/u;
const NUMBER = /^(\d{1,4})\/((?:19|20)\d{2})$/u;
const ADDENDUM = /^Dodatek k závěru č\.\s*(\d{1,4}\/(?:19|20)\d{2})$/u;
const YEAR = /^(?:19|20)\d{2}$/u;
/** A page of entries; a full-text page then holds up to fifty PDFs of under a megabyte. */
const DISCOVERY_BATCH_LIMIT = 50;

const invalid = (message: string) =>
  Result.err(new SoftLawIngestionError({ message }));
const invalidItem = (message: string) =>
  Result.err(new SoftLawItemError({ message, tag: "invalid_document" }));
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const publisherUrl = (value: string) =>
  sharedPublisherUrl({ value, origin: ORIGIN, publisher: PUBLISHER });

type MvConclusion = {
  /** `93/2010`, or `Dodatek k závěru č. 158/2017` for an addendum. */
  reference: string;
  addendum: boolean;
  title: string;
  url: string;
  /** The publisher's document id (`data-document`). */
  documentId: string;
  note: string;
  year: string;
  /** The whole list item, shared by a závěr and its addendum. */
  fragment: string;
};

/**
 * The bold label before a link, back to the previous line break. The page
 * splits some labels across several `<strong>` elements (`146/2015 `, `-`).
 */
const labelOf = ($: CheerioAPI, anchor: Cheerio<AnyNode>) => {
  const parts: string[] = [];
  for (const sibling of anchor.parent().prevAll().toArray()) {
    const node = $(sibling);
    if (node.is("br")) {
      break;
    }
    if (node.is("strong")) {
      parts.unshift(node.text());
    }
  }
  const label = compact(parts.join(""));
  return label.endsWith("-") || label.endsWith("–")
    ? label.slice(0, -1).trimEnd()
    : label;
};

/** One list item: a závěr, any dodatek, and the note they share. */
const parseMvPsmvItem = ($: CheerioAPI, item: Cheerio<AnyNode>, year: string) =>
  Result.gen(function* () {
    const note = compact(item.find("em").text());
    const fragment = $.html(item);
    const conclusions: MvConclusion[] = [];
    for (const link of item.find("a.internal-link[href]").toArray()) {
      const anchor = $(link);
      const label = labelOf($, anchor);
      const number = NUMBER.exec(label);
      const addendum = ADDENDUM.exec(label);
      const own = number ? `${number[1] ?? ""}/${number[2] ?? ""}` : null;
      const reference = own ?? (addendum ? label : null);
      const url = yield* publisherUrl(anchor.attr("href") ?? "");
      const parsed = new URL(url);
      const documentId = anchor.attr("data-document") ?? "";
      const title = compact(anchor.text());
      if (
        reference === null ||
        !title ||
        !/^\d+$/u.test(documentId) ||
        !DOCUMENT_PATH.test(parsed.pathname) ||
        parsed.search !== "?disposition=attachment"
      ) {
        return yield* invalid(
          "MV závěr lacks its number, title or document locator",
        );
      }
      conclusions.push({
        reference,
        addendum: own === null,
        title,
        url,
        documentId,
        note,
        year,
        fragment,
      });
    }
    return Result.ok(conclusions);
  });

/**
 * The page is one article: year headings, each over a list of závěry. A
 * list item names a závěr by its number, links its PDF and may add a dodatek
 * and an italic note. Any other shape fails the walk instead of shrinking it.
 */
export const parseMvPsmvListing = (html: string) =>
  Result.gen(function* () {
    const $ = load(html);
    const article = $("section#article-chapter-content");
    if (
      compact($("h1").first().text()) !== HEADING ||
      article.length !== 1 ||
      $("html").attr("lang") !== LANGUAGE
    ) {
      return yield* invalid("MV response lacks its závěry page shell");
    }
    const conclusions: MvConclusion[] = [];
    let year: string | null = null;
    for (const child of article.children().toArray()) {
      const node = $(child);
      if (node.is("h3")) {
        year = compact(node.text());
        if (!YEAR.test(year)) {
          return yield* invalid("MV závěry page has an unexpected heading");
        }
        continue;
      }
      // Before the first year sits the reuse notice and the consolidated
      // compilation of every závěr, which repeats the documents below.
      if (year === null || !node.is("ul")) {
        continue;
      }
      for (const item of node.children("li").toArray()) {
        conclusions.push(...(yield* parseMvPsmvItem($, $(item), year)));
      }
    }
    const references = new Set(conclusions.map((entry) => entry.reference));
    const urls = new Set(conclusions.map((entry) => entry.url));
    if (conclusions.length === 0) {
      return yield* invalid("MV závěry page lists no závěry");
    }
    if (
      references.size !== conclusions.length ||
      urls.size !== conclusions.length
    ) {
      return yield* invalid("MV závěry page repeats a number or locator");
    }
    return Result.ok(conclusions);
  });

/**
 * Validity as the page's note states it: replaced by a later závěr,
 * overtaken by case law, or answered by a law that has since changed.
 */
const noteValidity = (note: string) => {
  if (/nahrazen závěrem|překonan/iu.test(note)) {
    return "superseded" as const;
  }
  return /současná úprava|podle současné úpravy|byl nahrazen zákonem/iu.test(
    note,
  )
    ? ("historical_repealed_basis" as const)
    : ("not_stated" as const);
};

/** "nahrazen závěrem č. 190 ze dne 7. 11. 2025" names the replacing závěr 190/2025. */
const REPLACEMENT =
  /nahrazen závěrem č\.\s*(\d{1,4})\s+ze dne\s+\d{1,2}\.\s*\d{1,2}\.\s*((?:19|20)\d{2})/iu;

const conclusionMetadata = (conclusion: MvConclusion): SoftLawMetadata => {
  const relations: SoftLawRelation[] = [];
  const replacement = REPLACEMENT.exec(conclusion.note);
  if (replacement) {
    relations.push({
      type: "superseded_by",
      reference: `${replacement[1] ?? ""}/${replacement[2] ?? ""}`,
      evidence: {
        url: MV_PSMV_PAGE_URL,
        quote: conclusion.note,
        locator: "em",
      },
    });
  }
  return {
    title: conclusion.addendum
      ? `${conclusion.reference}: ${conclusion.title}`
      : `Závěr č. ${conclusion.reference}: ${conclusion.title}`,
    kind: "opinion",
    sourceKind: conclusion.addendum ? ADDENDUM_SOURCE_KIND : SOURCE_KIND,
    sourceDocumentId: conclusion.documentId,
    statedReference: { state: "stated", value: conclusion.reference },
    issuedOn: { state: "not_stated" },
    expression: {
      type: "identified",
      language: LANGUAGE,
      revision: { state: "not_stated" },
    },
    stage: { state: "not_stated" },
    relations,
    validity: { state: noteValidity(conclusion.note), basis: "source_stated" },
  };
};

const listedEntry = (conclusion: MvConclusion) =>
  ({
    type: "document",
    url: conclusion.url,
    sourcePages: [MV_PSMV_PAGE_URL],
    metadata: conclusionMetadata(conclusion),
    sourceDates: { listedYear: conclusion.year },
  }) as const satisfies SoftLawEntry;

/** Full texts are read only where the deployment records the Ministry's permission. */
const fullTextPermitted = () =>
  softLawServingSettingOf(AUTHORITY).serve === SOFT_LAW_SERVE_MODE.full;

const SOURCE_FIELDS = [
  "number",
  "title",
  "download",
  "document-id",
  "file-label",
  "note",
] as const;
const FIELD_SELECTORS = {
  number: "li strong",
  title: "li a.internal-link",
  download: "li a.internal-link[href]",
  "document-id": "li a.internal-link[data-document]",
  "file-label": 'li span[data-type="document-meta"]',
  note: "li em",
} as const satisfies Record<(typeof SOURCE_FIELDS)[number], string>;
const SOURCE_FIELD_DISPOSITIONS = {
  number: {
    disposition: "stored",
    target: { type: "metadata", key: "statedReference" },
  },
  title: { disposition: "stored", target: { type: "metadata", key: "title" } },
  download: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "listing-row",
      path: [],
      reason:
        "The download locator is the expression's URL; the row remains verbatim in the listing-row part.",
    },
  },
  "document-id": {
    disposition: "stored",
    target: { type: "metadata", key: "sourceDocumentId" },
  },
  "file-label": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "listing-row",
      path: [],
      reason:
        "The stated format and size remain verbatim in the listing row; the document part holds the served bytes where full text is permitted.",
    },
  },
  note: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "listing-row",
      path: [],
      reason:
        "The note decides validity and the replacing závěr; its wording remains verbatim in the listing row.",
    },
  },
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;
const SOURCE_SURFACES = ["listing-row", "document", "compilation"] as const;
const SOURCE_SURFACE_DISPOSITIONS = {
  "listing-row": storedSourceSurface("listing-row"),
  // Fetched and kept only where the deployment records the Ministry's permission.
  document: storedSourceSurface("document"),
  compilation: excludedSourceSurface(
    "The consolidated PDF of every závěr repeats the documents the page links one by one.",
  ),
} as const satisfies Record<
  (typeof SOURCE_SURFACES)[number],
  SourceSurfaceDisposition
>;

export const mvPsmvAdapter = {
  key: AUTHORITY,
  authority: AUTHORITY,
  access: {
    publisherGate: "mv-cz",
    userAgent: "Stella/1.0 (+https://github.com/stella/stella)",
    window: { type: "any_time" },
  },
  discover: async ({ cursor, fetch: read }) =>
    await Result.gen(async function* () {
      const position = parseListingOffsetCursor(cursor);
      if (!position.success) {
        return yield* invalid("Invalid MV závěry discovery cursor");
      }
      const response = yield* await read(MV_PSMV_PAGE_URL, {
        expectedContentTypes: HTML_TYPES,
      });
      const retrievedAt = Temporal.Now.instant().toString();
      const listing = yield* parseMvPsmvListing(decode(response.bytes));
      const digest = sha256Hex(
        JSON.stringify(listing.map((conclusion) => conclusion.url)),
      );
      const offset = resumeListingOffset(position.output, digest);
      const batch = listing.slice(offset, offset + DISCOVERY_BATCH_LIMIT);
      const next = offset + batch.length;
      return Result.ok({
        entries: batch.map((conclusion) => {
          // The whole page runs to 600 kB; each entry keeps only its own list item.
          const bytes = new TextEncoder().encode(conclusion.fragment);
          return {
            ...listedEntry(conclusion),
            sourceRaw: [
              {
                role: "listing-row",
                contentBase64: Buffer.from(bytes).toString("base64"),
                contentType: FRAGMENT_TYPE,
                provenance: {
                  url: MV_PSMV_PAGE_URL,
                  retrievedAt,
                  sha256: sha256Hex(bytes),
                },
              },
            ],
          };
        }),
        nextCursor: next < listing.length ? `${next}:${digest}` : null,
      });
    }),
  fetchDocument: async (entry, { fetch: read }) =>
    await Result.gen(async function* () {
      const captured =
        entry.sourceRaw?.length === 1 ? entry.sourceRaw.at(0) : undefined;
      const bytes = Buffer.from(captured?.contentBase64 ?? "", "base64");
      if (
        !captured ||
        captured.role !== "listing-row" ||
        captured.provenance?.url !== MV_PSMV_PAGE_URL ||
        sha256Hex(bytes) !== captured.provenance.sha256
      ) {
        return yield* invalidItem("MV závěr retry lacks its captured row");
      }
      const year = entry.sourceDates["listedYear"] ?? "";
      if (!YEAR.test(year)) {
        return yield* invalidItem("MV závěr retry lacks its listing year");
      }
      // Metadata comes from the captured publisher row, not the stored receipt.
      const $ = load(decode(bytes));
      const item = $("li").first();
      const conclusion = (yield* parseMvPsmvItem($, item, year)).find(
        (candidate) => candidate.url === entry.url,
      );
      const text = publisherHtmlText(item);
      if (!conclusion || !text) {
        return yield* invalidItem("MV závěr row no longer names this document");
      }
      const listed = listedEntry(conclusion);
      const row = {
        role: "listing-row",
        bytes,
        contentType: captured.contentType,
        provenance: captured.provenance,
      };
      if (!fullTextPermitted()) {
        return Result.ok({
          metadata: listed.metadata,
          sourceDates: listed.sourceDates,
          raw: [{ ...row, purpose: "document" as const }],
          text,
          extractionQuality: "html" as const,
        } satisfies SoftLawDocumentInput);
      }
      const document = yield* await read(entry.url, {
        expectedContentTypes: PDF_TYPES,
      });
      if (decode(document.bytes.subarray(0, 5)) !== "%PDF-") {
        return yield* invalidItem("MV závěr response is not a PDF");
      }
      const extraction = await extractSoftLawPdfText(document.bytes);
      return Result.ok({
        metadata: listed.metadata,
        sourceDates: listed.sourceDates,
        raw: [
          { ...row, purpose: "discovery" as const },
          {
            role: "document",
            bytes: document.bytes,
            contentType: document.contentType,
            purpose: "document" as const,
            provenance: {
              url: entry.url,
              retrievedAt: Temporal.Now.instant().toString(),
              sha256: sha256Hex(document.bytes),
            },
          },
        ],
        ...extraction,
      });
    }),
  ...listingOnlyCoverage(
    "The publisher serves one unpaginated page of every závěr and no count endpoint.",
  ),
  sourceFields: selectorSourceFields({
    fields: SOURCE_FIELD_DISPOSITIONS,
    selectors: FIELD_SELECTORS,
    part: "listing-row",
  }),
  sourceSurfaces: { surfaces: SOURCE_SURFACE_DISPOSITIONS },
} as const satisfies SoftLawSourceAdapter;
