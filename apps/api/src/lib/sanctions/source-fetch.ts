import { Result, TaggedError, panic } from "better-result";
import { load } from "cheerio";
import { createHash } from "node:crypto";

import {
  parseCzList,
  parseEuList,
  parseUnList,
  readCzListVersion,
  readEuListVersion,
  readUnListVersion,
} from "@stll/sanctions";
import type { ListVersion, ParsedList, SanctionsSource } from "@stll/sanctions";

import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";
import { captureError } from "@/api/lib/analytics/capture";
import {
  safeOutboundFetchBytes,
  safeOutboundFetchStream,
} from "@/api/lib/safe-outbound-fetch";
import { SANCTIONS_SOURCE_CONFIG } from "@/api/lib/sanctions/source-config";

const METADATA_MAX_BYTES = 1_000_000;
const LIST_MAX_BYTES = 64_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_TOTAL_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
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
};

type FetchOptions = {
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
  maxBytes,
  source,
  url,
  userAgent,
  accept,
}: {
  accept?: string | undefined;
  maxBytes: number;
  source: SanctionsSource;
  url: string;
  userAgent?: string | undefined;
}): Promise<Result<ArrayBuffer, SanctionsRefreshError>> => {
  const response = await safeOutboundFetchBytes({
    url,
    maxBytes,
    timeoutMs: REQUEST_TIMEOUT_MS,
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
  fetchStreamRequest = safeOutboundFetchStream,
  signal,
  source,
  streamTotalTimeoutMs = STREAM_TOTAL_TIMEOUT_MS,
  url,
  userAgent,
}: {
  fetchStreamRequest?: typeof safeOutboundFetchStream | undefined;
  signal: AbortSignal;
  source: SanctionsSource;
  streamTotalTimeoutMs?: number | undefined;
  url: string;
  userAgent?: string | undefined;
}): Promise<Result<ReadableStream<Uint8Array>, SanctionsRefreshError>> => {
  const response = await fetchStreamRequest({
    url,
    maxBytes: LIST_MAX_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: headersFor({ userAgent }),
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(streamTotalTimeoutMs),
    ]),
  });
  if (response.isErr()) {
    return Result.err(refreshError(source, "fetch-failed"));
  }
  if (!response.value.ok) {
    const discarded = await Result.tryPromise(() =>
      response.value.body.cancel(),
    );
    if (discarded.isErr()) {
      captureError(refreshError(source, "fetch-failed"), {
        context: { "sanctions.source": source },
      });
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
  return Result.ok(response.value.body);
};

const trackStreamFailure = (body: ReadableStream<Uint8Array>) => {
  let failed = false;
  const chunks = async function* () {
    try {
      for await (const chunk of body) {
        yield chunk;
      }
    } catch (error) {
      failed = true;
      throw error;
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

const loadMarkerOnce = async (
  source: SanctionsSource,
  options: FetchOptions,
): Promise<Result<FetchedMarker, SanctionsRefreshError>> => {
  switch (source) {
    case "eu": {
      let downloadUrl = options.euXmlUrlOverride;
      if (downloadUrl === undefined) {
        const metadataBytes = await fetchBytes({
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
      const response = await fetchStream({
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
      const body = trackStreamFailure(response.value);
      const version = await readEuListVersion(body.chunks);
      return version.isOk()
        ? Result.ok({ source, version: version.value, downloadUrl })
        : Result.err(
            refreshError(
              source,
              body.failed() ? "fetch-failed" : "parse-failed",
            ),
          );
    }
    case "un": {
      const downloadUrl = SANCTIONS_SOURCE_CONFIG.un.markerUrl;
      const response = await fetchStream({
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
      const body = trackStreamFailure(response.value);
      const version = await readUnListVersion(body.chunks);
      return version.isOk()
        ? Result.ok({ source, version: version.value, downloadUrl })
        : Result.err(
            refreshError(
              source,
              body.failed() ? "fetch-failed" : "parse-failed",
            ),
          );
    }
    case "cz": {
      const page = await fetchBytes({
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
    await Bun.sleep(250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
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

export type FetchedEdition = { parsed: ParsedList; contentHash: string };

const loadEditionOnce = async (
  marker: FetchedMarker,
  options: FetchOptions,
): Promise<Result<FetchedEdition, SanctionsRefreshError>> => {
  if (marker.source === "cz") {
    const downloaded = await fetchBytes({
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
        })
      : Result.err(refreshError(marker.source, "parse-failed"));
  }

  const downloaded = await fetchStream({
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
  const body = trackStreamFailure(downloaded.value);
  const hash = createHash("sha256");
  const hashed = async function* () {
    for await (const chunk of body.chunks) {
      hash.update(chunk);
      yield chunk;
    }
  };
  const parsed =
    marker.source === "eu"
      ? await parseEuList(hashed())
      : await parseUnList(hashed());
  return parsed.isOk()
    ? Result.ok({ parsed: parsed.value, contentHash: hash.digest("hex") })
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
