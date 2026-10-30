import { Result } from "better-result";
import { load } from "cheerio";
import * as v from "valibot";

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
import { extractSoftLawPdfText } from "@/api/lib/legal-search/soft-law-document-text";
import {
  type SoftLawEntry,
  SoftLawIngestionError,
  SoftLawItemError,
  type SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";

const ORIGIN = "https://dataprotection.gov.sk";
const INDEX_URL = `${ORIGIN}/sk/urad/o-nas/vyrocne-spravy/`;
const REPORT_PATH = /^\/files\/annual-reports\/[^/]+\.pdf$/u;
/** The index heading; the publisher's own label for the collection. */
const SOURCE_KIND = "Výročné správy";
const HTML_TYPES = ["text/html", "application/xhtml+xml"] as const;
const PDF_TYPES = ["application/pdf", "application/octet-stream"] as const;
/** Reports run to a few megabytes; five keep a page far below its raw byte limit. */
const DISCOVERY_BATCH_LIMIT = 5;
const cursorSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d*)$/u),
  v.toNumber(),
  v.safeInteger(),
);

const invalid = (message: string) =>
  Result.err(new SoftLawIngestionError({ message }));
const invalidItem = (message: string) =>
  Result.err(new SoftLawItemError({ message, tag: "invalid_document" }));
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
const publisherUrl = (value: string, base = ORIGIN) =>
  Result.gen(function* () {
    const parsed = Result.try(() => new URL(value, base));
    if (
      parsed.isErr() ||
      parsed.value.origin !== ORIGIN ||
      parsed.value.username ||
      parsed.value.password ||
      parsed.value.hash ||
      /%2f|%5c|\\/iu.test(parsed.value.pathname)
    ) {
      return yield* invalid("Invalid ÚOOÚ SR publisher locator");
    }
    return Result.ok(parsed.value.href);
  });

type UoouSkReport = { title: string; url: string };
type UoouSkListing = {
  sourceKind: string;
  language: string;
  reports: readonly UoouSkReport[];
};

/** The index is one unpaginated table; any other shape fails the walk instead of shrinking it. */
export const parseUoouSkListing = (html: string) =>
  Result.gen(function* () {
    const $ = load(html);
    const canonicalHref = $('link[rel="canonical"]').attr("href");
    const canonical = canonicalHref ? yield* publisherUrl(canonicalHref) : "";
    const article = $("main article");
    const sourceKind = compact(article.find("h3").first().text());
    const language = $("html").attr("lang")?.trim() ?? "";
    if (
      canonical !== INDEX_URL ||
      article.length !== 1 ||
      sourceKind !== SOURCE_KIND ||
      !/^sk(?:-[a-z0-9]{2,8})*$/iu.test(language)
    ) {
      return yield* invalid(
        "ÚOOÚ SR response lacks its annual-report index shell",
      );
    }
    if (
      article.find('.pagination, .pager, a[rel~="next"], a[href*="page="]')
        .length
    ) {
      return yield* invalid(
        "ÚOOÚ SR annual-report index contains unsupported pagination",
      );
    }
    const rows = article
      .find(".site_browse table.tabulkaStandard tbody tr")
      .toArray();
    if (rows.length === 0) {
      return yield* invalid("ÚOOÚ SR annual-report index lists no reports");
    }
    const reports: UoouSkReport[] = [];
    const urls = new Set<string>();
    const titles = new Set<string>();
    for (const element of rows) {
      const row = $(element);
      const title = compact(row.find("td.fN").text());
      const links = row.find("td.fS a[href]");
      const href = links.attr("href");
      if (!title || links.length !== 1 || !href) {
        return yield* invalid(
          "ÚOOÚ SR annual-report row lacks a title or a single locator",
        );
      }
      const url = yield* publisherUrl(href, INDEX_URL);
      const parsed = new URL(url);
      if (!REPORT_PATH.test(parsed.pathname) || parsed.search) {
        return yield* invalid(
          "ÚOOÚ SR annual-report row does not name a report document",
        );
      }
      const titleKey = title.toLocaleLowerCase("sk");
      if (urls.has(url) || titles.has(titleKey)) {
        return yield* invalid(
          "ÚOOÚ SR annual-report index repeats a report title or locator",
        );
      }
      urls.add(url);
      titles.add(titleKey);
      reports.push({ title, url });
    }
    return Result.ok({
      sourceKind,
      language,
      reports,
    } satisfies UoouSkListing);
  });

type ListedReportEntryOptions = {
  listing: UoouSkListing;
  report: UoouSkReport;
};
const listedReportEntry = ({ listing, report }: ListedReportEntryOptions) =>
  ({
    type: "document",
    url: report.url,
    sourcePages: [INDEX_URL],
    metadata: {
      title: report.title,
      kind: "annual_report",
      sourceKind: listing.sourceKind,
      statedReference: { state: "not_stated" },
      issuedOn: { state: "not_stated" },
      expression: {
        type: "identified",
        language: listing.language,
        revision: { state: "not_stated" },
      },
      stage: { state: "not_stated" },
      relations: [],
      validity: { state: "not_stated", basis: "source_stated" },
    },
    sourceDates: {},
  }) as const satisfies SoftLawEntry;

const SOURCE_FIELDS = [
  "collection",
  "language",
  "title",
  "download",
  "file-label",
] as const;
const FIELD_SELECTORS = {
  collection: "main article h3",
  language: "html[lang]",
  title: "main article table.tabulkaStandard td.fN",
  download: "main article table.tabulkaStandard td.fS a[href]",
  "file-label": "main article table.tabulkaStandard td.fS span",
} as const satisfies Record<(typeof SOURCE_FIELDS)[number], string>;
const SOURCE_FIELD_DISPOSITIONS = {
  collection: {
    disposition: "stored",
    target: { type: "metadata", key: "sourceKind" },
  },
  language: {
    disposition: "stored",
    target: { type: "metadata", key: "expression" },
  },
  title: { disposition: "stored", target: { type: "metadata", key: "title" } },
  download: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "index",
      path: [],
      reason:
        "The download locator is the expression's URL; the row remains verbatim in the index response.",
    },
  },
  "file-label": {
    disposition: "stored",
    target: {
      type: "raw",
      part: "index",
      path: [],
      reason:
        "The stated format and size remain verbatim in the index response; the document part holds the served bytes.",
    },
  },
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;
const SOURCE_SURFACES = ["index", "document", "other-collections"] as const;
const SOURCE_SURFACE_DISPOSITIONS = {
  index: storedSourceSurface("index"),
  document: storedSourceSurface("document"),
  "other-collections": excludedSourceSurface(
    "Other sections are empty, EDPB-authored, third-party or non-guidance pages; the authority policy records each kind with its evidence.",
  ),
} as const satisfies Record<
  (typeof SOURCE_SURFACES)[number],
  SourceSurfaceDisposition
>;

export const uoouSkAdapter = {
  key: "sk-uoou",
  authority: "sk-uoou",
  access: {
    publisherGate: "uoou-sk",
    userAgent: "Stella/1.0 (+https://github.com/stella/stella)",
    window: { type: "any_time" },
  },
  discover: async ({ cursor, fetch: read }) =>
    await Result.gen(async function* () {
      const position = v.safeParse(cursorSchema, cursor ?? "0");
      if (!position.success) {
        return yield* invalid("Invalid ÚOOÚ SR discovery cursor");
      }
      const offset = position.output;
      const response = yield* await read(INDEX_URL, {
        expectedContentTypes: HTML_TYPES,
      });
      const retrievedAt = Temporal.Now.instant().toString();
      const listing = yield* parseUoouSkListing(
        new TextDecoder().decode(response.bytes),
      );
      const captured = {
        role: "index",
        contentBase64: Buffer.from(response.bytes).toString("base64"),
        contentType: response.contentType,
        provenance: {
          url: INDEX_URL,
          retrievedAt,
          sha256: sha256Hex(response.bytes),
        },
      };
      const batch = listing.reports.slice(
        offset,
        offset + DISCOVERY_BATCH_LIMIT,
      );
      const next = offset + batch.length;
      return Result.ok({
        entries: batch.map((report) => ({
          ...listedReportEntry({ listing, report }),
          sourceRaw: [captured],
        })),
        nextCursor: next < listing.reports.length ? String(next) : null,
      });
    }),
  fetchDocument: async (entry, { fetch: read }) =>
    await Result.gen(async function* () {
      const index =
        entry.sourceRaw?.length === 1 ? entry.sourceRaw.at(0) : null;
      const indexBytes = Buffer.from(index?.contentBase64 ?? "", "base64");
      if (
        !index ||
        index.role !== "index" ||
        index.provenance?.url !== INDEX_URL ||
        sha256Hex(indexBytes) !== index.provenance.sha256
      ) {
        return yield* invalidItem(
          "ÚOOÚ SR retry lacks its captured annual-report index",
        );
      }
      // Metadata comes from the captured publisher bytes, not the stored receipt.
      const listing = yield* parseUoouSkListing(
        new TextDecoder().decode(indexBytes),
      );
      const report = listing.reports.find(
        (candidate) => candidate.url === entry.url,
      );
      if (!report) {
        return yield* invalidItem(
          "ÚOOÚ SR report is absent from its captured index",
        );
      }
      const listed = listedReportEntry({ listing, report });
      const document = yield* await read(listed.url, {
        expectedContentTypes: PDF_TYPES,
      });
      if (new TextDecoder().decode(document.bytes.subarray(0, 5)) !== "%PDF-") {
        return yield* invalidItem("ÚOOÚ SR report response is not a PDF");
      }
      const extraction = await extractSoftLawPdfText(document.bytes);
      return Result.ok({
        metadata: listed.metadata,
        sourceDates: listed.sourceDates,
        raw: [
          {
            role: "index",
            bytes: indexBytes,
            contentType: index.contentType,
            purpose: "discovery" as const,
            provenance: index.provenance,
          },
          {
            role: "document",
            bytes: document.bytes,
            contentType: document.contentType,
            purpose: "document" as const,
            provenance: {
              url: listed.url,
              retrievedAt: Temporal.Now.instant().toString(),
              sha256: sha256Hex(document.bytes),
            },
          },
        ],
        ...extraction,
      });
    }),
  getTotalCount: async () =>
    await Promise.resolve({ type: "no-count-endpoint" as const }),
  sliceWalk: {
    type: "unsupported",
    reason:
      "The publisher serves one undated, unpaginated annual-report index and no count endpoint.",
  },
  sourceFields: {
    status: "declared",
    fields: SOURCE_FIELD_DISPOSITIONS,
    listSourceFields: (parts) => {
      const $ = load(parts["index"] ?? "");
      return SOURCE_FIELDS.filter(
        (field) => $(FIELD_SELECTORS[field]).length > 0,
      );
    },
  },
  sourceSurfaces: { surfaces: SOURCE_SURFACE_DISPOSITIONS },
} as const satisfies SoftLawSourceAdapter;
