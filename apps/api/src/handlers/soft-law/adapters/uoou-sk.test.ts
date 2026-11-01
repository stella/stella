import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { load } from "@stll/html";
import type { CheerioAPI } from "@stll/html/selection";
import { sha256Hex } from "@stll/sha256/bun";

import type { SoftLawFetch } from "@/api/lib/legal-search/soft-law-access-types";
import { SoftLawAccessError } from "@/api/lib/legal-search/soft-law-access-types";
import {
  softLawContentHash,
  softLawIdentityKey,
} from "@/api/lib/legal-search/soft-law-fingerprint";
import {
  SoftLawIngestionError,
  SoftLawItemError,
} from "@/api/lib/legal-search/soft-law-types";
import type { SoftLawEntry } from "@/api/lib/legal-search/soft-law-types";

import { configureSoftLawAdapter, SOFT_LAW_ADMISSIONS } from "./registry";
import { parseUoouSkListing, uoouSkAdapter } from "./uoou-sk";

const ORIGIN = "https://dataprotection.gov.sk";
const INDEX = `${ORIGIN}/sk/urad/o-nas/vyrocne-spravy/`;
const REPORT_2025 = `${ORIGIN}/files/annual-reports/uoou_sprava-stave-ochrany-osobnych-udajov_2025.pdf`;
const REPORT_COUNT = 19;
const fixture = async (name: string) =>
  gunzipSync(
    await readFile(new URL(`__fixtures__/${name}.gz`, import.meta.url)),
  );
const listingHtml = async () =>
  (await fixture("uoou-sk-annual-reports.html")).toString("utf-8");
const signal = () => AbortSignal.timeout(60_000);
type FixtureResponse = { bytes: Uint8Array; contentType: string };
const transport = (respond: (url: string) => FixtureResponse | undefined) => {
  const calls: string[] = [];
  const fetch: SoftLawFetch = Object.assign(
    async (url: string) => {
      calls.push(url);
      const response = respond(url);
      return response
        ? Result.ok(response)
        : Result.err(
            new SoftLawAccessError({ message: "Unexpected fixture request" }),
          );
    },
    {
      getBlockReason: () => null,
      getWindowState: () => "open" as const,
      getLeaseState: () => "active" as const,
    },
  );
  return { fetch, calls };
};
const publisher = async () => {
  const index = {
    bytes: await fixture("uoou-sk-annual-reports.html"),
    contentType: "text/html;charset=utf-8",
  };
  const report = {
    bytes: await fixture("uoou-sk-annual-report-2025.pdf"),
    contentType: "application/pdf;charset=UTF-8",
  };
  return transport((url) => {
    if (url === INDEX) {
      return index;
    }
    return url === REPORT_2025 ? report : undefined;
  });
};
const walk = async (fetch: SoftLawFetch, start: string | null = null) => {
  const entries: SoftLawEntry[] = [];
  const cursors: (string | null)[] = [];
  let cursor = start;
  do {
    const page = (
      await uoouSkAdapter.discover({ cursor, signal: signal(), fetch })
    ).unwrap();
    for (const entry of page.entries) {
      entries.push(entry);
    }
    cursor = page.nextCursor;
    cursors.push(cursor);
  } while (cursor !== null);
  return { entries, cursors };
};
const indexDigest = async (fetch: SoftLawFetch) =>
  (await uoouSkAdapter.discover({ cursor: null, signal: signal(), fetch }))
    .unwrap()
    .nextCursor?.split(":")
    .at(1) ?? panic("Missing ÚOOÚ SR index digest");

test("ÚOOÚ SR fixtures preserve publisher response bytes and capture provenance", async () => {
  for (const name of [
    "uoou-sk-annual-reports.html",
    "uoou-sk-annual-report-2025.pdf",
  ]) {
    const provenance: unknown = JSON.parse(
      await readFile(
        new URL(`__fixtures__/${name}.gz.provenance.json`, import.meta.url),
        "utf-8",
      ),
    );
    expect(provenance).toMatchObject({
      sha256: sha256Hex(await fixture(name)),
      sourceUrl: expect.stringContaining(ORIGIN),
      retrievedAt: expect.any(String),
    });
  }
});

test("ÚOOÚ SR annual-report index yields every row verbatim with its document locator", async () => {
  const listing = parseUoouSkListing(await listingHtml()).unwrap();
  expect(listing.sourceKind).toBe("Výročné správy");
  expect(listing.language).toBe("sk-SK");
  expect(listing.reports).toHaveLength(REPORT_COUNT);
  expect(listing.reports.at(0)).toEqual({
    title: "sprava o stave ochrany osobnych udajov za rok 2025",
    url: REPORT_2025,
  });
  expect(listing.reports.at(-1)?.title).toBe(
    "vyrocna sprava roky 1992 az september 2000",
  );
  expect(new Set(listing.reports.map((report) => report.url)).size).toBe(
    REPORT_COUNT,
  );
  for (const report of listing.reports) {
    expect(new URL(report.url).pathname).toStartWith("/files/annual-reports/");
  }
});

test("ÚOOÚ SR refuses a changed index shell, pagination, ambiguous rows and foreign locators", async () => {
  const html = await listingHtml();
  const mutate = (change: (root: CheerioAPI) => unknown) => {
    const $ = load(html);
    change($);
    return $.html();
  };
  const row = "main article table.tabulkaStandard tbody tr";
  for (const changed of [
    mutate(($) => $('link[rel="canonical"]').attr("href", `${ORIGIN}/sk/`)),
    mutate(($) => $("html").attr("lang", "en")),
    mutate(($) => $("main article h3").text("Judikatúra")),
    mutate(($) => $(row).remove()),
    mutate(($) =>
      $("main article").append(
        '<a href="/sk/urad/o-nas/vyrocne-spravy/?page=2">2</a>',
      ),
    ),
    mutate(($) =>
      $("main article").after(
        '<nav class="pagination"><a href="/sk/urad/o-nas/vyrocne-spravy/?page=2">2</a></nav>',
      ),
    ),
    mutate(($) => $(row).first().after($(row).first().clone())),
    mutate(($) => $(row).first().find("td.fN").text(" ")),
    mutate(($) =>
      $(row).first().find("td.fS a").attr("href", "https://example.org/x.pdf"),
    ),
    mutate(($) =>
      $(row).first().find("td.fS a").attr("href", "/sk/urad/o-nas/"),
    ),
    mutate(($) =>
      $(row)
        .first()
        .find("td.fS")
        .append('<a href="/files/annual-reports/y.pdf">x</a>'),
    ),
  ]) {
    expect(parseUoouSkListing(changed).isErr()).toBe(true);
  }
});

test("ÚOOÚ SR discovery pages the index in bounded batches and admits only annual reports", async () => {
  const { fetch, calls } = await publisher();
  const { entries, cursors } = await walk(fetch);
  const digest = cursors.at(0)?.split(":").at(1) ?? panic("Missing digest");
  expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  expect(cursors).toEqual([
    `5:${digest}`,
    `10:${digest}`,
    `15:${digest}`,
    null,
  ]);
  expect(calls).toEqual(Array.from({ length: 4 }, () => INDEX));
  expect(entries).toHaveLength(REPORT_COUNT);
  const first = entries.at(0) ?? panic("Missing first ÚOOÚ SR report");
  expect(first).toMatchObject({
    url: REPORT_2025,
    sourcePages: [INDEX],
    sourceDates: {},
  });
  expect(first.metadata).toEqual({
    title: "sprava o stave ochrany osobnych udajov za rok 2025",
    kind: "annual_report",
    sourceKind: "Výročné správy",
    statedReference: { state: "not_stated" },
    issuedOn: { state: "not_stated" },
    expression: {
      type: "identified",
      language: "sk-SK",
      revision: { state: "not_stated" },
    },
    stage: { state: "not_stated" },
    relations: [],
    validity: { state: "not_stated", basis: "source_stated" },
  });
  const identities = entries.map((entry) =>
    softLawIdentityKey("sk-uoou", entry.metadata).unwrap(),
  );
  expect(new Set(identities).size).toBe(REPORT_COUNT);
  const replayed = await walk(fetch);
  expect(
    replayed.entries.map((entry) =>
      softLawIdentityKey("sk-uoou", entry.metadata).unwrap(),
    ),
  ).toEqual(identities);
});

test("a walk resumed from any checkpoint visits each remaining report exactly once", async () => {
  const { fetch } = await publisher();
  const reports = parseUoouSkListing(await listingHtml()).unwrap().reports;
  const digest = await indexDigest(fetch);
  for (let offset = 0; offset <= REPORT_COUNT; offset++) {
    const { entries } = await walk(fetch, `${offset}:${digest}`);
    expect(entries.map((entry) => entry.url)).toEqual(
      reports.slice(offset).map((report) => report.url),
    );
  }
});

test("a checkpoint taken on a changed index restarts the walk instead of skipping shifted reports", async () => {
  const html = await listingHtml();
  const $ = load(html);
  $("main article table.tabulkaStandard tbody tr").first().remove();
  const shortened = new TextEncoder().encode($.html());
  let served = 0;
  const { fetch } = transport((url) => {
    if (url !== INDEX) {
      return undefined;
    }
    served += 1;
    return {
      bytes: served === 1 ? new TextEncoder().encode(html) : shortened,
      contentType: "text/html;charset=utf-8",
    };
  });
  const remaining = parseUoouSkListing($.html()).unwrap().reports;
  const { entries } = await walk(fetch);
  // The first batch came from the original index; the rest restart on the new one.
  expect(entries.slice(5).map((entry) => entry.url)).toEqual(
    remaining.map((report) => report.url),
  );
});

test("ÚOOÚ SR discovery refuses a malformed cursor before any request", async () => {
  const { fetch, calls } = await publisher();
  const digest = "0".repeat(64);
  for (const cursor of [
    "5",
    "5:x",
    `5:${digest}:0`,
    ...["-1", "01", "x", "1.5"].map((offset) => `${offset}:${digest}`),
  ]) {
    const result = await uoouSkAdapter.discover({
      cursor,
      signal: signal(),
      fetch,
    });
    expect(result.isErr() && SoftLawIngestionError.is(result.error)).toBeTrue();
  }
  expect(calls).toEqual([]);
});

test("ÚOOÚ SR fetch re-reads the captured index, keeps provenance and converges on replay", async () => {
  const { fetch } = await publisher();
  const entry =
    (await walk(fetch)).entries.at(0) ?? panic("Missing ÚOOÚ SR report");
  const first = (
    await uoouSkAdapter.fetchDocument(entry, { signal: signal(), fetch })
  ).unwrap();
  expect(entry.metadata).toEqual(first.metadata);
  expect(first.extractionQuality).toBe("text_layer");
  expect(first.text).toContain("OCHRANY OSOBNÝCH");
  expect(first.raw.map((part) => [part.role, part.purpose])).toEqual([
    ["index", "discovery"],
    ["document", "document"],
  ]);
  for (const part of first.raw) {
    expect(part.provenance.sha256).toBe(sha256Hex(part.bytes));
  }
  expect(first.raw.at(1)?.provenance.url).toBe(REPORT_2025);
  const replay = (
    await uoouSkAdapter.fetchDocument(entry, { signal: signal(), fetch })
  ).unwrap();
  expect(softLawContentHash(replay)).toBe(softLawContentHash(first));
  expect(softLawIdentityKey("sk-uoou", replay.metadata, replay).unwrap()).toBe(
    softLawIdentityKey("sk-uoou", first.metadata, first).unwrap(),
  );
});

test("ÚOOÚ SR fetch refuses forged receipts and non-PDF responses as item rejections", async () => {
  const { fetch } = await publisher();
  const entry =
    (await walk(fetch)).entries.at(0) ?? panic("Missing ÚOOÚ SR report");
  const index = entry.sourceRaw?.at(0) ?? panic("Missing captured index");
  const tampered = Buffer.from(
    (await listingHtml()).replace("za rok 2025", "za rok 2026"),
  ).toString("base64");
  for (const forged of [
    { ...entry, sourceRaw: [] },
    { ...entry, sourceRaw: [{ ...index, contentBase64: tampered }] },
    { ...entry, sourceRaw: [{ ...index, role: "detail" }] },
    { ...entry, url: `${ORIGIN}/files/annual-reports/other.pdf` },
  ] as const satisfies readonly SoftLawEntry[]) {
    const result = await uoouSkAdapter.fetchDocument(forged, {
      signal: signal(),
      fetch,
    });
    expect(result.isErr() && SoftLawItemError.is(result.error)).toBeTrue();
  }
  const html = transport((url) =>
    url === REPORT_2025
      ? {
          bytes: new TextEncoder().encode("<html></html>"),
          contentType: "application/pdf",
        }
      : undefined,
  );
  const result = await uoouSkAdapter.fetchDocument(entry, {
    signal: signal(),
    fetch: html.fetch,
  });
  expect(result.isErr() && SoftLawItemError.is(result.error)).toBeTrue();
});

test("ÚOOÚ SR declares every field its index states and needs no admission file", async () => {
  const fields = uoouSkAdapter.sourceFields.listSourceFields({
    index: await listingHtml(),
  });
  expect(Object.keys(uoouSkAdapter.sourceFields.fields)).toEqual(fields);
  expect(
    (
      await configureSoftLawAdapter(SOFT_LAW_ADMISSIONS["sk-uoou"].adapter, {
        type: "default",
      })
    ).unwrap(),
  ).toBe(SOFT_LAW_ADMISSIONS["sk-uoou"].adapter);
});
