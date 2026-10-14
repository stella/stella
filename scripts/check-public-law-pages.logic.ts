/**
 * Pure checks for a served public decision page. Nothing here fetches; the
 * CLI in `check-public-law-pages.ts` feeds in HTML. Findings carry counts and
 * URLs only, never page text, so a report is safe to share.
 */

export const CHECK_NAMES = [
  "http-200",
  "server-rendered",
  "decision-text",
  "metadata",
  "robots",
  "anonymisation",
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
  return decodeEntities(stripped.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
};

export type RobotsDirective = {
  present: boolean;
  noindex: boolean;
};

export const readRobotsMeta = (html: string): RobotsDirective => {
  const tags = html.match(/<meta\b[^>]*>/giu) ?? [];
  for (const tag of tags) {
    if (!/name\s*=\s*["']robots["']/iu.test(tag)) {
      continue;
    }
    const content = /content\s*=\s*["']([^"']*)["']/iu.exec(tag)?.[1] ?? "";
    return { present: true, noindex: /\bnoindex\b/iu.test(content) };
  }
  return { present: false, noindex: false };
};

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

/** Birth numbers such as 800101/1234 (Czech and Slovak). */
const BIRTH_NUMBER = /(?<![\d/])\d{6}\/\d{3,4}(?![\d/])/gu;
/** "nar." or "narozen(a)" followed within a few words by a full date. */
const BORN_ON =
  /\bnar(?:\.|ozen[aáý]?|odený|odená)?\s*(?:dňa\s+|dne\s+)?\d{1,2}\s?\.\s?\d{1,2}\s?\.\s?\d{4}/giu;
/** "date of birth" phrases followed by a date. */
const DATE_OF_BIRTH_PHRASE =
  /(?:dátum narodenia|datum narození|date of birth)\s*:?\s*\d{1,2}\s?\.\s?\d{1,2}\s?\.\s?\d{4}/giu;

const ANONYMISATION_MARKER = /X{3,}|\*{3,}|\[\.{3}\]|\[…\]|(?:\b[A-Z]\.){2,}/u;

export type AnonymisationFindings = {
  birthNumbers: number;
  bornOnDates: number;
  dateOfBirthPhrases: number;
  /** Informational: courts use many conventions, so this never fails a page. */
  hasAnonymisationMarker: boolean;
};

export const scanAnonymisation = (text: string): AnonymisationFindings => ({
  birthNumbers: text.match(BIRTH_NUMBER)?.length ?? 0,
  bornOnDates: text.match(BORN_ON)?.length ?? 0,
  dateOfBirthPhrases: text.match(DATE_OF_BIRTH_PHRASE)?.length ?? 0,
  hasAnonymisationMarker: ANONYMISATION_MARKER.test(text),
});

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
  anonymisation: AnonymisationFindings;
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
  if (ok && text.length < MIN_DECISION_TEXT_CHARS) {
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
  const anonymisation = scanAnonymisation(text);
  if (
    anonymisation.birthNumbers > 0 ||
    anonymisation.bornOnDates > 0 ||
    anonymisation.dateOfBirthPhrases > 0
  ) {
    failed.push("anonymisation");
  }
  return { url: page.url, failed, anonymisation, textChars: text.length };
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
  /** Pages without a recognisable anonymisation marker; informational. */
  pagesWithoutAnonymisationMarker: number;
  fetchErrors: readonly string[];
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
    pagesWithoutAnonymisationMarker: results.filter(
      ({ anonymisation }) => !anonymisation.hasAnonymisationMarker,
    ).length,
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
    "",
    `Pages without an anonymisation marker (informational): ${report.pagesWithoutAnonymisationMarker}`,
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
  [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gu)].map((match) =>
    decodeEntities(match[1] ?? ""),
  );

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
