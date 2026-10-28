import { Result } from "better-result";
import * as cheerio from "cheerio";

import {
  excludedSourceSurface,
  storedSourceSurface,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  SourceFieldDisposition,
  SourceSurfaceDisposition,
} from "@/api/lib/legal-search/ingestion-types";
import { SOFT_LAW_AUTHORITY_POLICIES } from "@/api/lib/legal-search/soft-law-authority-policy";
import { extractSoftLawPdfText } from "@/api/lib/legal-search/soft-law-document-text";
import {
  SOFT_LAW_BATCH_LIMIT,
  SoftLawIngestionError,
  SoftLawItemError,
  softLawItemErrorRejection,
} from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawDocumentInput,
  SoftLawEntry,
  SoftLawMetadata,
  SoftLawSourceAdapter,
  SoftLawStage,
} from "@/api/lib/legal-search/soft-law-types";

const ORIGIN = "https://ec.europa.eu";
const ARCHIVE = `${ORIGIN}/justice/article-29/documentation/opinion-recommendation/index_en.htm`;
const NEWSROOM = `${ORIGIN}/newsroom/article29/`;
const CATEGORIES = ["1360", "1308", "1307", "1310"] as const;
const MAX_ASSETS = 20;
const MAX_NEWSROOM_ITEMS = 100;
const HTML_TYPES = ["text/html"] as const;
const PDF_TYPES = ["application/pdf"] as const;
const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
const invalid = (message: string) =>
  new SoftLawItemError({ message, tag: "invalid_document" });
// Archive files name their rendition with a suffix such as `_en.pdf`.
const assetLanguage = (path: string) =>
  /_([a-z]{2})(?:_[a-z]+)?\.(?:pdf|doc)(?:$|\?)/iu
    .exec(path)
    ?.at(1)
    ?.toLowerCase();

const publisherUrl = (href: string, base: string) => {
  const parsed = Result.try(() => new URL(href, base));
  if (parsed.status === "error") {
    return Result.err(invalid("Invalid WP29 source URL"));
  }
  const url = parsed.value;
  if (
    url.origin !== ORIGIN ||
    url.username ||
    url.password ||
    (!url.pathname.startsWith("/justice/article-29/") &&
      !url.pathname.startsWith("/newsroom/article29/"))
  ) {
    return Result.err(
      invalid("WP29 URL escaped the publisher source boundary"),
    );
  }
  url.hash = "";
  return Result.ok(url.href);
};

const sourceReference = (value: string) =>
  /\b(?:wp\s+\d+|wp(?!29\b)\d+)(?:[a-z](?![a-z]))?(?:\s*rev\.?\s*\d+|\s*update)?/iu
    .exec(value)
    ?.at(0);
const referenceRevision = (reference: string) => {
  const revision = /(?:rev\.?\s*\d+|update)$/iu.exec(reference)?.at(0);
  return revision
    ? ({ state: "stated", value: revision } as const)
    : ({ state: "not_stated" } as const);
};
const documentKind = (title: string): SoftLawMetadata["kind"] => {
  if (/\bguidelines?\b/iu.test(title)) {
    return "guideline";
  }
  if (/\brecommendation\b/iu.test(title)) {
    return "recommendation";
  }
  if (/\bopinion\b/iu.test(title)) {
    return "opinion";
  }
  if (/\bstatement\b/iu.test(title)) {
    return "statement";
  }
  if (/\bannual report\b/iu.test(title)) {
    return "annual_report";
  }
  if (
    /\b(?:working|discussion|explanatory|strategy) document\b|\bletter\b|\bdeclaration\b|\bpolicy\b|\bjoint contribution\b|\breport\b|\bWP\s*\d+ revised version\b/iu.test(
      title,
    )
  ) {
    return "position";
  }
  if (/\bFAQs?\b/iu.test(title)) {
    return "faq";
  }
  return "other";
};

type Wp29MetadataOptions = {
  title: string;
  reference: string | undefined;
  language: string;
  stage: SoftLawStage;
};
const metadata = ({
  title,
  reference,
  language,
  stage,
}: Wp29MetadataOptions): SoftLawMetadata => ({
  title,
  kind: documentKind(title),
  sourceKind: title,
  statedReference: reference
    ? { state: "stated", value: reference }
    : { state: "not_stated" },
  issuedOn: { state: "not_stated" },
  validity: { state: "not_stated", basis: "archived_source_stated" },
  expression: {
    type: "identified",
    language,
    revision: reference
      ? referenceRevision(reference)
      : { state: "not_stated" },
  },
  stage,
  relations: [],
});

/** The archive carries years and partial dates; none are promoted to adoption dates. */
export const parseWp29Archive = (html: string) => {
  const $ = cheerio.load(html);
  const sections = $(".contentsection.block").filter((_, node) =>
    /^\d{4}$/u.test(normalize($(node).children("h2").text())),
  );
  if (!sections.length) {
    return Result.err(invalid("WP29 archive year sections are missing"));
  }
  const entries: SoftLawEntry[] = [];
  const seen = new Set<string>();
  for (const section of sections.toArray()) {
    const year = normalize($(section).children("h2").text());
    for (const row of $(section).children("ul").children("li").toArray()) {
      const element = $(row);
      const rowText = normalize(element.text());
      const reference = sourceReference(rowText);
      const links = element
        .find("a.link-ico[href]")
        .filter((_, node) =>
          /\.(?:pdf|doc)(?:$|\?)/iu.test($(node).attr("href") ?? ""),
        );
      if (!links.length) {
        if (element.find("a[href]").length || reference) {
          return Result.err(
            invalid("WP29 archive row has no supported document asset"),
          );
        }
        continue;
      }
      // Row assets are fetched and joined as one expression, so a row offering
      // several language renditions would merge them under one language.
      const statedLanguages = new Set(
        links
          .toArray()
          .map((node) => assetLanguage($(node).attr("href") ?? ""))
          .filter((language) => language !== undefined),
      );
      if (statedLanguages.size > 1) {
        return Result.err(
          invalid("WP29 archive row offers several language renditions"),
        );
      }
      const primary = links
        .filter(
          (_, node) =>
            !/^(?:Annex|Press release)/iu.test(
              normalize($(node).children("span").not(".link-size").text()),
            ),
        )
        .first();
      // Press notices in this archive are not independent WP29 instruments.
      if (!primary.length) {
        continue;
      }
      for (const link of primary.toArray()) {
        const anchor = $(link);
        const href = anchor.attr("href");
        const assetTitle = normalize(
          anchor.children("span").not(".link-size").text(),
        );
        const parentTitle = normalize(
          element.clone().children().remove().end().text(),
        );
        const title = /^Part \d+$/iu.test(assetTitle)
          ? parentTitle
          : assetTitle;
        if (
          SOFT_LAW_AUTHORITY_POLICIES["eu-wp29"].kinds[documentKind(title)]
            .type === "excluded"
        ) {
          continue;
        }
        if (!href || !title) {
          return Result.err(invalid("WP29 archive asset has no title or URL"));
        }
        const resolved = publisherUrl(href, ARCHIVE);
        if (resolved.status === "error") {
          return resolved;
        }
        const language =
          assetLanguage(new URL(resolved.value).pathname) ?? "und";
        if (seen.has(resolved.value)) {
          continue;
        }
        seen.add(resolved.value);
        const date = /\(([^()]*)\)\s*$/u.exec(rowText)?.at(1);
        entries.push({
          type: "document",
          url: resolved.value,
          metadata: metadata({
            title,
            reference,
            language,
            stage: { state: "not_stated" },
          }),
          sourceDates: {
            archiveYear: year,
            ...(date && !/\bkB\b/iu.test(date) ? { archiveDate: date } : {}),
          },
          sourcePages: [ARCHIVE],
        });
      }
    }
  }
  if (!entries.length) {
    return Result.err(invalid("WP29 archive has no documents"));
  }
  return Result.ok(entries);
};

export const parseWp29NewsroomIndex = (html: string, url: string) => {
  const $ = cheerio.load(html);
  if (!$("#main-content").length || !$("#leftentityselect").length) {
    return Result.err(invalid("WP29 newsroom category structure is missing"));
  }
  const links = new Set<string>();
  for (const node of $("#main-content a[href]").toArray()) {
    const href = $(node).attr("href");
    if (
      !href ||
      !/\/newsroom\/article29\/redirection\/item\/\d+$/u.test(href)
    ) {
      continue;
    }
    const resolved = publisherUrl(href, url);
    if (resolved.status === "error") {
      return resolved;
    }
    links.add(resolved.value);
  }
  if (!links.size || links.size > MAX_NEWSROOM_ITEMS) {
    return Result.err(invalid("WP29 newsroom category item count is invalid"));
  }
  return Result.ok([...links]);
};

const LANGUAGES = {
  English: "en",
  French: "fr",
  German: "de",
  Spanish: "es",
  Italian: "it",
  Czech: "cs",
  Bulgarian: "bg",
  Danish: "da",
  Dutch: "nl",
  Estonian: "et",
  Finnish: "fi",
  Greek: "el",
  Hungarian: "hu",
  Irish: "ga",
  Latvian: "lv",
  Lithuanian: "lt",
  Maltese: "mt",
  Polish: "pl",
  Portuguese: "pt",
  Romanian: "ro",
  Slovak: "sk",
  Slovenian: "sl",
  Swedish: "sv",
  Croatian: "hr",
} as const;
const languageCode = (value: string) => {
  for (const [name, code] of Object.entries(LANGUAGES)) {
    if (name.toLowerCase() === value.toLowerCase()) {
      return code;
    }
  }
  return undefined;
};

type ParseWp29NewsroomOptions = { html: string; url: string; indexUrl: string };
export const parseWp29NewsroomDocument = ({
  html,
  url,
  indexUrl,
}: ParseWp29NewsroomOptions) => {
  const $ = cheerio.load(html);
  const title = normalize($("#main-content h1.ecl-page-header__title").text());
  const reference = sourceReference(title);
  if (!title) {
    return Result.err(
      invalid("WP29 newsroom document has no title or reference"),
    );
  }
  if (
    SOFT_LAW_AUTHORITY_POLICIES["eu-wp29"].kinds[documentKind(title)].type ===
    "excluded"
  ) {
    return Result.ok([]);
  }
  const publisherDate = normalize(
    $("#nr-additional-info p")
      .filter((_, node) => normalize($(node).find("strong").text()) === "Date")
      .text(),
  ).replace(/^Date\s*:\s*/u, "");
  const entries: SoftLawEntry[] = [];
  const seen = new Set<string>();
  const files = $("#main-content .ecl-file");
  if (files.length > MAX_ASSETS) {
    return Result.err(invalid("WP29 asset limit exceeded"));
  }
  for (const file of files.toArray()) {
    const asset = $(file);
    const format = normalize(asset.find(".ecl-file__meta").text());
    if (/\bZIP\b/iu.test(format)) {
      continue;
    }
    if (!/\bPDF\b/iu.test(format)) {
      return Result.err(invalid("Unsupported WP29 document asset format"));
    }
    const href = asset.find("a.ecl-file__download[href]").attr("href");
    const language = languageCode(
      normalize(asset.find(".ecl-file__language").text()),
    );
    if (!href || !language) {
      return Result.err(invalid("WP29 PDF URL or language is missing"));
    }
    const resolved = publisherUrl(href, url);
    if (resolved.status === "error") {
      return resolved;
    }
    if (seen.has(resolved.value)) {
      continue;
    }
    seen.add(resolved.value);
    entries.push({
      type: "document",
      url: resolved.value,
      metadata: metadata({
        title,
        reference,
        language,
        stage: { state: "not_stated" },
      }),
      sourceDates: publisherDate ? { publisherDate } : {},
      sourcePages: [indexUrl, url],
    });
  }
  if (!entries.length) {
    return Result.err(invalid("WP29 document has no individual PDF asset"));
  }
  return Result.ok(entries);
};

type Wp29Cursor =
  | { type: "archive"; offset: number }
  | { type: "newsroom"; category: number; offset: number };
const parseCursor = (
  cursor: string | null,
): Result<Wp29Cursor, SoftLawIngestionError> => {
  if (cursor === null) {
    return Result.ok({ type: "archive", offset: 0 });
  }
  const archive = /^archive:(\d+)$/u.exec(cursor)?.at(1);
  if (archive && Number.isSafeInteger(Number(archive))) {
    return Result.ok({ type: "archive", offset: Number(archive) });
  }
  const news = /^newsroom:(\d+):(\d+)$/u.exec(cursor);
  const category = Number(news?.at(1));
  const offset = Number(news?.at(2));
  if (
    news &&
    Number.isSafeInteger(category) &&
    category < CATEGORIES.length &&
    Number.isSafeInteger(offset)
  ) {
    return Result.ok({ type: "newsroom", category, offset });
  }
  return Result.err(
    new SoftLawIngestionError({ message: "Invalid WP29 discovery cursor" }),
  );
};

const FIELDS = [
  "title",
  "reference",
  "publisher-date",
  "asset-title",
  "asset-language",
  "asset-format",
  "newsroom-asset-size",
  "archive-asset-size",
  "archive-year",
  "archive-date",
] as const;
const fields = {
  title: { disposition: "stored", target: { type: "metadata", key: "title" } },
  reference: {
    disposition: "stored",
    target: { type: "metadata", key: "statedReference" },
  },
  "publisher-date": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "source-page-1",
      path: [],
      reason:
        "The original newsroom publisher date remains in this HTML and sourceDates.publisherDate; it is not treated as an adoption date.",
    },
  },
  "asset-language": {
    disposition: "stored",
    target: { type: "metadata", key: "expression" },
  },
  "asset-title": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "source-page-1",
      path: [],
      reason:
        "The publisher download title is retained verbatim in the newsroom detail HTML.",
    },
  },
  "asset-format": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "source-page-1",
      path: [],
      reason:
        "The publisher format label is retained in the newsroom detail HTML alongside the verified document bytes.",
    },
  },
  "newsroom-asset-size": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "source-page-1",
      path: [],
      reason:
        "The publisher newsroom size label is retained in the original detail HTML.",
    },
  },
  "archive-asset-size": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "source-page-0",
      path: [],
      reason:
        "The publisher archive download size label is retained verbatim in the original index HTML.",
    },
  },
  "archive-year": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "source-page-0",
      path: [],
      reason:
        "Archive year grouping is retained verbatim in the original index and sourceDates without invented day precision.",
    },
  },
  "archive-date": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "source-page-0",
      path: [],
      reason:
        "Archive date text is retained verbatim in the original index and sourceDates without inferring adoption.",
    },
  },
} as const satisfies Record<(typeof FIELDS)[number], SourceFieldDisposition>;
const SURFACES = [
  "index",
  "detail",
  "document-pdf",
  "document-word",
  "translation-zip",
  "translation-picker",
  "press-notice",
  "excluded-kinds",
  "rss",
  "consultation-responses",
] as const;
const surfaces = {
  index: storedSourceSurface("source-page-0"),
  detail: storedSourceSurface("source-page-1"),
  "document-pdf": storedSourceSurface("document-pdf"),
  "document-word": storedSourceSurface("document-word"),
  "translation-zip": excludedSourceSurface(
    "ZIP is a container requiring a separate archive extraction boundary; only individually identified PDF renditions enter this slice. ZIP contents have not been classified.",
  ),
  "translation-picker": excludedSourceSurface(
    "Legacy JavaScript translation picker is an alternate rendition discovery service; this slice preserves the directly published PDFs only.",
  ),
  "excluded-kinds": excludedSourceSurface(
    "Annual reports, work programmes and unclassified other material are outside the authority's admitted guidance policy; their source rows remain in retained indexes.",
  ),
  "press-notice": excludedSourceSurface(
    "A press notice announces an instrument; it is retained in the archive index but not ingested as another instrument.",
  ),
  rss: excludedSourceSurface(
    "Category change feed duplicates corpus discovery, not per-document metadata.",
  ),
  "consultation-responses": excludedSourceSurface(
    "Third-party consultation submissions are not WP29-authored soft law.",
  ),
} as const satisfies Record<
  (typeof SURFACES)[number],
  SourceSurfaceDisposition
>;

const recoverWp29Reference = (
  original: SoftLawMetadata,
  text: string | null,
) => {
  let documentMetadata = original;
  if (documentMetadata.statedReference.state === "not_stated") {
    // WP29 without a separator is the body's acronym, not an instrument reference.
    const reference =
      /\b(?:WP\s+\d+[a-z]?|WP(?!29\b)\d+[a-z]?)(?:\s*rev\.?\s*\d+|\s*update)?\b/iu
        .exec(text?.slice(0, 1500) ?? "")
        ?.at(0);
    if (!reference) {
      return Result.err(
        invalid("WP29 document reference is absent from title and PDF header"),
      );
    }
    const expression = documentMetadata.expression;
    if (expression?.type !== "identified") {
      return Result.err(invalid("WP29 expression is not identified"));
    }
    documentMetadata = {
      ...documentMetadata,
      statedReference: { state: "stated", value: reference },
      expression: {
        type: "identified",
        language: expression.language,
        revision: referenceRevision(reference),
      },
    };
  }
  return Result.ok(documentMetadata);
};

const listWp29Assets = (entry: SoftLawEntry) => {
  const assets = [entry.url];
  if (entry.sourcePages?.at(0) === ARCHIVE) {
    const listing = entry.sourceRaw?.find(
      ({ role }) => role === "source-page-0",
    );
    if (!listing) {
      return Result.err(invalid("WP29 archive raw is missing"));
    }
    const $ = cheerio.load(
      Buffer.from(listing.contentBase64, "base64").toString("utf-8"),
    );
    const row = $(".contentsection.block > ul > li").filter((_, node) =>
      $(node)
        .find("a.link-ico[href]")
        .toArray()
        .some((anchor) => {
          const href = $(anchor).attr("href");
          if (!href) {
            return false;
          }
          const resolved = publisherUrl(href, ARCHIVE);
          return resolved.status === "ok" && resolved.value === entry.url;
        }),
    );
    if (row.length !== 1) {
      return Result.err(invalid("WP29 archive asset has no unique source row"));
    }
    for (const anchor of row.find("a.link-ico[href]").toArray()) {
      const title = normalize(
        $(anchor).children("span").not(".link-size").text(),
      );
      if (/^Press release/iu.test(title)) {
        continue;
      }
      const href = $(anchor).attr("href");
      if (!href) {
        return Result.err(invalid("WP29 archive attachment URL is missing"));
      }
      const resolved = publisherUrl(href, ARCHIVE);
      if (resolved.status === "error") {
        return resolved;
      }
      if (!/\.(?:pdf|doc)$/iu.test(new URL(resolved.value).pathname)) {
        return Result.err(
          invalid("WP29 archive attachment format is unsupported"),
        );
      }
      if (!assets.includes(resolved.value)) {
        assets.push(resolved.value);
      }
    }
  }
  return Result.ok(assets);
};

export const wp29Adapter = {
  key: "eu-wp29",
  authority: "eu-wp29",
  access: {
    publisherGate: "commission-eu",
    userAgent: "Stella/1.0 (+https://github.com/stella/stella)",
    window: { type: "any_time" },
  },
  getTotalCount: async () =>
    await Promise.resolve({ type: "no-count-endpoint" as const }),
  sliceWalk: {
    type: "unsupported",
    reason:
      "WP29 has overlapping archive and newsroom indexes without a stable date slice endpoint.",
  },
  sourceFields: {
    status: "declared",
    fields,
    listSourceFields: (parts) => {
      const discovered = new Set<string>();
      for (const html of Object.values(parts)) {
        const $ = cheerio.load(html);
        if ($("h1.ecl-page-header__title, .contentsection a.link-ico").length) {
          discovered.add("title");
        }
        if (sourceReference($.text())) {
          discovered.add("reference");
        }
        if ($("#nr-additional-info strong").length) {
          discovered.add("publisher-date");
        }
        if ($(".ecl-file__title").length) {
          discovered.add("asset-title");
        }
        if ($(".ecl-file__language").length) {
          discovered.add("asset-language");
        }
        if ($(".ecl-file__meta").length) {
          discovered.add("asset-format");
        }
        if ($(".ecl-file__meta").length) {
          discovered.add("newsroom-asset-size");
        }
        if ($(".link-size").length) {
          discovered.add("archive-asset-size");
        }
        if ($(".contentsection h2").length) {
          discovered.add("archive-year");
        }
        if ($(".contentsection li br").length) {
          discovered.add("archive-date");
        }
      }
      return [...discovered];
    },
  },
  sourceSurfaces: { surfaces },
  discover: async ({ cursor, signal, fetch: read }) => {
    if (signal.aborted) {
      return Result.err(
        new SoftLawIngestionError({ message: "WP29 request aborted" }),
      );
    }
    const parsedCursor = parseCursor(cursor);
    if (parsedCursor.status === "error") {
      return parsedCursor;
    }
    const state = parsedCursor.value;
    if (state.type === "archive") {
      const fetched = await read(ARCHIVE, {
        expectedContentTypes: HTML_TYPES,
      });
      if (fetched.status === "error") {
        return fetched;
      }
      const response = fetched.value;
      const parsed = parseWp29Archive(new TextDecoder().decode(response.bytes));
      if (parsed.status === "error") {
        return parsed;
      }
      const entries = parsed.value;
      const batch = entries
        .slice(state.offset, state.offset + SOFT_LAW_BATCH_LIMIT)
        .map((entry) => ({
          ...entry,
          sourceRaw: [
            {
              role: "source-page-0",
              contentBase64: Buffer.from(response.bytes).toBase64(),
              contentType: response.contentType,
            },
          ],
        }));
      if (!batch.length) {
        return Result.err(
          new SoftLawIngestionError({
            message: "WP29 archive cursor exceeds listing",
          }),
        );
      }
      const offset = state.offset + batch.length;
      return Result.ok({
        entries: batch,
        nextCursor:
          offset < entries.length ? `archive:${offset}` : "newsroom:0:0",
      });
    }
    const category = CATEGORIES.at(state.category);
    if (!category) {
      return Result.err(
        new SoftLawIngestionError({
          message: "Invalid WP29 newsroom category",
        }),
      );
    }
    const indexUrl = `${NEWSROOM}items/itemType/${category}`;
    const indexResponse = await read(indexUrl, {
      expectedContentTypes: HTML_TYPES,
    });
    if (indexResponse.status === "error") {
      return indexResponse;
    }
    const index = indexResponse.value;
    const parsedIndex = parseWp29NewsroomIndex(
      new TextDecoder().decode(index.bytes),
      indexUrl,
    );
    if (parsedIndex.status === "error") {
      return parsedIndex;
    }
    const items = parsedIndex.value;
    const url = items.at(state.offset);
    if (!url) {
      return Result.err(
        new SoftLawIngestionError({
          message: "WP29 newsroom cursor exceeds listing",
        }),
      );
    }
    const detailResponse = await read(url, {
      expectedContentTypes: HTML_TYPES,
    });
    if (detailResponse.status === "error") {
      return detailResponse;
    }
    const detail = detailResponse.value;
    const nextCategory = state.category + 1;
    let nextCursor: string | null = null;
    if (state.offset + 1 < items.length) {
      nextCursor = `newsroom:${state.category}:${state.offset + 1}`;
    } else if (nextCategory < CATEGORIES.length) {
      nextCursor = `newsroom:${nextCategory}:0`;
    }
    const sourceRaw = [
      {
        role: "source-page-0",
        contentBase64: Buffer.from(index.bytes).toBase64(),
        contentType: index.contentType,
      },
      {
        role: "source-page-1",
        contentBase64: Buffer.from(detail.bytes).toBase64(),
        contentType: detail.contentType,
      },
    ];
    const parsedDocument = parseWp29NewsroomDocument({
      html: new TextDecoder().decode(detail.bytes),
      url,
      indexUrl,
    });
    if (parsedDocument.status === "error") {
      const rejection = softLawItemErrorRejection({
        error: parsedDocument.error,
        url,
        sourceRaw,
      });
      if (rejection) {
        return Result.ok({ entries: [rejection], nextCursor });
      }
      return parsedDocument;
    }
    const entries = parsedDocument.value;
    return Result.ok({
      entries: entries.map((entry) => ({
        ...entry,
        sourceRaw,
      })),
      nextCursor,
    });
  },
  fetchDocument: async (entry, { signal, fetch: read }) => {
    if (signal.aborted) {
      return Result.err(
        new SoftLawIngestionError({ message: "WP29 request aborted" }),
      );
    }
    const pages = entry.sourcePages;
    if (pages === undefined || pages.length === 0 || pages.length > 3) {
      return Result.err(invalid("WP29 entry has no bounded source pages"));
    }
    const assetUrl = publisherUrl(entry.url, ORIGIN);
    if (assetUrl.status === "error") {
      return assetUrl;
    }
    const retained = entry.sourceRaw;
    if (
      retained === undefined ||
      retained.length === 0 ||
      retained.length > 3
    ) {
      return Result.err(invalid("WP29 entry has no discovery raw"));
    }
    for (const page of pages) {
      const validated = publisherUrl(page, ORIGIN);
      if (validated.status === "error") {
        return validated;
      }
    }
    const raw: SoftLawDocumentInput["raw"][number][] = retained.map(
      ({ role, contentBase64, contentType }) => ({
        role,
        bytes: Buffer.from(contentBase64, "base64"),
        contentType,
        purpose: "discovery",
      }),
    );
    const listedAssets = listWp29Assets(entry);
    if (listedAssets.status === "error") {
      return listedAssets;
    }
    const assets = listedAssets.value;
    if (assets.length + raw.length > MAX_ASSETS) {
      return Result.err(invalid("WP29 document raw part limit exceeded"));
    }
    const texts: string[] = [];
    let extractionQuality: "text_layer" | "needs_ocr" = "text_layer";
    const extractionFailures: string[] = [];
    for (const [index, url] of assets.entries()) {
      signal.throwIfAborted();
      const word = /\.doc$/iu.test(new URL(url).pathname);
      const document = await read(url, {
        expectedContentTypes: word
          ? ["application/msword", "application/vnd.ms-word"]
          : PDF_TYPES,
      });
      if (document.status === "error") {
        return document;
      }
      const partRole = word ? "document-word" : "document-pdf";
      raw.push({
        role: index === 0 ? partRole : `${partRole}-${index}`,
        purpose: "document",
        bytes: Buffer.from(document.value.bytes),
        contentType: document.value.contentType,
      });
      if (word) {
        extractionFailures.push(
          "Binary Word document extraction is unsupported",
        );
        continue;
      }
      const extracted = await extractSoftLawPdfText(document.value.bytes);
      if (extracted.extractionQuality === "extraction_failed") {
        extractionFailures.push(extracted.extractionFailure);
      }
      if (extracted.text) {
        texts.push(extracted.text);
      }
      if (extracted.extractionQuality === "needs_ocr") {
        extractionQuality = "needs_ocr";
      }
    }
    const text = texts.length ? texts.join("\n\n") : null;
    if (extractionFailures.length) {
      let documentMetadata = entry.metadata;
      if (text) {
        const recoveredMetadata = recoverWp29Reference(entry.metadata, text);
        if (recoveredMetadata.status === "ok") {
          documentMetadata = recoveredMetadata.value;
        }
      }
      return Result.ok({
        metadata: documentMetadata,
        raw,
        text: null,
        extractionQuality: "extraction_failed",
        extractionFailure: extractionFailures.join("; "),
        sourceDates: entry.sourceDates,
      });
    }
    const recoveredMetadata = text
      ? recoverWp29Reference(entry.metadata, text)
      : Result.ok(entry.metadata);
    if (recoveredMetadata.status === "error") {
      return recoveredMetadata;
    }
    return Result.ok({
      metadata: recoveredMetadata.value,
      raw,
      text,
      extractionQuality,
      sourceDates: entry.sourceDates,
    });
  },
} as const satisfies SoftLawSourceAdapter;
