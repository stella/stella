import { panic, Result, TaggedError } from "better-result";

/** Findings carry counts and URLs only, never page text, so reports are safe to share. */

export const CHECK_NAMES = [
  "http-200",
  "server-rendered",
  "decision-text",
  "metadata",
  "robots",
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

export type ExpectedRobots = "indexable" | "noindex";

export const MIN_SERVER_RENDERED_CHARS = 300;
export const MIN_DECISION_TEXT_CHARS = 1000;

const BLOCK_PATTERNS = [
  /<script\b[\s\S]*?<\/script>/giu,
  /<style\b[\s\S]*?<\/style>/giu,
  /<noscript\b[\s\S]*?<\/noscript>/giu,
  /<template\b[\s\S]*?<\/template>/giu,
  /<!--[\s\S]*?-->/gu,
];

const decodeEntities = (value: string): string =>
  value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    );

/** The text a reader without JavaScript sees. */
export const visibleText = (html: string): string => {
  let stripped = html;
  for (const pattern of BLOCK_PATTERNS) {
    stripped = stripped.replace(pattern, " ");
  }
  // A tag cannot contain `<`, so each match ends before the next one starts.
  return decodeEntities(stripped.replace(/<[^<>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
};

export type RobotsDirective = {
  present: boolean;
  noindex: boolean;
};

/** Every robots meta tag counts: the most restrictive directive applies. */
export const readRobotsMeta = (html: string): RobotsDirective => {
  const tags = (html.match(/<meta\b[^>]*>/giu) ?? []).filter((tag) =>
    /name\s*=\s*["']robots["']/iu.test(tag),
  );
  return {
    present: tags.length > 0,
    noindex: tags.some((tag) =>
      /\b(?:noindex|none)\b/iu.test(
        /content\s*=\s*["']([^"']*)["']/iu.exec(tag)?.[1] ?? "",
      ),
    ),
  };
};

/**
 * The text of the decision itself: the reader renders the body inside an
 * `<article>`, so page chrome around it (navigation, footer) never counts.
 */
export const decisionBodyText = (html: string): string =>
  Array.from(html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/giu))
    .map((match) => visibleText(match[1] ?? ""))
    .join(" ")
    .trim();

export type DecisionMetadata = {
  caseNumber: string | null;
  court: string | null;
  date: string | null;
};

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;

const jsonLdBlocks = (html: string): unknown[] => {
  const blocks: unknown[] = [];
  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu;
  for (const match of html.matchAll(pattern)) {
    try {
      blocks.push(JSON.parse(match[1] ?? ""));
    } catch {
      // A malformed block is simply not metadata.
    }
  }
  return blocks;
};

/** Case number, court and decision date from the page's LegalDocument JSON-LD. */
export const readDecisionMetadata = (html: string): DecisionMetadata => {
  for (const block of jsonLdBlocks(html)) {
    const doc = asRecord(block);
    if (doc === null || doc["@type"] !== "LegalDocument") {
      continue;
    }
    return {
      caseNumber: nonEmptyString(doc["name"]),
      court: nonEmptyString(asRecord(doc["publisher"])?.["name"]),
      date: nonEmptyString(doc["datePublished"]),
    };
  }
  return { caseNumber: null, court: null, date: null };
};

export type PageObservation = {
  url: string;
  status: number;
  contentType: string | null;
  /** The `X-Robots-Tag` response header, which the web server sets by cache class. */
  xRobotsTag: string | null;
  /**
   * False for a page listed in the undated shard: its decision has no date,
   * so the page's JSON-LD rightly omits `datePublished`.
   */
  dateRequired: boolean;
  html: string;
};

/** Indexable means both the meta tag and the header allow indexing. */
export const headerAllowsIndexing = (xRobotsTag: string | null): boolean =>
  xRobotsTag === null || !/\b(?:noindex|none)\b/iu.test(xRobotsTag);

/** Pages of the undated shard (`/undated/00`) carry no decision date. */
export const isUndatedShardUrl = (shardUrl: string): boolean =>
  /\/undated\/[^/]+\.xml$/u.test(shardUrl) || /\/undated\/00\//u.test(shardUrl);

export type PageResult = {
  url: string;
  failed: readonly CheckName[];
  textChars: number;
};

export const checkPage = (
  page: PageObservation,
  expectedRobots: ExpectedRobots,
): PageResult => {
  const failed: CheckName[] = [];
  const ok = page.status === 200;
  if (!ok || !(page.contentType ?? "").toLowerCase().includes("text/html")) {
    failed.push("http-200");
  }
  const text = ok ? visibleText(page.html) : "";
  const hasHeading = /<h1\b/iu.test(page.html) || /<main\b/iu.test(page.html);
  if (ok && (!hasHeading || text.length < MIN_SERVER_RENDERED_CHARS)) {
    failed.push("server-rendered");
  }
  const bodyText = ok ? decisionBodyText(page.html) : "";
  if (ok && bodyText.length < MIN_DECISION_TEXT_CHARS) {
    failed.push("decision-text");
  }
  if (ok) {
    const metadata = readDecisionMetadata(page.html);
    if (
      metadata.caseNumber === null ||
      metadata.court === null ||
      (page.dateRequired && metadata.date === null)
    ) {
      failed.push("metadata");
    }
    const robots = readRobotsMeta(page.html);
    const indexable = !robots.noindex && headerAllowsIndexing(page.xRobotsTag);
    if (expectedRobots === "indexable" ? !indexable : indexable) {
      failed.push("robots");
    }
  }
  return { url: page.url, failed, textChars: bodyText.length };
};

export type CheckSummary = {
  check: CheckName;
  passed: number;
  failed: number;
  failingUrls: readonly string[];
};

export type Report = {
  baseUrl: string;
  country: string;
  expectedRobots: ExpectedRobots;
  sampleSize: number;
  checked: number;
  pass: boolean;
  checks: readonly CheckSummary[];
  fetchErrors: readonly string[];
};

export type FetchStep = "sitemap index" | "country shard" | "page sample";

export class PublicLawFetchError extends TaggedError("PublicLawFetchError")<{
  message: string;
  step: FetchStep;
  url: string;
  status?: number;
  cause?: unknown;
}> {}

type FetchTextOptions = {
  fetch: (url: string) => Promise<Response>;
  step: FetchStep;
  url: string;
  country?: string;
};

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type FetchFailure =
  | { type: "missing"; status: number }
  | { type: "http"; status: number }
  | { type: "transport"; cause: unknown };

const fetchFailureMessage = ({
  country,
  failure,
  step,
  url,
}: {
  country?: string | undefined;
  failure: FetchFailure;
  step: FetchStep;
  url: string;
}): string => {
  switch (failure.type) {
    case "missing":
      if (step === "country shard" && country !== undefined) {
        return `country ${country} has no sitemap shard at ${url} (HTTP ${failure.status}): is the jurisdiction pages_public on this deployment?`;
      }
      return `${step} fetch failed at ${url} (HTTP ${failure.status})`;
    case "http":
      return `${step} fetch failed at ${url} (HTTP ${failure.status})`;
    case "transport":
      return `${step} fetch failed at ${url}: ${causeMessage(failure.cause)}`;
    default:
      failure satisfies never;
      return panic("Unhandled fetch failure");
  }
};

const failedResponse = ({
  country,
  status,
  step,
  url,
}: {
  country?: string | undefined;
  status: number;
  step: FetchStep;
  url: string;
}): Result<never, PublicLawFetchError> => {
  const failure: FetchFailure =
    status === 404 || status === 410
      ? { type: "missing", status }
      : { type: "http", status };
  return Result.err(
    new PublicLawFetchError({
      message: fetchFailureMessage({ country, failure, step, url }),
      status,
      step,
      url,
    }),
  );
};

const transportFailure = ({
  cause,
  country,
  step,
  url,
}: {
  cause: unknown;
  country?: string | undefined;
  step: FetchStep;
  url: string;
}): PublicLawFetchError => {
  const failure: FetchFailure = { type: "transport", cause };
  return new PublicLawFetchError({
    cause,
    message: fetchFailureMessage({ country, failure, step, url }),
    step,
    url,
  });
};

export const fetchText = async ({
  country,
  fetch,
  step,
  url,
}: FetchTextOptions): Promise<Result<string, PublicLawFetchError>> => {
  const fetched = await Result.tryPromise({
    try: async () => await fetch(url),
    catch: (cause) => transportFailure({ cause, country, step, url }),
  });
  if (fetched.isErr()) {
    return fetched;
  }
  if (!fetched.value.ok) {
    return failedResponse({ country, status: fetched.value.status, step, url });
  }
  const body = await Result.tryPromise({
    try: async () => await fetched.value.text(),
    catch: (cause) => transportFailure({ cause, country, step, url }),
  });
  return body;
};

const MAX_SHARDS = 12;
const POOL_FACTOR = 4;

type RunCheckOptions = {
  baseUrl: string;
  country: string;
  expectedRobots: ExpectedRobots;
  fetch: (url: string) => Promise<Response>;
  random?: () => number;
  sampleSize: number;
};

export type PublicLawCheck = {
  report: Report;
  sampledUrls: readonly string[];
};

export const runPublicLawCheck = async ({
  baseUrl,
  country,
  expectedRobots,
  fetch,
  random,
  sampleSize,
}: RunCheckOptions): Promise<Result<PublicLawCheck, PublicLawFetchError>> => {
  const indexUrl = `${baseUrl}/sitemaps/law.xml`;
  const index = await fetchText({
    fetch,
    step: "sitemap index",
    url: indexUrl,
  });
  if (index.isErr()) {
    return index;
  }
  const shards = shuffled(
    filterCountryShards(parseSitemapLocs(index.value), country),
    random,
  );
  if (shards.length === 0) {
    return Result.err(
      new PublicLawFetchError({
        message: `country ${country} has no sitemap shard in ${indexUrl}: is the jurisdiction pages_public on this deployment?`,
        step: "country shard",
        url: indexUrl,
      }),
    );
  }

  const pool = new Map<string, boolean>();
  const fetchErrors: string[] = [];
  for (const shard of shards.slice(0, MAX_SHARDS)) {
    const path = new URL(shard).pathname;
    const target = `${baseUrl}${path}`;
    const contents = await fetchText({
      country,
      fetch,
      step: "country shard",
      url: target,
    });
    if (contents.isErr()) {
      return contents;
    }
    for (const url of parseSitemapLocs(contents.value)) {
      // Rejected here so every later step can parse pool keys.
      if (!URL.canParse(url)) {
        fetchErrors.push(`sitemap location is not a URL: ${url}`);
        continue;
      }
      pool.set(url, !isUndatedShardUrl(path));
    }
    if (pool.size >= sampleSize * POOL_FACTOR) {
      break;
    }
  }

  const picked = shuffled([...pool.keys()], random).slice(0, sampleSize);
  const results: PageResult[] = [];
  for (const url of picked) {
    const target = `${baseUrl}${new URL(url).pathname}`;
    const response = await Result.tryPromise({
      try: async () => await fetch(target),
      catch: (cause) =>
        transportFailure({ cause, step: "page sample", url: target }),
    });
    if (response.isErr()) {
      fetchErrors.push(response.error.message);
      continue;
    }
    if (!response.value.ok) {
      const failure = failedResponse({
        status: response.value.status,
        step: "page sample",
        url: target,
      });
      if (failure.isErr()) {
        fetchErrors.push(failure.error.message);
      }
      continue;
    }
    const html = await Result.tryPromise({
      try: async () => await response.value.text(),
      catch: (cause) =>
        transportFailure({ cause, step: "page sample", url: target }),
    });
    if (html.isErr()) {
      fetchErrors.push(html.error.message);
      continue;
    }
    results.push(
      checkPage(
        {
          url: target,
          status: response.value.status,
          contentType: response.value.headers.get("content-type"),
          xRobotsTag: response.value.headers.get("x-robots-tag"),
          dateRequired: pool.get(url) ?? true,
          html: html.value,
        },
        expectedRobots,
      ),
    );
  }
  return Result.ok({
    report: buildReport({
      baseUrl,
      country,
      expectedRobots,
      fetchErrors,
      results,
      sampleSize,
    }),
    sampledUrls: picked.map((url) => `${baseUrl}${new URL(url).pathname}`),
  });
};

export const buildReport = ({
  baseUrl,
  country,
  expectedRobots,
  fetchErrors,
  results,
  sampleSize,
}: {
  baseUrl: string;
  country: string;
  expectedRobots: ExpectedRobots;
  fetchErrors: readonly string[];
  results: readonly PageResult[];
  sampleSize: number;
}): Report => {
  const checks = CHECK_NAMES.map((check): CheckSummary => {
    const failingUrls = results
      .filter((result) => result.failed.includes(check))
      .map((result) => result.url);
    return {
      check,
      passed: results.length - failingUrls.length,
      failed: failingUrls.length,
      failingUrls,
    };
  });
  return {
    baseUrl,
    country,
    expectedRobots,
    sampleSize,
    checked: results.length,
    pass:
      results.length > 0 &&
      fetchErrors.length === 0 &&
      checks.every(({ failed }) => failed === 0),
    checks,
    fetchErrors,
  };
};

export const renderMarkdown = (report: Report): string => {
  const lines = [
    `# Public law page check: ${report.country} on ${report.baseUrl}`,
    "",
    `Result: ${report.pass ? "PASS" : "FAIL"} (${report.checked} of ${report.sampleSize} sampled pages checked, robots expected ${report.expectedRobots})`,
    "",
    "| Check | Passed | Failed |",
    "| --- | ---: | ---: |",
    ...report.checks.map(
      ({ check, failed, passed }) => `| ${check} | ${passed} | ${failed} |`,
    ),
  ];
  for (const { check, failingUrls } of report.checks) {
    if (failingUrls.length === 0) {
      continue;
    }
    lines.push("", `## Failing: ${check}`, ...failingUrls.map((u) => `- ${u}`));
  }
  if (report.fetchErrors.length > 0) {
    lines.push(
      "",
      "## Fetch errors",
      ...report.fetchErrors.map((url) => `- ${url}`),
    );
  }
  return `${lines.join("\n")}\n`;
};

/** `<loc>` values of a sitemap document. */
export const parseSitemapLocs = (xml: string): string[] =>
  [...xml.matchAll(/<loc>([^<]*)<\/loc>/gu)].flatMap((match) => {
    const loc = (match[1] ?? "").trim();
    return loc.length === 0 ? [] : [decodeEntities(loc)];
  });

/** Case-law shard sitemaps of a country, from the law sitemap index. */
export const filterCountryShards = (
  locs: readonly string[],
  country: string,
): string[] => {
  const segment = `/sitemaps/law-cases/${country.toLowerCase()}/`;
  return locs.filter((loc) => loc.includes(segment));
};

/** Fisher-Yates with an injectable random source for tests. */
export const shuffled = <T>(
  items: readonly T[],
  random: () => number = Math.random,
): T[] => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = copy[index];
    const other = copy[swap];
    if (held === undefined || other === undefined) {
      continue;
    }
    copy[index] = other;
    copy[swap] = held;
  }
  return copy;
};
