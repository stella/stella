import { panic, Result } from "better-result";
import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";

import {
  excludedSourceSurface,
  storedSourceSurface,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  SourceFieldDisposition,
  SourceSurfaceDisposition,
} from "@/api/lib/legal-search/ingestion-types";
import { extractSoftLawPdfText } from "@/api/lib/legal-search/soft-law-document-text";
import {
  SOFT_LAW_BATCH_LIMIT,
  SoftLawIngestionError,
  SoftLawItemError,
  softLawItemErrorRejection,
} from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawEntry,
  SoftLawMetadata,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";
import { isRecord } from "@/api/lib/type-guards";

const ORIGIN = "https://www.edpb.europa.eu";
const INDEXES = ["/documents_en", "/public-consultations_en"] as const;
const HTML_TYPES = ["text/html", "application/xhtml+xml"] as const;

const SOURCE_KINDS = [
  "Guideline",
  "Recommendation",
  "Statement",
  "Other guidance",
  "Opinion of the Board (Art. 64)",
  "Legislative opinion",
  "Adequacy",
  "EDPB Binding Decisions",
  "Coordinated Enforcement Framework",
  "Legal study by external providers",
  "Support Pool of Experts",
  "Task force report",
  "Internal document",
  "Internal procedural guidance",
  "Memorandum of Understanding",
  "Procedure",
  "Rules of procedure",
  "Other policy document",
  "Reports, statements, and letters",
] as const;
type KindDisposition =
  | { type: "included"; kind: SoftLawMetadata["kind"] }
  | { type: "excluded"; reason: string };
const EDPB_KIND_DISPOSITIONS = {
  Guideline: { type: "included", kind: "guideline" },
  Recommendation: { type: "included", kind: "recommendation" },
  Statement: { type: "included", kind: "statement" },
  "Other guidance": {
    type: "excluded",
    reason:
      "Heterogeneous guidance requires document-level admission before classification.",
  },
  "Opinion of the Board (Art. 64)": { type: "included", kind: "opinion" },
  "Legislative opinion": { type: "included", kind: "opinion" },
  Adequacy: { type: "included", kind: "opinion" },
  "EDPB Binding Decisions": {
    type: "excluded",
    reason:
      "Binding dispute decisions belong to a distinct corpus, not soft law.",
  },
  "Coordinated Enforcement Framework": {
    type: "excluded",
    reason: "Enforcement programme reports are not normative guidance.",
  },
  "Legal study by external providers": {
    type: "excluded",
    reason: "External studies do not state the Board's guidance.",
  },
  "Support Pool of Experts": {
    type: "excluded",
    reason: "Operational expert material is not adopted guidance.",
  },
  "Task force report": {
    type: "excluded",
    reason: "Enforcement reports require separate document-level admission.",
  },
  "Internal document": {
    type: "excluded",
    reason:
      "Internal administrative material is outside practitioner soft law.",
  },
  "Internal procedural guidance": {
    type: "excluded",
    reason:
      "Internal administrative material is outside practitioner soft law.",
  },
  "Memorandum of Understanding": {
    type: "excluded",
    reason:
      "Interinstitutional arrangements are outside practitioner soft law.",
  },
  Procedure: {
    type: "excluded",
    reason:
      "Internal administrative material is outside practitioner soft law.",
  },
  "Rules of procedure": {
    type: "excluded",
    reason:
      "Internal administrative material is outside practitioner soft law.",
  },
  "Other policy document": {
    type: "excluded",
    reason:
      "Heterogeneous policy material needs a separate admission decision.",
  },
  "Reports, statements, and letters": {
    type: "excluded",
    reason:
      "Mixed report and correspondence category needs document-level admission.",
  },
} as const satisfies Record<(typeof SOURCE_KINDS)[number], KindDisposition>;

const compact = (text: string) => text.replace(/\s+/gu, " ").trim();
const invalidSource = (message: string) =>
  Result.err(new SoftLawIngestionError({ message }));
const invalidItem = (message: string) =>
  Result.err(new SoftLawItemError({ message, tag: "invalid_document" }));
const sourceUrl = (value: string, base = ORIGIN) =>
  Result.gen(function* () {
    const parsed = Result.try(() => new URL(value, base));
    if (parsed.isErr()) {
      return yield* invalidSource("Malformed EDPB publisher URL");
    }
    const url = parsed.value;
    if (url.origin !== ORIGIN || url.username || url.password) {
      return yield* invalidSource("EDPB URL leaves its publisher boundary");
    }
    url.hash = "";
    return Result.ok(url.href);
  });
const dispositionFor = (label: string) => {
  if (!(label in EDPB_KIND_DISPOSITIONS)) {
    return invalidSource(`Unclassified EDPB document kind: ${label}`);
  }
  for (const [key, disposition] of Object.entries(EDPB_KIND_DISPOSITIONS)) {
    if (key === label) {
      return Result.ok(disposition);
    }
  }
  return panic("EDPB kind map lookup failed");
};
const stated = (value: string) =>
  value
    ? ({ state: "stated", value } as const)
    : ({ state: "not_stated" } as const);

export const parseEdpbListing = (html: string, url: string) =>
  Result.gen(function* () {
    const $ = load(html);
    const indexUrl = yield* sourceUrl(url);
    const indexPath = new URL(indexUrl).pathname;
    // The required view proves the page is the index; the consultations page
    // also lists open ones in a separate view, which may legitimately be empty.
    let marker = "";
    let sections = "";
    if (indexPath === "/documents_en") {
      marker = ".view-documents-overview-documents";
      sections = marker;
    }
    if (indexPath === "/public-consultations_en") {
      marker = ".view-public-consultations-closed-overview";
      sections = `${marker}, .view-public-consultations-open-upcoming`;
    }
    if (!marker || $(marker).length === 0) {
      return yield* invalidSource(
        "EDPB response lacks its expected publication index",
      );
    }
    const cards = $(sections)
      .find(".document-card, .node-public-consultation-card")
      .toArray();
    if (cards.length === 0) {
      return yield* invalidSource(
        "EDPB publication index lacks its expected publication cards",
      );
    }
    const documents: string[] = [];
    for (const element of cards) {
      const card = $(element);
      const title = compact(card.find("h3").text());
      const label = compact(card.find(".document-card__document-type").text());
      if (label) {
        const disposition = yield* dispositionFor(label);
        if (disposition.type === "excluded") {
          continue;
        }
      } else if (
        !/^(Guidelines?|Recommendations?|Statements?|Opinions?)\b/iu.test(title)
      ) {
        continue;
      }
      const href = card
        .find("a.document-card__link, a.node-public-consultation-card__link")
        .attr("href");
      if (!href) {
        return yield* invalidSource("EDPB listing card has no detail locator");
      }
      documents.push(yield* sourceUrl(href, url));
    }
    const next = $(".pager__item--next a").last().attr("href");
    return Result.ok({
      documents: [...new Set(documents)],
      next: next ? yield* sourceUrl(next, url) : null,
    });
  });

const consultationKindFor = (title: string) => {
  if (/^Guidelines?\b/iu.test(title)) {
    return "Guideline";
  }
  if (/^Recommendations?\b/iu.test(title)) {
    return "Recommendation";
  }
  if (/^Statements?\b/iu.test(title)) {
    return "Statement";
  }
  if (/^Opinions?\b/iu.test(title)) {
    return "Legislative opinion";
  }
  return "";
};

const readEdpbFiles = ($: CheerioAPI, url: string) =>
  Result.gen(function* () {
    const files: { url: string; language: string; revision: string }[] = [];
    for (const element of $(
      ".document-full__files .paragraph-documents-file-partial, .node-public-consultation-full__pc__files .paragraph-documents-file-partial",
    ).toArray()) {
      const file = $(element);
      const anchor = file.find(".file__title a").first();
      const label = compact(anchor.text());
      // Summaries, consultation reports and tracked changes are accompanying material.
      if (
        /\b(summary|report|track(?:ed)?.?changes|information purposes)\b/iu.test(
          label,
        )
      ) {
        continue;
      }
      const mainHref = anchor.attr("href");
      if (!mainHref || !/\.pdf(?:\?|$)/iu.test(mainHref)) {
        continue;
      }
      const revision =
        /\bv(?:ersion)?\s*(\d+(?:\.\d+)*)\b/iu.exec(label)?.at(1) ?? "";
      const assets = [
        {
          href: mainHref,
          language:
            /_([a-z]{2})(?:_\d+)?\.pdf(?:\?|$)/u.exec(mainHref)?.at(1) ?? "",
        },
      ];
      file.find("option[data-url][lang]").each((__, option) => {
        const href = $(option).attr("data-url");
        const language = $(option).attr("lang");
        if (href && language) {
          assets.push({ href, language });
        }
      });
      for (const asset of assets) {
        if (!/^[a-z]{2}(?:-[A-Za-z0-9]+)*$/u.test(asset.language)) {
          return yield* invalidItem("EDPB document language is not stated");
        }
        const assetUrl = yield* sourceUrl(asset.href, url);
        files.push({ url: assetUrl, language: asset.language, revision });
      }
    }
    return Result.ok(files);
  });

const readPublisherDocumentId = ($: CheerioAPI) =>
  Result.gen(function* () {
    const content = $('script[data-drupal-selector="drupal-settings-json"]')
      .first()
      .text();
    if (!content) {
      return Result.ok(undefined);
    }
    const parsed = Result.try(() => {
      const value: unknown = JSON.parse(content);
      return value;
    });
    if (parsed.isErr()) {
      return yield* invalidSource("EDPB publisher settings are malformed");
    }
    const settings = parsed.value;
    if (
      !isRecord(settings) ||
      !isRecord(settings["path"]) ||
      typeof settings["path"]["currentPath"] !== "string"
    ) {
      return yield* invalidSource(
        "EDPB publisher settings have no document identity path",
      );
    }
    const id = settings["path"]["currentPath"];
    return Result.ok(
      /^(?:documents|node)\/[1-9]\d*$/u.test(id) ? id : undefined,
    );
  });

type ParseEdpbDocumentOptions = {
  html: string;
  url: string;
  sourcePages?: readonly string[];
};
export const parseEdpbDocument = ({
  html,
  url,
  sourcePages = [url],
}: ParseEdpbDocumentOptions) =>
  Result.gen(function* () {
    const $ = load(html);
    const consultation = $(".node-public-consultation-full").length > 0;
    const sourceDocumentId = yield* readPublisherDocumentId($);
    const title = compact(
      $(
        consultation
          ? ".node-public-consultation-full__title"
          : "h1.document-full__title",
      )
        .first()
        .text(),
    );
    if (!title) {
      return yield* invalidSource("EDPB detail has no title");
    }
    const kindLabel = compact(
      $(".document-full__document-type").first().text(),
    );
    const consultationKind = consultationKindFor(title);
    const disposition = yield* dispositionFor(kindLabel || consultationKind);
    if (disposition.type === "excluded") {
      return Result.ok([]);
    }
    const version = compact(
      $(".document-full__version, .node-public-consultation-full__version")
        .first()
        .text(),
    );
    const issued =
      $(".document-full__date time").first().attr("datetime")?.slice(0, 10) ??
      "";
    const times = $(
      ".node-public-consultation-full__pc__feedback-date time",
    ).toArray();
    const start = $(times.at(0)).attr("datetime")?.slice(0, 10) ?? "";
    const end = $(times.at(1)).attr("datetime")?.slice(0, 10) ?? "";
    const finalLink = $(".node-public-consultation-full__final-document-link");
    const finalHref = finalLink.attr("href");
    const obsolete = version === "Obsolete version";
    const draftHref = $(".document-full__public-consultation-link").attr(
      "href",
    );
    const draftQuote = compact($(".document-full__public-consultation").text());
    const finalQuote = compact(
      $(".node-public-consultation-full__final-document").text(),
    );
    const relations: NonNullable<SoftLawMetadata["relations"]>[number][] = [];
    if (obsolete && finalHref) {
      relations.push({
        type: "superseded_by",
        reference: yield* sourceUrl(finalHref, url),
        evidence: {
          url,
          quote: finalQuote,
          locator: ".node-public-consultation-full__final-document",
        },
      });
    } else if (version === "Final version" && draftHref) {
      relations.push({
        type: "supersedes",
        reference: yield* sourceUrl(draftHref, url),
        evidence: {
          url,
          quote: draftQuote,
          locator: ".document-full__public-consultation",
        },
      });
    }
    let stage: NonNullable<SoftLawMetadata["stage"]> = { state: "not_stated" };
    if (consultation) {
      stage = {
        state: "consultation",
        evidence: {
          url,
          quote: compact(
            $(".node-public-consultation-full__pc__feedback-date").text(),
          ),
          locator: ".node-public-consultation-full__pc__feedback-date",
        },
      };
    } else if (version === "Final version") {
      stage = {
        state: "adopted",
        evidence: { url, quote: version, locator: ".document-full__version" },
      };
    }
    const reference =
      /\b(?:Opinions?|Guidelines?|Recommendations?|Statements?)\s+(\d{1,3}\/\d{4})\b/iu
        .exec(title)
        ?.at(1) ?? "";
    const sourceDates = {
      ...(issued ? { documentDate: issued } : {}),
      ...(start ? { consultationStart: start } : {}),
      ...(end ? { consultationEnd: end } : {}),
    };
    const entries = new Map<string, SoftLawEntry>();
    const files = yield* readEdpbFiles($, url);
    for (const asset of files) {
      entries.set(asset.url, {
        type: "document",
        url: asset.url,
        sourcePages,
        metadata: {
          title,
          kind: disposition.kind,
          sourceKind: kindLabel || consultationKind,
          ...(sourceDocumentId ? { sourceDocumentId } : {}),
          statedReference: stated(reference),
          issuedOn: stated(issued),
          expression: {
            type: "identified",
            language: asset.language,
            revision: stated(asset.revision),
          },
          stage,
          relations,
          validity: {
            state: obsolete ? "superseded" : "not_stated",
            basis: "source_stated",
          },
        },
        sourceDates,
      });
    }
    if (entries.size === 0) {
      return yield* invalidSource(
        "EDPB admitted detail has no identifiable PDF expressions",
      );
    }
    if (entries.size > SOFT_LAW_BATCH_LIMIT) {
      return yield* invalidSource(
        "EDPB detail exceeds the expression batch limit",
      );
    }
    return Result.ok([...entries.values()]);
  });

const SOURCE_FIELDS = [
  "title",
  "document-type",
  "document-date",
  "version",
  "reference",
  "feedback-period",
  "language-files",
  "related-version",
  "publisher-document-id",
  "topics",
  "feedback",
] as const;
const SOURCE_FIELD_DISPOSITIONS = {
  title: { disposition: "stored", target: { type: "metadata", key: "title" } },
  "document-type": {
    disposition: "stored",
    target: { type: "metadata", key: "sourceKind" },
  },
  "document-date": {
    disposition: "stored",
    target: { type: "metadata", key: "issuedOn" },
  },
  version: {
    disposition: "stored",
    target: { type: "metadata", key: "stage" },
  },
  reference: {
    disposition: "stored",
    target: { type: "metadata", key: "statedReference" },
  },
  "feedback-period": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "detail",
      path: [],
      reason:
        "The source feedback period remains in the original HTML and sourceDates.",
    },
  },
  "language-files": {
    disposition: "stored",
    target: { type: "metadata", key: "expression" },
  },
  "related-version": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "detail",
      path: [],
      reason:
        "Version links remain in the original HTML; lifecycle relations require explicit adopted or obsolete version evidence.",
    },
  },
  "publisher-document-id": {
    disposition: "stored",
    target: { type: "metadata", key: "sourceDocumentId" },
  },
  topics: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "detail",
      path: [],
      reason:
        "Publisher topic labels and links remain verbatim in the retained detail HTML.",
    },
  },
  feedback: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "detail",
      path: [],
      reason:
        "Consultation response labels and links already present on the detail page remain in its retained HTML.",
    },
  },
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;
const FIELD_SELECTORS = {
  "publisher-document-id":
    'script[data-drupal-selector="drupal-settings-json"]',
  title: "h1.document-full__title, .node-public-consultation-full__title",
  "document-type": ".document-full__document-type",
  "document-date": ".document-full__date time",
  version: ".document-full__version, .node-public-consultation-full__version",
  reference: ".node-public-consultation-full__pc__reference",
  "feedback-period": ".node-public-consultation-full__pc__feedback-date",
  "language-files": ".file__title a",
  "related-version":
    ".document-full__public-consultation, .node-public-consultation-full__final-document",
  topics:
    ".document-full__topics, .node-public-consultation-full__relevant-topics",
  feedback: ".view-consultation-feedback-submitted-feedback",
} as const satisfies Record<(typeof SOURCE_FIELDS)[number], string>;
const SOURCE_SURFACES = [
  "index",
  "detail",
  "document",
  "translated-html",
  "consultation-feedback",
  "accompanying-files",
] as const;
const SOURCE_SURFACE_DISPOSITIONS = {
  index: storedSourceSurface("index"),
  detail: storedSourceSurface("detail"),
  document: storedSourceSurface("document"),
  "translated-html": excludedSourceSurface(
    "Localized HTML repeats the same document; all PDF language expressions are obtained from the canonical English detail's language selector.",
  ),
  "consultation-feedback": excludedSourceSurface(
    "Third-party responses are outside the Board-authored corpus and include personal data.",
  ),
  "accompanying-files": excludedSourceSurface(
    "Summaries, consultation reports, and tracked changes are supporting material rather than the admitted instrument.",
  ),
} as const satisfies Record<
  (typeof SOURCE_SURFACES)[number],
  SourceSurfaceDisposition
>;

const readCursor = (cursor: string | null) => {
  const params = new URLSearchParams(cursor ?? "index=0&page=0&item=0");
  const index = Number(params.get("index"));
  const page = Number(params.get("page"));
  const item = Number(params.get("item"));
  if (
    [index, page, item].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    index > 1 ||
    page > 10_000 ||
    item > 100
  ) {
    return invalidSource("Invalid EDPB discovery cursor");
  }
  return Result.ok({ index, page, item });
};
const cursorFor = (index: number, page: number, item: number) =>
  new URLSearchParams({
    index: String(index),
    page: String(page),
    item: String(item),
  }).toString();

export const edpbAdapter = {
  key: "eu-edpb",
  authority: "eu-edpb",
  access: {
    publisherGate: "edpb-eu",
    userAgent: "Stella/1.0 (+https://github.com/stella/stella)",
    window: { type: "any_time" },
  },
  discover: async ({ cursor, fetch: read }) =>
    await Result.gen(async function* () {
      const { index, page, item } = yield* readCursor(cursor);
      const path = INDEXES.at(index);
      if (!path) {
        return panic("EDPB index cursor out of range");
      }
      const indexUrl = yield* sourceUrl(`${path}?page=${page}`);
      const indexResult = await read(indexUrl, {
        expectedContentTypes: HTML_TYPES,
      });
      if (indexResult.isErr()) {
        return yield* Result.err(indexResult.error);
      }
      const listing = yield* parseEdpbListing(
        new TextDecoder().decode(indexResult.value.bytes),
        indexUrl,
      );
      const detailUrl = listing.documents.at(item);
      let nextCursor: string | null = null;
      if (item + 1 < listing.documents.length) {
        nextCursor = cursorFor(index, page, item + 1);
      } else if (listing.next) {
        nextCursor = cursorFor(index, page + 1, 0);
      } else if (index === 0) {
        nextCursor = cursorFor(1, 0, 0);
      }
      if (!detailUrl) {
        return Result.ok({ entries: [], nextCursor });
      }
      const detailResult = await read(detailUrl, {
        expectedContentTypes: HTML_TYPES,
      });
      if (detailResult.isErr()) {
        return yield* Result.err(detailResult.error);
      }
      const captured = [
        {
          role: "index",
          contentBase64: Buffer.from(indexResult.value.bytes).toBase64(),
          contentType: indexResult.value.contentType,
        },
        {
          role: "detail",
          contentBase64: Buffer.from(detailResult.value.bytes).toBase64(),
          contentType: detailResult.value.contentType,
        },
      ];
      const parsed = parseEdpbDocument({
        html: new TextDecoder().decode(detailResult.value.bytes),
        url: detailUrl,
        sourcePages: [indexUrl, detailUrl],
      });
      if (parsed.isErr()) {
        const rejection = softLawItemErrorRejection({
          error: parsed.error,
          url: detailUrl,
          sourceRaw: captured,
        });
        if (!rejection) {
          return yield* Result.err(parsed.error);
        }
        return Result.ok({
          entries: [rejection],
          nextCursor,
        });
      }
      const entries = parsed.value.map((entry) => ({
        type: "document" as const,
        url: entry.url,
        ...(entry.sourcePages ? { sourcePages: entry.sourcePages } : {}),
        sourceRaw: captured,
        metadata: entry.metadata,
        sourceDates: entry.sourceDates,
      }));
      return Result.ok({ entries, nextCursor });
    }),
  fetchDocument: async (entry, { fetch: read }) => {
    const captured = entry.sourceRaw;
    if (
      !captured ||
      captured.length > 3 ||
      !captured.some((part) => part.role === "detail") ||
      !captured.some((part) => part.role === "index") ||
      (entry.sourcePages?.length ?? 0) > 3
    ) {
      return Result.err(
        new SoftLawItemError({
          message: "EDPB expression lacks its bounded discovery evidence",
          tag: "invalid_document",
        }),
      );
    }
    const validatedUrl = sourceUrl(entry.url);
    if (validatedUrl.isErr()) {
      return validatedUrl;
    }
    const fetched = await read(validatedUrl.value, {
      expectedContentTypes: ["application/pdf", "application/octet-stream"],
    });
    if (fetched.isErr()) {
      return fetched;
    }
    if (new TextDecoder().decode(fetched.value.bytes.slice(0, 5)) !== "%PDF-") {
      return Result.err(
        new SoftLawItemError({
          message: "EDPB document response is not a PDF",
          tag: "invalid_document",
        }),
      );
    }
    const extraction = await extractSoftLawPdfText(fetched.value.bytes);
    return Result.ok({
      metadata: entry.metadata,
      sourceDates: entry.sourceDates,
      raw: [
        ...captured.map((part) => ({
          role: part.role,
          purpose: "discovery" as const,
          bytes: Buffer.from(part.contentBase64, "base64"),
          contentType: part.contentType,
        })),
        {
          role: "document",
          purpose: "document" as const,
          bytes: fetched.value.bytes,
          contentType: fetched.value.contentType,
        },
      ],
      ...extraction,
    });
  },
  getTotalCount: async () =>
    await Promise.resolve({ type: "no-count-endpoint" as const }),
  sliceWalk: {
    type: "unsupported",
    reason:
      "The publisher paginates mutable document and consultation indexes; no exhaustive date-slice endpoint or count of eligible language expressions exists.",
  },
  sourceFields: {
    status: "declared",
    fields: SOURCE_FIELD_DISPOSITIONS,
    listSourceFields: (parts) => {
      const $ = load(parts["detail"] ?? "");
      return SOURCE_FIELDS.filter(
        (field) => $(FIELD_SELECTORS[field]).length > 0,
      );
    },
  },
  sourceSurfaces: { surfaces: SOURCE_SURFACE_DISPOSITIONS },
} as const satisfies SoftLawSourceAdapter;
