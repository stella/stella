import { Result, TaggedError, panic } from "better-result";
import { load } from "cheerio";
import { createHash } from "node:crypto";

import { backoffDelay } from "@stll/concurrency/backoff-delay";
import {
  SANCTIONS_SOURCES,
  parseCzList,
  parseEuList,
  parseOfacList,
  parseSecoList,
  parseUkList,
  parseUnList,
  readCzListVersion,
  readEuListVersion,
  readOfacListVersion,
  readSecoListVersion,
  readSourceEditionMarker,
  readUkListVersion,
  readUnListVersion,
} from "@stll/sanctions";
import type {
  ListVersion,
  ParsedList,
  SanctionsListParseError,
  SanctionsSource,
} from "@stll/sanctions";

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { INGESTION_USER_AGENT } from "@/api/lib/case-law/ingestion-user-agent";
import { createEventLoopSlicer } from "@/api/lib/event-loop-slicer";
import { SANCTIONS_SOURCE_CONFIG } from "@/api/lib/lists/sanctions/source-config";
import {
  fetchStreamFollowingRedirects,
  RedirectChainError,
} from "@/api/lib/redirect-fetch";
import {
  parseSafeOutboundUrl,
  safeOutboundFetchBytes,
  safeOutboundFetchStream,
} from "@/api/lib/safe-outbound-fetch";

const METADATA_MAX_BYTES = 1_000_000;
const LIST_MAX_BYTES = 64_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_TOTAL_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_REDIRECT_HOPS = 3;
const PARSE_SLICE_BYTES = 16 * 1024;
const EU_XML_TITLE = "Consolidated Financial Sanctions File 1.1";
const EU_XML_PATH = "/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content";
const CZ_CSV_NAME = /^Vnitrostatni_sankcni_seznam_\d{4}_\d{2}_\d{2}\.csv$/u;

export class SanctionsRefreshError extends TaggedError(
  "SanctionsRefreshError",
)<{
  code: "access-denied" | "fetch-failed" | "metadata-invalid" | "parse-failed";
  message: string;
  source: SanctionsSource;
}> {}

const refreshError = (
  source: SanctionsSource,
  code: SanctionsRefreshError["code"],
): SanctionsRefreshError =>
  new SanctionsRefreshError({
    code,
    message: `Could not refresh the ${source} list: ${code}`,
    source,
  });

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const idOf = (value: unknown): string | null => {
  if (!record(value)) {
    return null;
  }
  const id = value["@id"];
  return typeof id === "string" ? id : null;
};

const safeUrl = (value: string, base?: string): URL | null => {
  const parsed = Result.try(() => new URL(value, base));
  return parsed.isOk() ? parsed.value : null;
};

export const discoverEuXmlUrl = (
  metadata: unknown,
): Result<string, SanctionsRefreshError> => {
  if (!record(metadata) || !Array.isArray(metadata["@graph"])) {
    return Result.err(refreshError("eu", "metadata-invalid"));
  }

  const candidates: string[] = [];
  for (const node of metadata["@graph"]) {
    if (!record(node) || node["@type"] !== "dcat:Distribution") {
      continue;
    }
    const titles = node["dct:title"];
    if (
      !Array.isArray(titles) ||
      !titles.some(
        (title) =>
          record(title) &&
          title["@language"] === "en" &&
          title["@value"] === EU_XML_TITLE,
      )
    ) {
      continue;
    }
    if (!idOf(node["dct:format"])?.endsWith("/XML")) {
      continue;
    }
    const download = idOf(node["dcat:downloadURL"]);
    const url = download === null ? null : safeUrl(download);
    if (
      url?.protocol !== "https:" ||
      url.hostname !== "webgate.ec.europa.eu" ||
      url.pathname !== EU_XML_PATH ||
      url.username !== "" ||
      url.password !== ""
    ) {
      continue;
    }
    candidates.push(url.href);
  }

  const candidate = candidates.at(0);
  return candidates.length === 1 && candidate !== undefined
    ? Result.ok(candidate)
    : Result.err(refreshError("eu", "metadata-invalid"));
};

export const discoverCzCsvUrl = (
  html: string,
): Result<string, SanctionsRefreshError> => {
  const $ = load(html);
  const candidates: { url: string; publishedAt: string }[] = [];
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    const url =
      href === undefined
        ? null
        : safeUrl(href, SANCTIONS_SOURCE_CONFIG.cz.markerUrl);
    if (
      url?.protocol !== "https:" ||
      url.hostname !== "mzv.gov.cz" ||
      !CZ_CSV_NAME.test(url.pathname.split("/").at(-1) ?? "")
    ) {
      return;
    }
    const version = readCzListVersion(url.href);
    if (version.isOk()) {
      candidates.push({
        url: url.href,
        publishedAt: version.value.publishedAt,
      });
    }
  });
  candidates.sort((left, right) => {
    if (left.publishedAt < right.publishedAt) {
      return 1;
    }
    if (left.publishedAt > right.publishedAt) {
      return -1;
    }
    return 0;
  });
  const latest = candidates.at(0);
  return latest === undefined
    ? Result.err(refreshError("cz", "metadata-invalid"))
    : Result.ok(latest.url);
};

export type FetchedMarker = {
  source: SanctionsSource;
  version: ListVersion;
  downloadUrl: string;
  /** See {@link lastModifiedOf}. */
  lastModified: string | null;
};

/**
 * The HTTP Last-Modified of a list response, for sources whose edition marker
 * is that validator. Their stated list version is a calendar date, so the
 * validator is what tells two editions published on the same day apart. It
 * is read from the response that carried the list, which for these sources is
 * the marker URL itself. Null for other sources, and when the publisher omits
 * the header or sends one that cannot be read.
 */
const lastModifiedOf = (
  source: SanctionsSource,
  headers: Headers,
): string | null => {
  if (SANCTIONS_SOURCES[source].editionMarker.kind !== "http-last-modified") {
    return null;
  }
  const stamp = readSourceEditionMarker(source, {
    lastModified: headers.get("last-modified"),
  });
  return stamp.isOk() ? stamp.value.value : null;
};

type FetchOptions = {
  permit: ThirdPartyOutboundPermit;
  euXmlUrlOverride?: string | undefined;
  fetchStreamRequest?: typeof safeOutboundFetchStream | undefined;
  signal: AbortSignal;
  streamTotalTimeoutMs?: number | undefined;
  userAgent?: string | undefined;
};

const headersFor = ({
  accept,
  userAgent,
}: {
  accept?: string | undefined;
  userAgent?: string | undefined;
}): Record<string, string> => ({
  ...(accept === undefined ? {} : { Accept: accept }),
  "User-Agent": userAgent ?? INGESTION_USER_AGENT,
});

const fetchBytes = async ({
  permit,
  maxBytes,
  signal,
  source,
  url,
  userAgent,
  accept,
}: {
  accept?: string | undefined;
  permit: ThirdPartyOutboundPermit;
  maxBytes: number;
  signal: AbortSignal;
  source: SanctionsSource;
  url: string;
  userAgent?: string | undefined;
}): Promise<Result<ArrayBuffer, SanctionsRefreshError>> => {
  const response = await safeOutboundFetchBytes({
    permit,
    url,
    maxBytes,
    timeoutMs: REQUEST_TIMEOUT_MS,
    signal,
    headers: headersFor({ accept, userAgent }),
  });
  if (response.isErr()) {
    return Result.err(refreshError(source, "fetch-failed"));
  }
  if (response.value.status === 401 || response.value.status === 403) {
    return Result.err(refreshError(source, "access-denied"));
  }
  return response.value.ok
    ? Result.ok(response.value.body)
    : Result.err(refreshError(source, "fetch-failed"));
};

const fetchStream = async ({
  permit,
  fetchStreamRequest = safeOutboundFetchStream,
  signal,
  source,
  streamTotalTimeoutMs = STREAM_TOTAL_TIMEOUT_MS,
  url,
  userAgent,
}: {
  permit: ThirdPartyOutboundPermit;
  fetchStreamRequest?: typeof safeOutboundFetchStream | undefined;
  signal: AbortSignal;
  source: SanctionsSource;
  streamTotalTimeoutMs?: number | undefined;
  url: string;
  userAgent?: string | undefined;
}): Promise<
  Result<
    { body: ReadableStream<Uint8Array>; headers: Headers },
    SanctionsRefreshError
  >
> => {
  const canonical = parseSafeOutboundUrl(url);
  if (canonical.isErr()) {
    return Result.err(refreshError(source, "fetch-failed"));
  }
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(streamTotalTimeoutMs),
  ]);
  const response = await fetchStreamFollowingRedirects({
    url,
    maxHops: MAX_REDIRECT_HOPS,
    fetchStream: async (target, hop) => {
      const parsed = parseSafeOutboundUrl(target);
      if (parsed.isErr()) {
        return parsed;
      }
      if (
        hop > 0 &&
        parsed.value.origin !== canonical.value.origin &&
        !SANCTIONS_SOURCE_CONFIG[source].allowedRedirectHosts.some(
          (host) => host === parsed.value.hostname,
        )
      ) {
        return Result.err(
          new RedirectChainError({
            code: "destination_not_allowed",
            message: "publisher redirect destination is not declared",
          }),
        );
      }
      // Public downloads reconstruct only the user agent on every hop; no
      // authorization, cookies, or URL credentials cross publisher hosts.
      return await fetchStreamRequest({
        permit,
        url: parsed.value,
        maxBytes: LIST_MAX_BYTES,
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: headersFor({ userAgent }),
        redirect: "manual",
        signal: requestSignal,
      });
    },
  });
  if (response.isErr()) {
    return Result.err(
      refreshError(
        source,
        RedirectChainError.is(response.error) &&
          response.error.code === "destination_not_allowed"
          ? "access-denied"
          : "fetch-failed",
      ),
    );
  }
  if (!response.value.ok) {
    const discarded = await Result.tryPromise(
      async () => await response.value.body.cancel(),
    );
    if (discarded.isErr()) {
      return Result.err(refreshError(source, "fetch-failed"));
    }
    return Result.err(
      refreshError(
        source,
        response.value.status === 401 || response.value.status === 403
          ? "access-denied"
          : "fetch-failed",
      ),
    );
  }
  return Result.ok({
    body: response.value.body,
    headers: response.value.headers,
  });
};

const trackStreamFailure = (body: ReadableStream<Uint8Array>) => {
  let failed = false;
  const chunks = async function* () {
    const reader = body.getReader();
    try {
      while (true) {
        const next = await Result.tryPromise(async () => await reader.read());
        if (next.isErr()) {
          failed = true;
          return;
        }
        if (next.value.done) {
          return;
        }
        yield next.value.value;
      }
    } finally {
      await reader.cancel().catch(() => {
        failed = true;
      });
      reader.releaseLock();
    }
  };
  return { chunks: chunks(), failed: () => failed };
};

const decodeUtf8 = (
  source: SanctionsSource,
  bytes: ArrayBuffer,
): Result<string, SanctionsRefreshError> => {
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  return decoded.isOk()
    ? Result.ok(decoded.value)
    : Result.err(refreshError(source, "parse-failed"));
};

type StreamedSource = Exclude<SanctionsSource, "cz">;

type ReadStreamedVersion = (
  input: AsyncIterable<Uint8Array>,
) => Promise<Result<ListVersion, SanctionsListParseError>>;

/** Reads the edition stamp at the start of a streamed list and stops there. */
const loadStreamedMarker = async ({
  source,
  downloadUrl,
  options,
  readVersion,
}: {
  source: StreamedSource;
  downloadUrl: string;
  options: FetchOptions;
  readVersion: ReadStreamedVersion;
}): Promise<Result<FetchedMarker, SanctionsRefreshError>> => {
  const response = await fetchStream({
    permit: options.permit,
    fetchStreamRequest: options.fetchStreamRequest,
    source,
    url: downloadUrl,
    signal: options.signal,
    streamTotalTimeoutMs: options.streamTotalTimeoutMs,
    userAgent: options.userAgent,
  });
  if (response.isErr()) {
    return response;
  }
  const body = trackStreamFailure(response.value.body);
  const version = await readVersion(body.chunks);
  return version.isOk() && !body.failed()
    ? Result.ok({
        source,
        version: version.value,
        downloadUrl,
        lastModified: lastModifiedOf(source, response.value.headers),
      })
    : Result.err(
        refreshError(source, body.failed() ? "fetch-failed" : "parse-failed"),
      );
};

const loadMarkerOnce = async (
  source: SanctionsSource,
  options: FetchOptions,
): Promise<Result<FetchedMarker, SanctionsRefreshError>> => {
  switch (source) {
    case "eu": {
      let downloadUrl = options.euXmlUrlOverride;
      if (downloadUrl === undefined) {
        const metadataBytes = await fetchBytes({
          permit: options.permit,
          signal: options.signal,
          source,
          url: SANCTIONS_SOURCE_CONFIG.eu.markerUrl,
          maxBytes: METADATA_MAX_BYTES,
          accept: "application/ld+json",
          userAgent: options.userAgent,
        });
        if (metadataBytes.isErr()) {
          return metadataBytes;
        }
        const metadataText = decodeUtf8(source, metadataBytes.value);
        if (metadataText.isErr()) {
          return metadataText;
        }
        const parsed = Result.try((): unknown =>
          JSON.parse(metadataText.value),
        );
        if (parsed.isErr()) {
          return Result.err(refreshError(source, "metadata-invalid"));
        }
        const discovered = discoverEuXmlUrl(parsed.value);
        if (discovered.isErr()) {
          return discovered;
        }
        downloadUrl = discovered.value;
      }
      const overrideUrl = safeUrl(downloadUrl);
      if (overrideUrl?.protocol !== "https:") {
        return Result.err(refreshError(source, "metadata-invalid"));
      }
      return await loadStreamedMarker({
        source,
        downloadUrl,
        options,
        readVersion: readEuListVersion,
      });
    }
    case "un":
      return await loadStreamedMarker({
        source,
        downloadUrl: SANCTIONS_SOURCE_CONFIG.un.markerUrl,
        options,
        readVersion: readUnListVersion,
      });
    // OFAC stamps the publication date in the XML header, so reading the
    // start of the export identifies the edition without a full download.
    case "us-sdn":
    case "us-non-sdn":
      return await loadStreamedMarker({
        source,
        downloadUrl: SANCTIONS_SOURCES[source].download.urls[0],
        options,
        readVersion: async (input) => await readOfacListVersion(source, input),
      });
    // The UK list states its generation date near the top of the XML.
    case "uk":
      return await loadStreamedMarker({
        source,
        downloadUrl: SANCTIONS_SOURCES.uk.download.urls[0],
        options,
        readVersion: readUkListVersion,
      });
    // The SECO list states its edition date on the XML root element.
    case "ch":
      return await loadStreamedMarker({
        source,
        downloadUrl: SANCTIONS_SOURCES.ch.download.urls[0],
        options,
        readVersion: readSecoListVersion,
      });
    case "cz": {
      const page = await fetchBytes({
        permit: options.permit,
        signal: options.signal,
        source,
        url: SANCTIONS_SOURCE_CONFIG.cz.markerUrl,
        maxBytes: METADATA_MAX_BYTES,
        userAgent: options.userAgent,
      });
      if (page.isErr()) {
        return page;
      }
      const html = decodeUtf8(source, page.value);
      if (html.isErr()) {
        return html;
      }
      const downloadUrl = discoverCzCsvUrl(html.value);
      if (downloadUrl.isErr()) {
        return downloadUrl;
      }
      const version = readCzListVersion(downloadUrl.value);
      return version.isOk()
        ? Result.ok({
            source,
            version: version.value,
            downloadUrl: downloadUrl.value,
            lastModified: null,
          })
        : Result.err(refreshError(source, "metadata-invalid"));
    }
    default: {
      source satisfies never;
      return panic("Unknown sanctions source");
    }
  }
};

const retryFetch = async <T>({
  operation,
  signal,
}: {
  operation: () => Promise<Result<T, SanctionsRefreshError>>;
  signal: AbortSignal;
}): Promise<Result<T, SanctionsRefreshError>> => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await operation();
    if (
      result.isOk() ||
      result.error.code !== "fetch-failed" ||
      attempt === MAX_ATTEMPTS ||
      signal.aborted
    ) {
      return result;
    }
    await Bun.sleep(
      backoffDelay(attempt - 1, {
        baseMs: 250,
        jitter: {
          type: "additive",
          random: Math.random(),
          rangeMs: 250,
          rounding: "floor",
        },
      }),
    );
  }
  return panic("Unreachable sanctions fetch retry state");
};

export const fetchSanctionsMarker = async (
  source: SanctionsSource,
  options: FetchOptions,
): Promise<Result<FetchedMarker, SanctionsRefreshError>> =>
  await retryFetch({
    operation: async () => await loadMarkerOnce(source, options),
    signal: options.signal,
  });

export type FetchedEdition = {
  parsed: ParsedList;
  contentHash: string;
  /** See {@link lastModifiedOf}; read from the download response. */
  lastModified: string | null;
};

const parseStreamedList = async (
  source: StreamedSource,
  input: AsyncIterable<Uint8Array>,
): Promise<Result<ParsedList, SanctionsListParseError>> => {
  switch (source) {
    case "eu":
      return await parseEuList(input);
    case "un":
      return await parseUnList(input);
    case "us-sdn":
    case "us-non-sdn":
      return await parseOfacList(source, input);
    case "uk":
      return await parseUkList(input);
    case "ch":
      return await parseSecoList(input);
    default: {
      source satisfies never;
      return panic("Unknown streamed sanctions source");
    }
  }
};

const loadEditionOnce = async (
  marker: FetchedMarker,
  options: FetchOptions,
): Promise<Result<FetchedEdition, SanctionsRefreshError>> => {
  if (marker.source === "cz") {
    const downloaded = await fetchBytes({
      permit: options.permit,
      signal: options.signal,
      source: marker.source,
      url: marker.downloadUrl,
      maxBytes: LIST_MAX_BYTES,
      userAgent: options.userAgent,
    });
    if (downloaded.isErr()) {
      return downloaded;
    }
    const csv = decodeUtf8(marker.source, downloaded.value);
    if (csv.isErr()) {
      return csv;
    }
    const parsed = parseCzList({
      csv: csv.value,
      fileNameOrUrl: marker.downloadUrl,
    });
    return parsed.isOk()
      ? Result.ok({
          parsed: parsed.value,
          contentHash: createHash("sha256")
            .update(Buffer.from(downloaded.value))
            .digest("hex"),
          lastModified: null,
        })
      : Result.err(refreshError(marker.source, "parse-failed"));
  }

  const downloaded = await fetchStream({
    permit: options.permit,
    fetchStreamRequest: options.fetchStreamRequest,
    source: marker.source,
    url: marker.downloadUrl,
    signal: options.signal,
    streamTotalTimeoutMs: options.streamTotalTimeoutMs,
    userAgent: options.userAgent,
  });
  if (downloaded.isErr()) {
    return downloaded;
  }
  const body = trackStreamFailure(downloaded.value.body);
  const hash = createHash("sha256");
  // The parse runs on the serving event loop. Chunks that have already
  // arrived are read without ever yielding to timers or I/O, so the parser is
  // fed small slices and gives way between them.
  const pause = createEventLoopSlicer();
  const hashed = async function* () {
    for await (const chunk of body.chunks) {
      hash.update(chunk);
      for (
        let offset = 0;
        offset < chunk.byteLength;
        offset += PARSE_SLICE_BYTES
      ) {
        await pause();
        yield chunk.subarray(offset, offset + PARSE_SLICE_BYTES);
      }
    }
  };
  const parsed = await parseStreamedList(marker.source, hashed());
  return parsed.isOk() && !body.failed()
    ? Result.ok({
        parsed: parsed.value,
        contentHash: hash.digest("hex"),
        lastModified: lastModifiedOf(marker.source, downloaded.value.headers),
      })
    : Result.err(
        refreshError(
          marker.source,
          body.failed() ? "fetch-failed" : "parse-failed",
        ),
      );
};

export const fetchSanctionsEdition = async (
  marker: FetchedMarker,
  options: FetchOptions,
): Promise<Result<FetchedEdition, SanctionsRefreshError>> =>
  await retryFetch({
    operation: async () => await loadEditionOnce(marker, options),
    signal: options.signal,
  });
