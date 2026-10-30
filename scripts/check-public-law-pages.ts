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
import { panic } from "better-result";
import nodePath from "node:path";
import { parseArgs } from "node:util";

import {
  renderMarkdown,
  runPublicLawCheck,
} from "./check-public-law-pages.logic";
import type { ExpectedRobots } from "./check-public-law-pages.logic";

const REQUEST_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 20_000;

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

const withoutTrailingSlashes = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
};

const parseExpectedRobots = (
  value: string | undefined,
): ExpectedRobots | null =>
  value === "indexable" || value === "noindex" ? value : null;

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
  const baseUrl = withoutTrailingSlashes(values["base-url"]);
  const country = values.country?.toLowerCase();
  const sample = Number(values.sample);
  const expectedRobots = parseExpectedRobots(values["expect-robots"]);
  if (
    baseUrl === undefined ||
    country === undefined ||
    !/^[a-z]{2,3}$/u.test(country) ||
    !Number.isInteger(sample) ||
    sample < 1 ||
    expectedRobots === null
  ) {
    return panic(
      "Usage: --base-url <url> --country <svk> [--sample 50] [--expect-robots indexable|noindex] [--out-dir dir]",
    );
  }
  return {
    baseUrl,
    country,
    sample,
    expectedRobots,
    outDir: values["out-dir"],
  };
};

const main = async () => {
  const { baseUrl, country, expectedRobots, outDir, sample } = parseCliArgs();
  const checked = await runPublicLawCheck({
    baseUrl,
    country,
    expectedRobots,
    fetch: politeFetch,
    sampleSize: sample,
  });
  if (checked.isErr()) {
    process.stderr.write(`${checked.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  await Bun.write(
    nodePath.join(outDir, `public-law-pages-${country}-sample.txt`),
    `${checked.value.sampledUrls.join("\n")}\n`,
  );
  const { report } = checked.value;
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
