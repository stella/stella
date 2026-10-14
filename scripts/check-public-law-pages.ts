import { panic } from "better-result";
/**
 * Checks a random sample of a country's public decision pages on a deployment.
 *
 *   bun scripts/check-public-law-pages.ts --base-url https://<web-host> \
 *     --country svk --sample 50 --expect-robots noindex --out-dir ./out
 *
 * The sample is drawn from the sitemap shards the web serves
 * (`/sitemaps/law.xml`), so it checks what a crawler would be offered. Shards
 * are visited in random order until enough decision URLs are collected, which
 * makes the sample random within those shards, not uniform over the country.
 * Requests are sequential, at most one per second, and unauthenticated. The
 * report holds counts and URLs only, never page text.
 */
import nodePath from "node:path";
import { parseArgs } from "node:util";

import {
  buildReport,
  checkPage,
  filterCountryShards,
  parseSitemapLocs,
  renderMarkdown,
  shuffled,
} from "./check-public-law-pages.logic";
import type {
  ExpectedRobots,
  PageResult,
} from "./check-public-law-pages.logic";

const REQUEST_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SHARDS = 12;
const POOL_FACTOR = 4;

let lastRequestAt = 0;
const politeFetch = async (url: string): Promise<Response> => {
  const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) {
    await Bun.sleep(wait);
  }
  lastRequestAt = Date.now();
  return await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
};

const fetchText = async (url: string): Promise<string> => {
  const response = await politeFetch(url);
  if (!response.ok) {
    return panic(`HTTP ${response.status}`);
  }
  return await response.text();
};

const parseCliArgs = () => {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      country: { type: "string" },
      sample: { type: "string", default: "50" },
      "expect-robots": { type: "string", default: "noindex" },
      "out-dir": { type: "string", default: "." },
    },
  });
  const baseUrl = values["base-url"]?.replace(/\/+$/u, "");
  const country = values.country?.toLowerCase();
  const sample = Number(values.sample);
  const expectedRobots = values["expect-robots"];
  if (
    baseUrl === undefined ||
    country === undefined ||
    !/^[a-z]{2,3}$/u.test(country) ||
    !Number.isInteger(sample) ||
    sample < 1 ||
    (expectedRobots !== "indexable" && expectedRobots !== "noindex")
  ) {
    return panic(
      "Usage: --base-url <url> --country <svk> [--sample 50] [--expect-robots indexable|noindex] [--out-dir dir]",
    );
  }
  return {
    baseUrl,
    country,
    sample,
    expectedRobots: expectedRobots satisfies ExpectedRobots,
    outDir: values["out-dir"] ?? ".",
  };
};

const collectDecisionUrls = async (
  baseUrl: string,
  country: string,
  wanted: number,
): Promise<string[]> => {
  const index = parseSitemapLocs(
    await fetchText(`${baseUrl}/sitemaps/law.xml`),
  );
  const shards = shuffled(filterCountryShards(index, country));
  if (shards.length === 0) {
    return panic(`No ${country} case-law shards in the law sitemap.`);
  }
  const urls = new Set<string>();
  for (const shard of shards.slice(0, MAX_SHARDS)) {
    // The index may carry absolute URLs of another origin; fetch via ours.
    const path = new URL(shard).pathname;
    for (const loc of parseSitemapLocs(await fetchText(`${baseUrl}${path}`))) {
      urls.add(loc);
    }
    if (urls.size >= wanted * POOL_FACTOR) {
      break;
    }
  }
  return [...urls];
};

const main = async () => {
  const { baseUrl, country, expectedRobots, outDir, sample } = parseCliArgs();
  const pool = await collectDecisionUrls(baseUrl, country, sample);
  const picked = shuffled(pool).slice(0, sample);
  const results: PageResult[] = [];
  const fetchErrors: string[] = [];
  for (const url of picked) {
    try {
      const path = new URL(url).pathname;
      const target = `${baseUrl}${path}`;
      const response = await politeFetch(target);
      results.push(
        checkPage(
          {
            url: target,
            status: response.status,
            contentType: response.headers.get("content-type"),
            html: await response.text(),
          },
          expectedRobots,
        ),
      );
    } catch {
      fetchErrors.push(url);
    }
  }
  const report = buildReport({
    baseUrl,
    country,
    expectedRobots,
    fetchErrors,
    results,
    sampleSize: sample,
  });
  await Bun.write(
    nodePath.join(outDir, `public-law-pages-${country}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const markdown = renderMarkdown(report);
  await Bun.write(
    nodePath.join(outDir, `public-law-pages-${country}.md`),
    markdown,
  );
  process.stdout.write(markdown);
  process.exitCode = report.pass ? 0 : 1;
};

await main();
