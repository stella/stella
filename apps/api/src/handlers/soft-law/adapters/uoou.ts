import { Result } from "better-result";
import { load } from "cheerio";
import * as v from "valibot";

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
  SoftLawFetchError,
  SoftLawResponse,
} from "@/api/lib/legal-search/soft-law-access-types";
import {
  SoftLawIngestionError,
  SoftLawPageBudgetError,
} from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawEntry,
  SoftLawDocumentInput,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import {
  classifyUoouUrl,
  listUoouSourceFields,
  parseUoouPage,
  UOOU_DATE_SCHEMA,
  UOOU_ORIGIN,
  UOOU_TIMESTAMP_SCHEMA,
} from "./uoou-pages";

const INDEX_URL = `${UOOU_ORIGIN}/sitemap/index.xml`;
const CS_URL = `${UOOU_ORIGIN}/sitemap/cs.xml`;
const DISCOVERY_LIMIT = 100;
export const UOOU_PARSER_REVISION = 1;
const decode = (response: SoftLawResponse) =>
  Result.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(response.bytes),
    catch: (cause) =>
      new SoftLawIngestionError({
        message: "Publisher response is not valid UTF-8",
        cause,
      }),
  });

type UoouListingResult = Result<
  SoftLawEntry[],
  SoftLawIngestionError | SoftLawFetchError
>;
const listingSnapshots = new WeakMap<
  SoftLawFetch,
  Promise<UoouListingResult>
>();
const readListing = async (
  request: SoftLawFetch,
): Promise<UoouListingResult> => {
  const indexResponse = await request(INDEX_URL, { surface: "page" });
  if (indexResponse.status === "error") {
    return indexResponse;
  }
  const indexText = decode(indexResponse.value);
  if (indexText.status === "error") {
    return indexText;
  }
  const index = load(indexText.value, {
    xml: true,
  });
  if (
    !index("sitemapindex > sitemap > loc")
      .toArray()
      .some((node) => index(node).text().trim() === CS_URL)
  ) {
    return Result.err(
      new SoftLawIngestionError({
        message: "Czech sitemap is absent from the index",
      }),
    );
  }
  const sitemapResponse = await request(CS_URL, { surface: "page" });
  if (sitemapResponse.status === "error") {
    return sitemapResponse;
  }
  const sitemapText = decode(sitemapResponse.value);
  if (sitemapText.status === "error") {
    return sitemapText;
  }
  const sitemap = load(sitemapText.value, {
    xml: true,
  });
  if (!sitemap("urlset").length) {
    return Result.err(
      new SoftLawIngestionError({ message: "Invalid Czech sitemap" }),
    );
  }
  const entries = new Map<string, SoftLawEntry>();
  for (const row of sitemap("urlset > url").toArray()) {
    const url = sitemap(row).children("loc").text().trim();
    if (classifyUoouUrl(url).type === "excluded") {
      continue;
    }
    const lastmod = sitemap(row).children("lastmod").text().trim();
    if (
      lastmod &&
      !v.safeParse(UOOU_DATE_SCHEMA, lastmod).success &&
      !v.safeParse(UOOU_TIMESTAMP_SCHEMA, lastmod).success
    ) {
      return Result.err(
        new SoftLawIngestionError({ message: "Invalid sitemap revision" }),
      );
    }
    const prior = entries.get(url);
    if (
      prior &&
      prior.sourceDates["sitemap.lastmod"] !== (lastmod || undefined)
    ) {
      return Result.err(
        new SoftLawIngestionError({
          message: "Conflicting sitemap revisions",
        }),
      );
    }
    entries.set(url, {
      url,
      metadata: null,
      sourceDates: lastmod ? { "sitemap.lastmod": lastmod } : {},
      ...(lastmod
        ? { cacheKey: JSON.stringify([UOOU_PARSER_REVISION, lastmod]) }
        : {}),
    });
  }
  if (!entries.size) {
    return Result.err(
      new SoftLawIngestionError({
        message: "Guidance listing is unexpectedly empty",
      }),
    );
  }
  return Result.ok(
    [...entries.values()].toSorted((a, b) => {
      if (a.url < b.url) {
        return -1;
      }
      if (a.url > b.url) {
        return 1;
      }
      return 0;
    }),
  );
};
const discoverListing = (request: SoftLawFetch) => {
  const existing = listingSnapshots.get(request);
  if (existing) {
    return existing;
  }
  const listing = readListing(request);
  listingSnapshots.set(request, listing);
  return listing;
};

type ExtractAttachmentOptions = { response: SoftLawResponse; url: string };
type ExtractAttachmentResult = Result<string, SoftLawIngestionError>;
const extractAttachment = async ({
  response,
  url,
}: ExtractAttachmentOptions): Promise<ExtractAttachmentResult> => {
  const mime = response.contentType.split(";").at(0)?.trim().toLowerCase();
  if (new URL(url).pathname.toLowerCase().endsWith(".pdf")) {
    if (
      mime !== "application/pdf" ||
      new TextDecoder().decode(response.bytes.subarray(0, 5)) !== "%PDF-"
    ) {
      return Result.err(
        new SoftLawIngestionError({
          message: "PDF attachment has an unexpected format",
        }),
      );
    }
    return await Result.tryPromise({
      try: async () => {
        const { PDF } = await import("@libpdf/core");
        const pdf = await PDF.load(response.bytes);
        return pdf
          .getPages()
          .map((page) =>
            page
              .extractText()
              .lines.map((line) => line.text)
              .join("\n"),
          )
          .join("\n\n")
          .trim();
      },
      catch: (cause) =>
        new SoftLawIngestionError({
          message: "PDF attachment extraction failed",
          cause,
        }),
    });
  }
  if (mime !== DOCX_MIME_TYPE) {
    return Result.err(
      new SoftLawIngestionError({
        message: "DOCX attachment has an unexpected format",
      }),
    );
  }
  const extraction = await Result.tryPromise({
    try: async (): Promise<ExtractAttachmentResult> => {
      const { scanUpload } = await import("@/api/lib/file-scan/scan-upload");
      const { extractScannedDocxText } =
        await import("@/api/lib/file-scan/document-parsers");
      const scanned = await scanUpload({
        bytes: response.bytes,
        declaredMimeType: DOCX_MIME_TYPE,
        fileName: new URL(url).pathname.split("/").at(-1) ?? "guidance.docx",
      });
      if (scanned.status === "error") {
        return Result.err(
          new SoftLawIngestionError({
            message: "DOCX attachment security scan failed",
            cause: scanned.error,
          }),
        );
      }
      return Result.ok((await extractScannedDocxText(scanned.value)).trim());
    },
    catch: (cause) =>
      new SoftLawIngestionError({
        message: "DOCX attachment extraction failed",
        cause,
      }),
  });
  return extraction.andThen((result) => result);
};

const fetchDocument: SoftLawSourceAdapter["fetchDocument"] = async (
  entry,
  context,
) => {
  if (context.signal.aborted) {
    return Result.err(
      new SoftLawIngestionError({
        message: "Guidance request was aborted",
        cause: context.signal.reason,
      }),
    );
  }
  const fetchedPage = await context.fetch(entry.url, { surface: "page" });
  if (fetchedPage.status === "error") {
    return fetchedPage;
  }
  const page = fetchedPage.value;
  let rawByteLength = page.bytes.byteLength;
  if (rawByteLength > context.maxRawBytes) {
    return Result.err(
      new SoftLawPageBudgetError({
        message: "Guidance exceeds the remaining page byte budget",
      }),
    );
  }
  if (!/^text\/html(?:;|$)/iu.test(page.contentType)) {
    return Result.err(
      new SoftLawIngestionError({
        message: "Guidance page has an unexpected content type",
      }),
    );
  }
  const pageText = decode(page);
  if (pageText.status === "error") {
    return pageText;
  }
  const parsedPage = parseUoouPage(pageText.value, entry.url);
  if (parsedPage.status === "error") {
    return parsedPage;
  }
  const parsed = parsedPage.value;
  if (parsed.excluded) {
    return Result.ok({ type: "excluded", reason: parsed.excluded });
  }
  const raw = [
    { role: "page", bytes: page.bytes, contentType: page.contentType },
  ];
  const texts = [parsed.text];
  let extractionQuality: SoftLawDocumentInput["extractionQuality"] = "html";
  for (const url of parsed.attachments) {
    if (context.signal.aborted) {
      return Result.err(
        new SoftLawIngestionError({
          message: "Guidance request was aborted",
          cause: context.signal.reason,
        }),
      );
    }
    // Fetch remains outside the extraction error boundary: blocks stop the source.
    const fetchedAttachment = await context.fetch(url, {
      surface: "attachment",
      expectedContentTypes: [
        new URL(url).pathname.toLowerCase().endsWith(".pdf")
          ? "application/pdf"
          : DOCX_MIME_TYPE,
      ],
    });
    if (fetchedAttachment.status === "error") {
      return fetchedAttachment;
    }
    const response = fetchedAttachment.value;
    rawByteLength += response.bytes.byteLength;
    if (rawByteLength > context.maxRawBytes) {
      return Result.err(
        new SoftLawPageBudgetError({
          message: "Guidance attachments exceed the remaining page byte budget",
        }),
      );
    }
    raw.push({
      role: `attachment:${url}`,
      bytes: response.bytes,
      contentType: response.contentType,
    });
    const extracted = await extractAttachment({ response, url });
    if (extracted.status === "error") {
      extractionQuality = "extraction_failed";
      continue;
    }
    if (!extracted.value) {
      if (extractionQuality !== "extraction_failed") {
        extractionQuality = "needs_ocr";
      }
      continue;
    }
    texts.push(extracted.value);
    if (extractionQuality === "html") {
      extractionQuality = "text_layer";
    }
  }
  return Result.ok({
    type: "document",
    metadata: parsed.metadata,
    raw,
    text: texts.join("\n\n"),
    extractionQuality,
    sourceDates: { ...entry.sourceDates, ...parsed.sourceDates },
  });
};

const SOURCE_FIELDS = [
  "title",
  "body",
  "questions",
  "attachments",
  "jsonld.@context",
  "jsonld.@type",
  "jsonld.breadcrumb",
  "jsonld.headline",
  "jsonld.name",
  "jsonld.dateCreated",
  "jsonld.datePublished",
  "jsonld.dateModified",
  "jsonld.url",
] as const;
const rawField = (reason: string) =>
  ({
    disposition: "stored",
    target: { type: "rawText", part: "page", reason },
  }) as const;
const FIELD_DISPOSITIONS = {
  title: { disposition: "stored", target: { type: "metadata", key: "title" } },
  body: { disposition: "stored", target: { type: "document" } },
  questions: { disposition: "stored", target: { type: "document" } },
  attachments: rawField(
    "Attachment URLs are retained in the original page and attachment raw-object roles",
  ),
  "jsonld.@context": rawField("Publisher JSON-LD context retained verbatim"),
  "jsonld.@type": rawField("Publisher schema type retained verbatim"),
  "jsonld.breadcrumb": rawField(
    "Publisher breadcrumb identifiers retained verbatim",
  ),
  "jsonld.headline": rawField(
    "Publisher headline retained alongside the displayed title",
  ),
  "jsonld.name": rawField("Publisher name retained verbatim"),
  "jsonld.dateCreated": rawField(
    "CMS creation date retained verbatim and projected into sourceDates",
  ),
  "jsonld.datePublished": rawField(
    "CMS publication date retained verbatim and projected into sourceDates",
  ),
  "jsonld.dateModified": rawField(
    "CMS modification date retained verbatim and projected into sourceDates",
  ),
  "jsonld.url": rawField("Publisher URL retained verbatim"),
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;

const SOURCE_SURFACES = [
  "html",
  "pdf",
  "docx",
  "sitemap_index",
  "czech_sitemap",
  "edpb_translations",
  "president_decisions",
  "third_party_publications",
] as const;
const SURFACE_DISPOSITIONS = {
  html: storedSourceSurface("page"),
  pdf: storedSourceSurface("attachment:<url>"),
  docx: storedSourceSurface("attachment:<url>"),
  sitemap_index: excludedSourceSurface(
    "Discovery-only index; no document body or document metadata",
  ),
  czech_sitemap: excludedSourceSurface(
    "Listing URL and lastmod are persisted on locators; sitemap bytes are not document content",
  ),
  edpb_translations: excludedSourceSurface(
    "Translations of another authority's publications are outside this source",
  ),
  president_decisions: excludedSourceSurface(
    "Decisions belong to the case-law family",
  ),
  third_party_publications: excludedSourceSurface(
    "Third-party publications are outside this authority's guidance",
  ),
} as const satisfies Record<
  (typeof SOURCE_SURFACES)[number],
  SourceSurfaceDisposition
>;

export const uoouAdapter = {
  key: "cz-uoou",
  authority: "cz-uoou",
  access: {
    publisherGate: "uoou-cz",
    userAgent: "Stella/1.0 (+https://github.com/stella/stella)",
    window: { type: "any_time" },
  },
  discover: async ({ cursor, signal, fetch }) => {
    if (signal.aborted) {
      return Result.err(
        new SoftLawIngestionError({
          message: "Guidance discovery was aborted",
          cause: signal.reason,
        }),
      );
    }
    if (cursor !== null && classifyUoouUrl(cursor).type !== "guidance") {
      return Result.err(
        new SoftLawIngestionError({ message: "Invalid guidance cursor" }),
      );
    }
    const listing = await discoverListing(fetch);
    if (listing.status === "error") {
      return listing;
    }
    const remaining =
      cursor === null
        ? listing.value
        : listing.value.filter((entry) => entry.url > cursor);
    const entries = remaining.slice(0, DISCOVERY_LIMIT);
    return Result.ok({
      entries,
      nextCursor:
        remaining.length > DISCOVERY_LIMIT
          ? (entries.at(-1)?.url ?? null)
          : null,
    });
  },
  fetchDocument,
  getTotalCount: async ({ signal, fetch }) => {
    if (signal.aborted) {
      return Result.err(
        new SoftLawIngestionError({
          message: "Guidance discovery was aborted",
          cause: signal.reason,
        }),
      );
    }
    const listing = await discoverListing(fetch);
    if (listing.status === "error") {
      return listing;
    }
    return Result.ok({ type: "count", total: listing.value.length } as const);
  },
  sliceWalk: {
    type: "unsupported",
    reason: "Publisher supplies one sitemap, without date slices",
  },
  sourceFields: {
    status: "declared",
    fields: FIELD_DISPOSITIONS,
    listSourceFields: listUoouSourceFields,
  },
  sourceSurfaces: { surfaces: SURFACE_DISPOSITIONS },
} as const satisfies SoftLawSourceAdapter;
