import { panic, Result } from "better-result";
import { beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { load } from "@stll/html";
import { sha256Hex } from "@stll/sha256/bun";

import type { SoftLawFetch } from "@/api/lib/legal-search/soft-law-access-types";
import {
  SoftLawAccessError,
  SoftLawBlockedError,
} from "@/api/lib/legal-search/soft-law-access-types";
import {
  softLawContentHash,
  softLawIdentityKey,
} from "@/api/lib/legal-search/soft-law-fingerprint";
import {
  SoftLawIngestionError,
  SoftLawItemError,
} from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawDiscoveryEntry,
  SoftLawEntry,
} from "@/api/lib/legal-search/soft-law-types";

import { createSoftLawFetch } from "../publisher-access";
import { configureSoftLawAdapter, SOFT_LAW_ADMISSIONS } from "./registry";
import { parseSuipDocuments, parseSuipFaq, suipAdapter } from "./suip";

const ORIGIN = "https://suip.gov.cz";
const page = (slug: string) => `${ORIGIN}/web/suip/${slug}`;
const METHODOLOGY_PDF =
  "https://suip.gov.cz/documents/20142/1105684/MPGI+5_2025-+Z%C3%A1sady+hodnocen%C3%AD+srovnateln%C3%BDch+pracovn%C3%ADch+a+mzdov%C3%BDch+podm%C3%ADnek+do%C4%8Dasn%C4%9B+p%C5%99id%C4%9Blen%C3%A9ho+zam%C4%9Bstnace+a+srovnateln%C3%A9ho+zam%C4%9Bsntance+u%C5%BEivatele+NA+WEB.pdf/c89c774b-1a4d-3a37-4c9c-016829cdec1b";
const CASE_STUDY_9 = `${ORIGIN}/web/suip/novinky/-/asset_publisher/Z8ivneU2D1Hv/content/kazuistika-c-9-legalni-agenturni-zamestnavani-vs-nelegalni-zastrene-zprostredkovani-zamestnani`;
/** Questions per Q&A page: 146, 42, 14 and 2. */
const FAQ_COUNT = 204;
const CASE_STUDY_COUNT = 9;
/** Methodology 1; results 21; activity 26; publications 11; leaflets 42 (43 rows less one the publications list owns). */
const DOCUMENT_COUNT = 1 + 21 + 26 + 11 + 42;
const ARCHIVE_COUNT = 2;
const FIXTURE_BY_SLUG = {
  "bezpecnost-prace-otazky-a-odpovedi": "suip-qa-bezpecnost.html",
  "pracovne-pravni-vztahy-otazky-a-odpovedi": "suip-qa-pracovni-vztahy.html",
  "zamestnanost-otazky-a-odpovedi": "suip-qa-zamestnanost.html",
  "otazky-a-odpovedi1": "suip-qa-vysilani.html",
  "srovnatelne-podminky-pri-agenturnim-zamestnavani-metodika":
    "suip-methodology.html",
  "kazuistiky-vsechny": "suip-case-studies.html",
  "o-vysledcich-kontrolnich-akci": "suip-annual-results.html",
  "zpravy-o-cinnosti-suip": "suip-annual-activity.html",
  publikace: "suip-publications.html",
  "informacni-letaky": "suip-leaflets.html",
} as const;
type Slug = keyof typeof FIXTURE_BY_SLUG;
const SLUGS = Object.keys(FIXTURE_BY_SLUG).filter((slug): slug is Slug =>
  Object.hasOwn(FIXTURE_BY_SLUG, slug),
);
const OTHER_FIXTURES = [
  "suip-case-study.html",
  "suip-methodology.pdf",
] as const;
type FixtureName =
  (typeof FIXTURE_BY_SLUG)[Slug] | (typeof OTHER_FIXTURES)[number];

const fixture = async (name: FixtureName) =>
  gunzipSync(
    await readFile(new URL(`__fixtures__/${name}.gz`, import.meta.url)),
  );
const fixtureText = async (name: FixtureName) =>
  (await fixture(name)).toString("utf-8");
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
const html = (text: string | Uint8Array) => ({
  bytes: typeof text === "string" ? new TextEncoder().encode(text) : text,
  contentType: "text/html;charset=UTF-8",
});
const publisher = async (overrides: Record<string, FixtureResponse> = {}) => {
  const responses = new Map<string, FixtureResponse>();
  for (const slug of SLUGS) {
    responses.set(page(slug), html(await fixture(FIXTURE_BY_SLUG[slug])));
  }
  responses.set(CASE_STUDY_9, html(await fixture("suip-case-study.html")));
  responses.set(METHODOLOGY_PDF, {
    bytes: await fixture("suip-methodology.pdf"),
    contentType: "application/pdf",
  });
  for (const [url, response] of Object.entries(overrides)) {
    responses.set(url, response);
  }
  return transport((url) => responses.get(url));
};
const walk = async (fetch: SoftLawFetch) => {
  const entries: SoftLawDiscoveryEntry[] = [];
  const cursors: (string | null)[] = [];
  let cursor: string | null = null;
  do {
    const result: Awaited<ReturnType<typeof suipAdapter.discover>> =
      await suipAdapter.discover({ cursor, signal: signal(), fetch });
    const page_ = result.unwrap();
    entries.push(...page_.entries);
    cursor = page_.nextCursor;
    cursors.push(cursor);
  } while (cursor !== null);
  return { entries, cursors };
};
/** A full walk parses every collection page; the tests share its result. */
let walked: Awaited<ReturnType<typeof walk>>;
// timeout: parses every collection page, up to 790 kB each, on a loaded runner.
beforeAll(async () => {
  walked = await walk((await publisher()).fetch);
}, 120_000);
const documentEntry = (entry: SoftLawDiscoveryEntry | undefined) => {
  if (entry?.type !== "document") {
    return panic("Expected a document entry");
  }
  return entry;
};
const documents = (entries: readonly SoftLawDiscoveryEntry[]) =>
  entries.filter((entry) => entry.type === "document");

test("SÚIP fixtures preserve publisher response bytes and capture provenance", async () => {
  for (const name of [
    ...SLUGS.map((slug) => FIXTURE_BY_SLUG[slug]),
    ...OTHER_FIXTURES,
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

test("each Q&A question becomes one entry with a stable anchor", async () => {
  const items = parseSuipFaq(
    await fixtureText("suip-qa-zamestnanost.html"),
    "zamestnanost-otazky-a-odpovedi",
  ).unwrap();
  expect(items).toHaveLength(14);
  for (const item of items) {
    expect(item.anchor).toMatch(/^[\p{L}\d._~/-]+$/u);
    expect(item.title).not.toBe("");
    expect(item.fragment).toContain("accordion__body");
  }
  expect(new Set(items.map((item) => item.anchor)).size).toBe(14);
});

test("repeated publisher anchors stay distinct through an ordinal", async () => {
  const items = parseSuipFaq(
    await fixtureText("suip-qa-bezpecnost.html"),
    "bezpecnost-prace-otazky-a-odpovedi",
  ).unwrap();
  expect(items).toHaveLength(146);
  expect(new Set(items.map((item) => item.anchor)).size).toBe(146);
  expect(items.some((item) => /~\d+$/u.test(item.anchor))).toBeTrue();
});

test("SÚIP refuses a changed shell, an empty page and an anchorless question", async () => {
  const qa = await fixtureText("suip-qa-zamestnanost.html");
  const slug = "zamestnanost-otazky-a-odpovedi";
  const mutate = (change: (root: ReturnType<typeof load>) => unknown) => {
    const $ = load(qa);
    change($);
    return $.html();
  };
  for (const changed of [
    mutate(($) =>
      $('link[rel="canonical"]').attr("href", `${ORIGIN}/jina-stranka`),
    ),
    mutate(($) => $("#main-content").removeAttr("id")),
    mutate(($) => $(".accordion").remove()),
    mutate(($) => $(".accordion").first().removeAttr("id")),
    mutate(($) => $(".accordion__title").first().text(" ")),
  ]) {
    expect(parseSuipFaq(changed, slug).isErr()).toBe(true);
  }
});

test("a full walk visits every collection and no publisher row vanishes", async () => {
  const { entries, cursors } = walked;
  const rejected = entries.filter((entry) => entry.type === "rejected");
  expect(documents(entries)).toHaveLength(
    FAQ_COUNT + CASE_STUDY_COUNT + DOCUMENT_COUNT,
  );
  expect(rejected).toHaveLength(ARCHIVE_COUNT);
  expect(rejected.map((entry) => entry.url).join(" ")).toContain(".zip");
  expect(cursors.at(-1)).toBeNull();
  // Each batch is bounded and the safety page spans three cursors.
  expect(cursors.filter((cursor) => cursor?.startsWith("0:"))).toHaveLength(2);
  const identities = documents(entries).map((entry) =>
    softLawIdentityKey("cz-suip", entry.metadata).unwrap(),
  );
  expect(new Set(identities).size).toBe(identities.length);
});

test("a stripped version token keeps one locator per PDF; a listed archive is rejected visibly", async () => {
  const listing = parseSuipDocuments(
    await fixtureText("suip-annual-activity.html"),
    "zpravy-o-cinnosti-suip",
  ).unwrap();
  expect(listing.rows).toHaveLength(26);
  expect(listing.unsupported).toHaveLength(ARCHIVE_COUNT);
  for (const row of listing.rows) {
    expect(new URL(row.url).search).toBe("");
    expect(row.sourceDocumentId).toMatch(/^[0-9a-f-]{36}$/iu);
  }
  const leaflets = parseSuipDocuments(
    await fixtureText("suip-leaflets.html"),
    "informacni-letaky",
  ).unwrap();
  // Three links are commented out in the publisher's HTML; one file is listed twice.
  expect(leaflets.rows).toHaveLength(43);
  const publication = "bd8fa46b-9aaa-1837-7af4-5dfc789de09f";
  expect(
    leaflets.rows.some((row) => row.sourceDocumentId === publication),
  ).toBeTrue();
  expect(
    documents(walked.entries).filter(
      (entry) => entry.metadata.sourceDocumentId === publication,
    ),
  ).toHaveLength(1);
});

test("a changed collection restarts its offset instead of skipping rows", async () => {
  const known = await publisher();
  const result = await suipAdapter.discover({
    cursor: `0:50:${"a".repeat(64)}`,
    signal: signal(),
    fetch: known.fetch,
  });
  const restarted = result.unwrap();
  expect(restarted.nextCursor).toMatch(/^0:50:[0-9a-f]{64}$/u);
  expect(restarted.entries.at(0)?.url).toContain(
    "bezpecnost-prace-otazky-a-odpovedi#",
  );
});

test("a malformed cursor is refused before any request", async () => {
  const known = await publisher();
  for (const cursor of [
    "0",
    "0:0",
    `x:0:${"0".repeat(64)}`,
    `0:01:${"0".repeat(64)}`,
    `10:0:${"0".repeat(64)}`,
    "0:0:abc",
  ]) {
    const result = await suipAdapter.discover({
      cursor,
      signal: signal(),
      fetch: known.fetch,
    });
    expect(result.isErr() && SoftLawIngestionError.is(result.error)).toBeTrue();
  }
  expect(known.calls).toEqual([]);
});

test("a Q&A entry reads from its captured element without any request", async () => {
  const { entries } = walked;
  const entry = documentEntry(
    documents(entries).find((candidate) =>
      candidate.url.includes("zamestnanost-otazky-a-odpovedi#"),
    ),
  );
  const replay = transport(() => undefined);
  const first = (
    await suipAdapter.fetchDocument(entry, {
      signal: signal(),
      fetch: replay.fetch,
    })
  ).unwrap();
  expect(replay.calls).toEqual([]);
  expect(first.metadata).toMatchObject({
    kind: "faq",
    sourceKind: "Otázky a odpovědi",
  });
  expect(first.extractionQuality).toBe("html");
  expect(first.text).toContain("Dotaz:");
  expect(first.text).toContain("Odpověď:");
  expect(first.raw.map((part) => [part.role, part.purpose])).toEqual([
    ["document", "document"],
  ]);
  const again = (
    await suipAdapter.fetchDocument(entry, {
      signal: signal(),
      fetch: replay.fetch,
    })
  ).unwrap();
  expect(softLawContentHash(again)).toBe(softLawContentHash(first));
});

test("a changed answer is a content change; surrounding page chrome is not", async () => {
  const slug = "zamestnanost-otazky-a-odpovedi";
  const original = await fixtureText("suip-qa-zamestnanost.html");
  const hashOf = async (body: string) => {
    const { fetch } = await publisher({ [page(slug)]: html(body) });
    const discovered = (
      await suipAdapter.discover({
        cursor: `2:0:${"0".repeat(64)}`,
        signal: signal(),
        fetch,
      })
    ).unwrap();
    const entry = documentEntry(discovered.entries.at(0));
    return softLawContentHash(
      (
        await suipAdapter.fetchDocument(entry, {
          signal: signal(),
          fetch,
        })
      ).unwrap(),
    );
  };
  const chromeOnly = original.replace(/&t=\d+/u, "&t=1");
  expect(chromeOnly).not.toBe(original);
  expect(await hashOf(chromeOnly)).toBe(await hashOf(original));
  const $ = load(original);
  $(".accordion__body").first().append("<p>Doplněno.</p>");
  expect(await hashOf($.html())).not.toBe(await hashOf(original));
});

test("the methodology page yields one numbered document from its PDF", async () => {
  const known = await publisher();
  const { entries } = walked;
  const entry = documentEntry(
    documents(entries).find((candidate) => candidate.url === METHODOLOGY_PDF),
  );
  const input = (
    await suipAdapter.fetchDocument(entry, {
      signal: signal(),
      fetch: known.fetch,
    })
  ).unwrap();
  expect(input.metadata).toMatchObject({
    title: "Srovnatelné podmínky při agenturním zaměstnávání",
    kind: "methodology",
    sourceKind: "Metodický pokyn generálního inspektora",
    statedReference: { state: "stated", value: "5/2025" },
  });
  expect(input.extractionQuality).toBe("text_layer");
  expect(input.raw.map((part) => [part.role, part.purpose])).toEqual([
    ["page", "discovery"],
    ["document", "document"],
  ]);
  for (const part of input.raw) {
    expect(part.provenance.sha256).toBe(sha256Hex(part.bytes));
  }
});

test("a listed PDF refuses forged receipts and non-PDF responses", async () => {
  const known = await publisher();
  const { entries } = walked;
  const entry = documentEntry(
    documents(entries).find((candidate) => candidate.url === METHODOLOGY_PDF),
  );
  const captured = entry.sourceRaw?.at(0) ?? panic("Missing captured listing");
  for (const forged of [
    { ...entry, sourceRaw: [] },
    { ...entry, sourceRaw: [{ ...captured, contentBase64: "AAAA" }] },
    {
      ...entry,
      url: `${ORIGIN}/documents/20142/43684/jiny.pdf/00000000-0000-0000-0000-000000000000`,
    },
  ] as const satisfies readonly SoftLawEntry[]) {
    const result = await suipAdapter.fetchDocument(forged, {
      signal: signal(),
      fetch: known.fetch,
    });
    expect(result.isErr() && SoftLawItemError.is(result.error)).toBeTrue();
  }
  const notPdf = await suipAdapter.fetchDocument(entry, {
    signal: signal(),
    fetch: transport(() => ({
      bytes: new TextEncoder().encode("<html></html>"),
      contentType: "application/pdf",
    })).fetch,
  });
  expect(notPdf.isErr() && SoftLawItemError.is(notPdf.error)).toBeTrue();
});

test("a case study keeps its publisher id, date and body", async () => {
  const known = await publisher();
  const { entries } = walked;
  const entry = documentEntry(
    documents(entries).find((candidate) => candidate.url === CASE_STUDY_9),
  );
  const input = (
    await suipAdapter.fetchDocument(entry, {
      signal: signal(),
      fetch: known.fetch,
    })
  ).unwrap();
  expect(input.metadata).toMatchObject({
    kind: "other",
    sourceKind: "Kazuistiky",
    sourceDocumentId: "1090295",
    issuedOn: { state: "stated", value: "2025-08-29" },
  });
  expect(input.metadata.title).toStartWith("Kazuistika č. 9");
  expect(input.extractionQuality).toBe("html");
  expect(input.text).toContain("SHRNUTÍ");
  expect(input.sourceDates).toEqual({ publishedOn: "2025-08-29" });
  const raw = input.raw.at(1) ?? panic("Missing document part");
  expect(raw.purpose).toBe("document");
  expect(new TextDecoder().decode(raw.bytes)).not.toContain("<head");
});

test("challenge responses and shell-less pages stop discovery visibly", async () => {
  for (const [body, status] of [
    ['<title>Just a moment...</title><div id="cf-chl"></div>', 503],
    ['<form id="challenge-form"></form>', 200],
    ["Access denied", 403],
    ["Too many requests", 429],
  ] as const) {
    const fetch = createSoftLawFetch({
      policy: suipAdapter.access,
      signal: new AbortController().signal,
      reserve: async () => {},
      request: async () =>
        new Response(body, {
          status,
          headers: { "content-type": "text/html" },
        }),
    });
    const result = await suipAdapter.discover({
      cursor: null,
      signal: signal(),
      fetch,
    });
    expect(result.isErr() && SoftLawBlockedError.is(result.error)).toBeTrue();
    expect(fetch.getBlockReason()).not.toBeNull();
  }
  const { fetch } = transport((url) =>
    url === page("bezpecnost-prace-otazky-a-odpovedi")
      ? html("<html><body><form>Ověřte, že nejste robot</form></body></html>")
      : undefined,
  );
  const result = await suipAdapter.discover({
    cursor: null,
    signal: signal(),
    fetch,
  });
  expect(result.isErr() && SoftLawIngestionError.is(result.error)).toBeTrue();
});

test("SÚIP declares every field its fixtures state and needs no admission file", async () => {
  const fields = new Set<string>();
  for (const name of [
    "suip-qa-zamestnanost.html",
    "suip-case-study.html",
    "suip-methodology.html",
  ] as const) {
    for (const field of suipAdapter.sourceFields.listSourceFields({
      page: await fixtureText(name),
    })) {
      fields.add(field);
    }
  }
  expect([...fields].toSorted()).toEqual(
    Object.keys(suipAdapter.sourceFields.fields).toSorted(),
  );
  expect(
    (
      await configureSoftLawAdapter(SOFT_LAW_ADMISSIONS["cz-suip"].adapter, {
        type: "default",
      })
    ).unwrap(),
  ).toBe(SOFT_LAW_ADMISSIONS["cz-suip"].adapter);
});
