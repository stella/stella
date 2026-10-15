import { Result, TaggedError } from "better-result";
import { load } from "cheerio";

import { readCzListVersion } from "./cz";
import type { SanctionsSource } from "./entry";
import { SANCTIONS_SOURCES } from "./sources";

export class SanctionsSourceDiscoveryError extends TaggedError(
  "SanctionsSourceDiscoveryError",
)<{
  message: string;
  source: SanctionsSource;
}> {}
const discoveryError = (source: SanctionsSource) =>
  new SanctionsSourceDiscoveryError({
    source,
    message: `Publisher metadata does not identify the ${source} edition`,
  });

const EU_XML_TITLE = "Consolidated Financial Sanctions File 1.1";
const EU_XML_PATH = "/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content";
const CZ_CSV_NAME = /^Vnitrostatni_sankcni_seznam_\d{4}_\d{2}_\d{2}\.csv$/u;

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
): Result<string, SanctionsSourceDiscoveryError> => {
  if (!record(metadata) || !Array.isArray(metadata["@graph"])) {
    return Result.err(discoveryError("eu"));
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
    : Result.err(discoveryError("eu"));
};

export const discoverCzCsvUrl = (
  html: string,
): Result<string, SanctionsSourceDiscoveryError> => {
  const $ = load(html);
  const candidates: { url: string; publishedAt: string }[] = [];
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    const url =
      href === undefined
        ? null
        : safeUrl(href, SANCTIONS_SOURCES.cz.download.pageUrl);
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
    ? Result.err(discoveryError("cz"))
    : Result.ok(latest.url);
};
