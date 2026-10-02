import { panic, Result } from "better-result";

import { readCappedBytes } from "@stll/skills/streaming";

import { fetchPublisher } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  joinSkCollectionRecords,
  parseSkCollectionPages,
  type SkCollectionTextPage,
} from "@/api/handlers/case-law/ingestion/adapters/sk-collection-parser";
import { INGESTION_USER_AGENT } from "@/api/lib/case-law/ingestion-user-agent";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { PublisherGateId } from "@/api/lib/legal-search/publisher-gates";
import {
  SK_COLLECTION_SERIES,
  SK_COLLECTION_PARSER_VERSION,
  SkCollectionIssueError,
  type SkCollectionIssue,
  type SkCollectionIssueCache,
  type SkCollectionReadOptions,
  type SkCollectionReadOutcome,
  type SkCollectionSeries,
} from "@/api/lib/legal-search/sk-collection-enrichment";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

const PUBLISHERS = {
  [SK_COLLECTION_SERIES.NS_R]: {
    origin: "https://www.nsud.sk",
    gate: "nsud-sk",
    prefix: "/data/att/",
  },
  [SK_COLLECTION_SERIES.NSS_ZNSS]: {
    origin: "https://www.nssud.sk",
    gate: "nssud-sk",
    prefix: "/wp-content/uploads/",
  },
} as const satisfies Record<
  SkCollectionSeries,
  { origin: string; gate: PublisherGateId; prefix: string }
>;

const REQUEST_TIMEOUT_MS = 30_000;
const PDF_MAX_BYTES = 8 * 1024 * 1024;
const ROBOTS_MAX_BYTES = 512 * 1024;
const PDF_MAX_PAGES = 256;
const PRODUCT_TOKEN = "stella-collections";
const USER_AGENT = `${INGESTION_USER_AGENT} ${PRODUCT_TOKEN}/1.0`;

type CollectionRequestOptions = {
  series: SkCollectionSeries;
  url: string;
  method: "GET" | "HEAD";
  headers: Headers;
  signal?: AbortSignal | undefined;
};

const requestIssue = async ({
  series,
  url,
  method,
  headers,
  signal,
}: CollectionRequestOptions): Promise<Response> => {
  const publisher = PUBLISHERS[series];
  const target = restrictOutboundUrl({
    hostPolicy: {
      type: "exact-origin",
      origins: ["https://www.nsud.sk", "https://www.nssud.sk"],
    },
    pathPrefixes: ["/data/att/", "/wp-content/uploads/", "/robots.txt"],
    rawUrl: url,
  });
  if (target === null) {
    return panic("Collection URL is outside the publisher boundary");
  }
  if (
    target.origin !== publisher.origin ||
    (target.pathname !== "/robots.txt" &&
      !target.pathname.startsWith(publisher.prefix))
  ) {
    return panic("Collection URL is outside the selected publisher");
  }
  return await fetchPublisher(target, {
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    publisherGate: publisher.gate,
    headers,
    method,
    redirect: "error",
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
};

type RobotsRule = { type: "allow" | "disallow"; path: string };
type RobotsGroup = {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay: number;
};

const robotsPathKey = (path: string) =>
  encodeURI(path)
    .replace(/%25([\dA-F]{2})/giu, "%$1")
    .replace(/%([\dA-F]{2})/giu, (encoded, hex: string) => {
      const character = String.fromCodePoint(Number.parseInt(hex, 16));
      return /[\w.~-]/u.test(character) ? character : encoded.toUpperCase();
    });

/** Greedy wildcard matching avoids running publisher-controlled regular expressions. */
const robotsPathMatches = (rawPattern: string, rawPath: string) => {
  const key = robotsPathKey(rawPattern);
  const pattern = key.endsWith("$") ? key.slice(0, -1) : `${key}*`;
  const path = robotsPathKey(rawPath);
  let patternIndex = 0;
  let pathIndex = 0;
  let starIndex = -1;
  let retryIndex = 0;
  while (pathIndex < path.length) {
    if (pattern[patternIndex] === "*") {
      starIndex = patternIndex++;
      retryIndex = pathIndex;
      continue;
    }
    if (pattern[patternIndex] === path[pathIndex]) {
      patternIndex++;
      pathIndex++;
      continue;
    }
    if (starIndex === -1) {
      return false;
    }
    patternIndex = starIndex + 1;
    pathIndex = ++retryIndex;
  }
  while (pattern[patternIndex] === "*") {
    patternIndex++;
  }
  return patternIndex === pattern.length;
};

/** RFC 9309 groups and longest path matching; stricter crawl delays stop the read. */
const robotsAllows = (text: string, path: string): boolean => {
  const groups: RobotsGroup[] = [];
  let group: RobotsGroup | undefined;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.split("#").at(0)?.trim() ?? "";
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "user-agent") {
      if (
        group === undefined ||
        group.rules.length > 0 ||
        group.crawlDelay > 0
      ) {
        group = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
      continue;
    }
    if (group === undefined) {
      continue;
    }
    if (name === "allow" || name === "disallow") {
      if (value !== "") {
        group.rules.push({ type: name, path: value });
      }
      continue;
    }
    if (name === "crawl-delay") {
      group.crawlDelay = Number(value);
    }
  }
  const specific = groups.filter(({ agents }) =>
    agents.includes(PRODUCT_TOKEN),
  );
  const selected =
    specific.length > 0
      ? specific
      : groups.filter(({ agents }) => agents.includes("*"));
  if (
    selected.some(
      ({ crawlDelay }) => !Number.isFinite(crawlDelay) || crawlDelay > 2,
    )
  ) {
    return false;
  }
  const rules = selected.flatMap(({ rules: groupRules }) => groupRules);
  if (rules.some((rule) => rule.path.length > 2048)) {
    return false;
  }
  const matching = rules
    .filter((rule) => robotsPathMatches(rule.path, path))
    .toSorted(
      (left, right) =>
        robotsPathKey(right.path).length - robotsPathKey(left.path).length ||
        (left.type === "allow" ? -1 : 1),
    );
  return matching.at(0)?.type !== "disallow";
};

const responseBytes = async (
  response: Response,
  maxBytes: number,
  issueUrl: string,
): Promise<Result<Uint8Array, SkCollectionIssueError>> => {
  if (response.body === null) {
    return Result.err(
      new SkCollectionIssueError({
        message: "Collection response has no body",
        issueUrl,
      }),
    );
  }
  const bytes = await readCappedBytes(response.body, maxBytes);
  if (bytes === null) {
    return Result.err(
      new SkCollectionIssueError({
        message: "Collection response exceeds the byte limit",
        issueUrl,
      }),
    );
  }
  return Result.ok(bytes);
};

const extractPages = async (
  bytes: Uint8Array,
  issueUrl: string,
): Promise<Result<readonly SkCollectionTextPage[], SkCollectionIssueError>> => {
  const { PDF } = await import("@libpdf/core");
  const pdf = await PDF.load(bytes);
  const pages = pdf.getPages();
  if (pages.length > PDF_MAX_PAGES) {
    return Result.err(
      new SkCollectionIssueError({
        message: "Collection issue exceeds the page limit",
        issueUrl,
      }),
    );
  }
  return Result.ok(
    pages.map((page, index) => ({
      page: index + 1,
      lines: page.extractText().lines.map(({ text }) => text),
    })),
  );
};

type CachedIssueValidationOptions = {
  issue: SkCollectionIssue;
  cache: SkCollectionIssueCache;
  request: typeof requestIssue;
  headers: Headers;
  signal?: AbortSignal | undefined;
};

type CachedIssueValidation =
  | { status: "unchanged" }
  | { status: "changed" }
  | { status: "response"; response: Response };

const cachedIssueUnchanged = async ({
  issue,
  cache,
  request,
  headers,
  signal,
}: CachedIssueValidationOptions): Promise<
  Result<CachedIssueValidation, SkCollectionIssueError>
> => {
  if (cache.etag !== null) {
    headers.set("If-None-Match", cache.etag);
  } else if (cache.lastModified !== null) {
    headers.set("If-Modified-Since", cache.lastModified);
  }
  const head = await request({
    series: issue.series,
    url: issue.url,
    method: "HEAD",
    headers,
    signal,
  });
  if (head.status === 304) {
    return Result.ok({ status: "unchanged" });
  }
  if (head.status === 405 || head.status === 501) {
    const response = await request({
      series: issue.series,
      url: issue.url,
      method: "GET",
      headers,
      signal,
    });
    return Result.ok(
      response.status === 304
        ? ({ status: "unchanged" } as const)
        : ({ status: "response", response } as const),
    );
  }
  if (!head.ok) {
    return Result.err(
      new SkCollectionIssueError({
        message: `Issue validation failed (${head.status})`,
        issueUrl: issue.url,
      }),
    );
  }
  const previous = cache.etag ?? cache.lastModified;
  const current = head.headers.get(
    cache.etag === null ? "last-modified" : "etag",
  );
  if (current === null) {
    return Result.err(
      new SkCollectionIssueError({
        message: "Issue validation lost its publisher validator",
        issueUrl: issue.url,
      }),
    );
  }
  return Result.ok({ status: current === previous ? "unchanged" : "changed" });
};

type CollectionConnectorOptions = {
  status: "disabled" | "enabled";
  request?: typeof requestIssue | undefined;
  extract?: typeof extractPages | undefined;
};

/**
 * One explicitly selected issue per call. No discovery sweep, decision insert,
 * PDF/raw envelope output or full-text persistence. The caller persists the
 * returned parsed snapshot before advancing its issue cursor.
 */
export const createSkCollectionConnector = ({
  status,
  request = requestIssue,
  extract = extractPages,
}: CollectionConnectorOptions) => ({
  status,
  join: joinSkCollectionRecords,
  readIssue: async ({
    issue,
    cache,
    signal,
  }: SkCollectionReadOptions): Promise<
    Result<SkCollectionReadOutcome, SkCollectionIssueError>
  > => {
    if (status === "disabled") {
      return Result.ok({ status: "disabled" });
    }
    const result = await Result.tryPromise({
      try: async (): Promise<
        Result<SkCollectionReadOutcome, SkCollectionIssueError>
      > => {
        const publisher = PUBLISHERS[issue.series];
        const target = restrictOutboundUrl({
          hostPolicy: { type: "exact-origin", origins: [publisher.origin] },
          pathPrefixes: [publisher.prefix],
          rawUrl: issue.url,
        });
        if (
          target === null ||
          !target.pathname.endsWith(".pdf") ||
          target.search !== "" ||
          !Number.isInteger(issue.year)
        ) {
          return Result.err(
            new SkCollectionIssueError({
              message: "Invalid collection issue descriptor",
              issueUrl: issue.url,
            }),
          );
        }
        if (
          cache !== null &&
          (cache.issue.url !== issue.url ||
            cache.issue.series !== issue.series ||
            cache.issue.year !== issue.year)
        ) {
          return Result.err(
            new SkCollectionIssueError({
              message: "Cached collection issue identity differs",
              issueUrl: issue.url,
            }),
          );
        }
        if (issue.year < 2010) {
          return Result.ok({
            status: "read",
            cache: {
              issue,
              parserVersion: SK_COLLECTION_PARSER_VERSION,
              etag: null,
              lastModified: null,
              outcome: { status: "needs-ocr", reason: "before-2010" },
            },
          });
        }
        const currentCache =
          cache?.parserVersion === SK_COLLECTION_PARSER_VERSION ? cache : null;
        // A publisher without validators is fetched once per immutable issue URL.
        if (currentCache?.etag === null && currentCache.lastModified === null) {
          return Result.ok({ status: "unchanged", cache: currentCache });
        }
        const headers = new Headers({ "User-Agent": USER_AGENT });
        const robots = await request({
          series: issue.series,
          url: `${publisher.origin}/robots.txt`,
          method: "GET",
          headers,
          signal,
        });
        if (robots.status !== 404) {
          if (!robots.ok) {
            return Result.err(
              new SkCollectionIssueError({
                message: `Robots request failed (${robots.status})`,
                issueUrl: issue.url,
              }),
            );
          }
          const body = await responseBytes(robots, ROBOTS_MAX_BYTES, issue.url);
          if (body.isErr()) {
            return body;
          }
          if (
            !robotsAllows(new TextDecoder().decode(body.value), target.pathname)
          ) {
            return Result.ok({ status: "robots-denied", issueUrl: issue.url });
          }
        }
        const validation =
          currentCache === null
            ? Result.ok({ status: "changed" } as const)
            : await cachedIssueUnchanged({
                issue,
                cache: currentCache,
                request,
                headers,
                signal,
              });
        if (validation.isErr()) {
          return validation;
        }
        const validated = validation.value;
        if (validated.status === "unchanged" && currentCache !== null) {
          return Result.ok({ status: "unchanged", cache: currentCache });
        }
        const response =
          validated.status === "response"
            ? validated.response
            : await request({
                series: issue.series,
                url: issue.url,
                method: "GET",
                headers,
                signal,
              });
        if (!response.ok) {
          return Result.err(
            new SkCollectionIssueError({
              message: `Issue request failed (${response.status})`,
              issueUrl: issue.url,
            }),
          );
        }
        const bytes = await responseBytes(response, PDF_MAX_BYTES, issue.url);
        if (bytes.isErr()) {
          return bytes;
        }
        if (new TextDecoder().decode(bytes.value.subarray(0, 5)) !== "%PDF-") {
          return Result.err(
            new SkCollectionIssueError({
              message: "Issue response is not a PDF",
              issueUrl: issue.url,
            }),
          );
        }
        const pages = await extract(bytes.value, issue.url);
        if (pages.isErr()) {
          return pages;
        }
        return Result.ok({
          status: "read",
          cache: {
            issue,
            parserVersion: SK_COLLECTION_PARSER_VERSION,
            etag: response.headers.get("etag"),
            lastModified: response.headers.get("last-modified"),
            outcome: parseSkCollectionPages(issue, pages.value),
          },
        });
      },
      catch: (cause) =>
        cause instanceof SkCollectionIssueError
          ? cause
          : new SkCollectionIssueError({
              message: "Collection issue read failed",
              issueUrl: issue.url,
              cause,
            }),
    });
    return result.andThen((outcome) => outcome);
  },
});
