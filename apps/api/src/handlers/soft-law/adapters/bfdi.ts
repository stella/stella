import { Result } from "better-result";
import * as v from "valibot";

import { load } from "@stll/html";
import { sha256Hex } from "@stll/sha256/bun";
import { readCappedBytes } from "@stll/skills/streaming";
import { parsePlainDate, Temporal } from "@stll/time";

import {
  excludedSourceSurface,
  storedSourceSurface,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  SourceFieldDisposition,
  SourceSurfaceDisposition,
} from "@/api/lib/legal-search/ingestion-types";
import type { SoftLawResponse } from "@/api/lib/legal-search/soft-law-access-types";
import { extractSoftLawPdfText } from "@/api/lib/legal-search/soft-law-document-text";
import {
  type SoftLawAdapterConfiguration,
  type SoftLawEntry,
  SoftLawIngestionError,
  SoftLawItemError,
  type SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";

const ORIGIN = "https://www.bfdi.bund.de";
const HTML_TYPES = ["text/html", "application/xhtml+xml"] as const;
const POLICY_BYTE_LIMIT = 1024 * 1024;
const POLICY_ITEM_LIMIT = 100;
const cursorPositionSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d*)$/u),
  v.toNumber(),
  v.safeInteger(),
);
const nonempty = v.pipe(v.string(), v.trim(), v.minLength(1));
const documentSchema = v.strictObject({
  url: v.pipe(v.string(), v.url()),
  sourceDocumentId: v.pipe(v.string(), v.regex(/^[1-9]\d*$/u)),
  documentUrl: v.pipe(v.string(), v.url()),
});
const policySchema = v.strictObject({
  version: v.literal(1),
  indexes: v.pipe(
    v.array(
      v.strictObject({
        url: v.pipe(v.string(), v.url()),
        documents: v.pipe(
          v.array(documentSchema),
          v.minLength(1),
          v.maxLength(POLICY_ITEM_LIMIT),
        ),
      }),
    ),
    v.minLength(1),
    v.maxLength(POLICY_ITEM_LIMIT),
  ),
  admissionReference: nonempty,
});

const invalid = (message: string) =>
  Result.err(new SoftLawIngestionError({ message }));
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
      return yield* invalid("Invalid BfDI publisher locator");
    }
    return Result.ok(parsed.value.href);
  });

export const parseBfdiListing = (html: string, url: string) =>
  Result.gen(function* () {
    yield* publisherUrl(url);
    const $ = load(html);
    if ($("main.main").length !== 1 || !$("main h1").text().trim()) {
      return yield* invalid("BfDI response lacks its topical content shell");
    }
    if ($('main a[rel~="next"], main .pagination, main .pager').length) {
      return yield* invalid(
        "BfDI topical discovery contains unsupported pagination",
      );
    }
    const documents = new Set<string>();
    for (const element of $(
      'main a[href*="/SharedDocs/Downloads/DE/"]',
    ).toArray()) {
      const anchor = $(element);
      const href = anchor.attr("href");
      if (
        !href ||
        !/\.html(?:\?|$)/u.test(href) ||
        !/\bHandlungsempfehlung\b/u.test(compact(anchor.text()))
      ) {
        continue;
      }
      documents.add(yield* publisherUrl(href, url));
    }
    return Result.ok([...documents]);
  });

type ParseBfdiDocumentOptions = {
  html: string;
  url: string;
  sourceDocumentId: string;
  documentUrl: string;
};
export const parseBfdiDocument = ({
  html,
  url,
  sourceDocumentId,
  documentUrl,
}: ParseBfdiDocumentOptions) =>
  Result.gen(function* () {
    const $ = load(html);
    const detailUrl = yield* publisherUrl(url);
    const canonicalHref = $('link[rel="canonical"]').attr("href");
    if (!canonicalHref) {
      return yield* invalid("BfDI publication has no canonical locator");
    }
    const canonical = yield* publisherUrl(canonicalHref, detailUrl);
    const pageId = $("body").attr("data-nn")?.split("-").at(0);
    const title = compact($("main h1.publicationH1").text());
    const language = $("html").attr("lang");
    if (
      new URL(canonical).pathname !== new URL(detailUrl).pathname ||
      pageId !== sourceDocumentId ||
      !/^Handlungsempfehlung\b/u.test(title) ||
      language !== "de"
    ) {
      return yield* invalid(
        "BfDI publication identity, kind or language differs from its admission",
      );
    }
    const dates = $("main .docData.publication");
    if (
      dates.length !== 1 ||
      compact(dates.find(".label").text()) !== "Datum"
    ) {
      return yield* invalid(
        "BfDI publication fields differ from the supported detail contract",
      );
    }
    const date = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(
      compact(dates.find(".value").text()),
    );
    const day = date?.at(1);
    const month = date?.at(2);
    const year = date?.at(3);
    const issuedOn = day && month && year ? [year, month, day].join("-") : "";
    if (!parsePlainDate(issuedOn)) {
      return yield* invalid("BfDI publication date is invalid");
    }
    const downloads = $("main .links .download a.downloadLink").toArray();
    if (downloads.length !== 1) {
      return yield* invalid(
        "BfDI publication has missing or ambiguous document expressions",
      );
    }
    const href = $(downloads.at(0)).attr("href");
    const asset = yield* publisherUrl(href ?? "", detailUrl);
    if (
      asset !== documentUrl ||
      !new URL(asset).pathname.endsWith(".pdf") ||
      new URL(asset).searchParams.get("__blob") !== "publicationFile"
    ) {
      return yield* invalid("BfDI document locator differs from its admission");
    }
    return Result.ok({
      type: "document",
      url: asset,
      sourcePages: [detailUrl],
      metadata: {
        title,
        kind: "recommendation",
        sourceKind: "Handlungsempfehlung",
        sourceDocumentId: `gsb:${sourceDocumentId}`,
        statedReference: { state: "not_stated" },
        issuedOn: { state: "stated", value: issuedOn },
        expression: {
          type: "identified",
          language,
          revision: { state: "not_stated" },
        },
        stage: { state: "not_stated" },
        relations: [],
        validity: { state: "not_stated", basis: "source_stated" },
      },
      sourceDates: { publicationDate: issuedOn },
    } as const satisfies SoftLawEntry);
  });

const FIELD_SELECTORS = {
  title: "main h1.publicationH1",
  date: "main .docData.publication",
  language: "html[lang]",
  "publisher-record": "body[data-nn]",
  description: "main .teaserText",
  download: "main .links .download a.downloadLink",
} as const;
const SOURCE_FIELD_DISPOSITIONS = {
  title: { disposition: "stored", target: { type: "metadata", key: "title" } },
  date: {
    disposition: "stored",
    target: { type: "metadata", key: "issuedOn" },
  },
  language: {
    disposition: "stored",
    target: { type: "metadata", key: "expression" },
  },
  "publisher-record": {
    disposition: "stored",
    target: { type: "metadata", key: "sourceDocumentId" },
  },
  description: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "detail",
      path: [],
      reason:
        "The publication description remains verbatim in its detail response.",
    },
  },
  download: {
    disposition: "stored",
    target: {
      type: "raw",
      part: "detail",
      path: [],
      reason:
        "The download label, format, accessibility and blob locator remain verbatim in the detail response.",
    },
  },
} as const satisfies Record<
  keyof typeof FIELD_SELECTORS,
  SourceFieldDisposition
>;
const SOURCE_SURFACES = [
  "index",
  "detail",
  "document",
  "other-publications",
  "contact-navigation",
] as const;
const SOURCE_SURFACE_DISPOSITIONS = {
  index: storedSourceSurface("index"),
  detail: storedSourceSurface("detail"),
  document: storedSourceSurface("document"),
  "other-publications": excludedSourceSurface(
    "Books, templates and third-party publications are outside the registered recommendation collection.",
  ),
  "contact-navigation": excludedSourceSurface(
    "Contact navigation is not a source surface for the publication.",
  ),
} as const satisfies Record<
  (typeof SOURCE_SURFACES)[number],
  SourceSurfaceDisposition
>;

type CaptureDiscoveryResponseOptions = {
  role: "index" | "detail";
  url: string;
  response: SoftLawResponse;
  retrievedAt: string;
};
const captureDiscoveryResponse = ({
  role,
  url,
  response,
  retrievedAt,
}: CaptureDiscoveryResponseOptions) => ({
  role,
  contentBase64: Buffer.from(response.bytes).toString("base64"),
  contentType: response.contentType,
  provenance: { url, retrievedAt, sha256: sha256Hex(response.bytes) },
});

type CreateBfdiDocumentReaderOptions = {
  policy: v.InferOutput<typeof policySchema>;
  urls: ReadonlySet<string>;
};
const createBfdiDocumentReader =
  ({
    policy,
    urls,
  }: CreateBfdiDocumentReaderOptions): SoftLawSourceAdapter["fetchDocument"] =>
  async (entry, { fetch: read }) =>
    Result.gen(async function* () {
      const admitted = policy.indexes
        .flatMap((index) => index.documents)
        .find(
          (document) =>
            document.documentUrl === entry.url &&
            entry.metadata.sourceDocumentId ===
              `gsb:${document.sourceDocumentId}`,
        );
      const captured = entry.sourceRaw;
      if (
        !admitted ||
        !urls.has(entry.url) ||
        !captured ||
        captured.length !== 2 ||
        !captured.some((part) => part.role === "index") ||
        !captured.some((part) => part.role === "detail") ||
        captured.some(
          (part) =>
            !part.provenance ||
            !urls.has(part.provenance.url) ||
            sha256Hex(Buffer.from(part.contentBase64, "base64")) !==
              part.provenance.sha256,
        )
      ) {
        return yield* Result.err(
          new SoftLawItemError({
            message: "BfDI retry lacks its admitted discovery evidence",
            tag: "invalid_document",
          }),
        );
      }
      const detail = captured.find((part) => part.role === "detail");
      const index = captured.find((part) => part.role === "index");
      if (
        !detail ||
        detail.provenance?.url !== admitted.url ||
        !index ||
        !policy.indexes.some(
          (candidate) =>
            candidate.url === index.provenance?.url &&
            candidate.documents.some(
              (document) => document.url === admitted.url,
            ),
        )
      ) {
        return yield* invalid(
          "BfDI discovery surfaces do not belong to the admitted publication",
        );
      }
      const parsedEntry = yield* parseBfdiDocument({
        html: Buffer.from(detail.contentBase64, "base64").toString("utf-8"),
        ...admitted,
      });
      const document = yield* await read(entry.url, {
        expectedContentTypes: ["application/pdf", "application/octet-stream"],
      });
      const raw = [
        ...captured.map((part) => ({
          role: part.role,
          bytes: Buffer.from(part.contentBase64, "base64"),
          contentType: part.contentType,
          purpose: "discovery" as const,
          ...(part.provenance === undefined
            ? {}
            : { provenance: part.provenance }),
        })),
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
      ];
      const extraction =
        new TextDecoder().decode(document.bytes.subarray(0, 5)) === "%PDF-"
          ? await extractSoftLawPdfText(document.bytes)
          : {
              text: null,
              extractionQuality: "extraction_failed" as const,
              extractionFailure: "Publisher document is not a PDF",
            };
      return Result.ok({
        metadata: parsedEntry.metadata,
        sourceDates: parsedEntry.sourceDates,
        raw,
        ...extraction,
      });
    });

const BFDI_DEFINITION = {
  key: "de-bfdi",
  authority: "de-bfdi",
  access: {
    publisherGate: "bfdi-de",
    userAgent: "Stella/1.0 (+https://github.com/stella/stella)",
    window: { type: "any_time" },
  },
  getTotalCount: async () =>
    await Promise.resolve({ type: "no-count-endpoint" }),
  sliceWalk: {
    type: "unsupported",
    reason:
      "Topical publication pages provide no exhaustive count or date-slice interface.",
  },
  sourceFields: {
    status: "declared",
    fields: SOURCE_FIELD_DISPOSITIONS,
    listSourceFields: (parts) => {
      const $ = load(parts["detail"] ?? "");
      return Object.entries(FIELD_SELECTORS)
        .filter(([, selector]) => $(selector).length > 0)
        .map(([field]) => field);
    },
  },
  sourceSurfaces: { surfaces: SOURCE_SURFACE_DISPOSITIONS },
} as const satisfies Omit<SoftLawSourceAdapter, "discover" | "fetchDocument">;

const BFDI_DISCOVERY_BATCH_LIMIT = 10;

export const createBfdiAdapter = (input: unknown) =>
  Result.gen(function* () {
    const parsed = v.safeParse(policySchema, input);
    if (!parsed.success) {
      return yield* invalid("BfDI requires a valid source admission packet");
    }
    const policy = parsed.output;
    const urls = new Set<string>();
    for (const index of policy.indexes) {
      index.url = yield* publisherUrl(index.url);
      urls.add(index.url);
      if (!new URL(index.url).pathname.startsWith("/DE/Fachthemen/")) {
        return yield* invalid("BfDI discovery does not name a topical page");
      }
      for (const document of index.documents) {
        document.url = yield* publisherUrl(document.url);
        document.documentUrl = yield* publisherUrl(document.documentUrl);
        if (
          ![document.url, document.documentUrl].every((url) =>
            new URL(url).pathname.startsWith("/SharedDocs/Downloads/DE/"),
          )
        ) {
          return yield* invalid(
            "BfDI publication does not name a document surface",
          );
        }
        urls.add(document.url);
        urls.add(document.documentUrl);
      }
    }
    const policyHash = sha256Hex(JSON.stringify(policy));
    const cursorSchema = v.strictTuple([
      v.literal(policyHash),
      cursorPositionSchema,
      cursorPositionSchema,
    ]);
    const adapter = {
      ...BFDI_DEFINITION,
      discover: async ({ cursor, fetch: read }) =>
        Result.gen(async function* () {
          const position = v.safeParse(
            cursorSchema,
            cursor?.split(":") ?? [policyHash, "0", "0"],
          );
          if (!position.success) {
            return yield* invalid(
              "BfDI discovery cursor does not match its source admission",
            );
          }
          const [, indexNumber, item] = position.output;
          const index = policy.indexes.at(indexNumber);
          if (!index || !index.documents.at(item)) {
            return yield* invalid(
              "BfDI discovery cursor is outside its admitted collection",
            );
          }
          const indexResponse = yield* await read(index.url, {
            expectedContentTypes: HTML_TYPES,
          });
          const indexRetrievedAt = Temporal.Now.instant().toString();
          const listed = yield* parseBfdiListing(
            new TextDecoder().decode(indexResponse.bytes),
            index.url,
          );
          const admittedDocuments = index.documents.slice(
            item,
            item + BFDI_DISCOVERY_BATCH_LIMIT,
          );
          const entries = [];
          for (const admitted of admittedDocuments) {
            if (!listed.includes(admitted.url)) {
              return yield* invalid(
                "BfDI topical page is missing an admitted publication",
              );
            }
            const detailResponse = yield* await read(admitted.url, {
              expectedContentTypes: HTML_TYPES,
            });
            const entry = yield* parseBfdiDocument({
              html: new TextDecoder().decode(detailResponse.bytes),
              ...admitted,
            });
            entries.push({
              ...entry,
              sourcePages: [index.url, admitted.url],
              sourceRaw: [
                captureDiscoveryResponse({
                  role: "index",
                  url: index.url,
                  response: indexResponse,
                  retrievedAt: indexRetrievedAt,
                }),
                captureDiscoveryResponse({
                  role: "detail",
                  url: admitted.url,
                  response: detailResponse,
                  retrievedAt: Temporal.Now.instant().toString(),
                }),
              ],
            });
          }
          const nextItem = item + admittedDocuments.length;
          let nextCursor: string | null = null;
          if (nextItem < index.documents.length) {
            nextCursor = `${policyHash}:${indexNumber}:${nextItem}`;
          } else if (indexNumber + 1 < policy.indexes.length) {
            nextCursor = `${policyHash}:${indexNumber + 1}:0`;
          }
          return Result.ok({
            entries,
            nextCursor,
          });
        }),
      fetchDocument: createBfdiDocumentReader({ policy, urls }),
    } as const satisfies SoftLawSourceAdapter;
    return Result.ok(adapter);
  });

export const loadBfdiAdapter = async (
  configuration: SoftLawAdapterConfiguration,
) =>
  Result.gen(async function* () {
    if (configuration.type !== "admission-file") {
      return yield* invalid("BfDI source admission is not configured");
    }
    const bytes = yield* await Result.tryPromise({
      try: async () =>
        await readCappedBytes(
          Bun.file(configuration.path).stream(),
          POLICY_BYTE_LIMIT,
        ),
      catch: (cause) =>
        new SoftLawIngestionError({
          message: "Could not read BfDI source admission",
          cause,
        }),
    });
    if (!bytes) {
      return yield* invalid(
        "BfDI source admission exceeds the configuration byte limit",
      );
    }
    const input = yield* Result.try({
      try: () => {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return value;
      },
      catch: (cause) =>
        new SoftLawIngestionError({
          message: "Could not parse BfDI source admission",
          cause,
        }),
    });
    return createBfdiAdapter(input);
  });

/** Registration exposes the source contract; ingestion requires an admission packet. */
export const bfdiAdapter = {
  ...BFDI_DEFINITION,
  configure: loadBfdiAdapter,
  discover: async () =>
    await Promise.resolve(invalid("BfDI source admission is not configured")),
  fetchDocument: async () =>
    await Promise.resolve(invalid("BfDI source admission is not configured")),
} as const satisfies SoftLawSourceAdapter & {
  configure: typeof loadBfdiAdapter;
};
