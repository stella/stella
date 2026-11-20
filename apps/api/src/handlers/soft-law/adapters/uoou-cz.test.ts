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
import {
  hasDamagedPdfTextLayer,
  parseUoouPage,
  parseUoouSitemap,
  uoouCzAdapter,
} from "./uoou-cz";

const ORIGIN = "https://uoou.gov.cz";
const SITEMAP = `${ORIGIN}/sitemap/cs.xml`;
const DECISIONS = `${ORIGIN}/cinnost/ochrana-osobnich-udaju/rozhodnuti-predsedy-uradu`;
const DECISIONS_2022 = `${DECISIONS}/rozhodnuti-predsedy-uradu-v-roce-2022`;
const DECISION_PDF = `${ORIGIN}/media/rozhodnuti/rozhodnuti-predsedy/2022/uoou-0398820-54.pdf`;
const INSPECTIONS = `${ORIGIN}/cinnost/ochrana-osobnich-udaju/ukoncene-kontroly`;
const GUIDANCE = `${ORIGIN}/profesional/metodiky-a-doporuceni-pro-spravce`;
const GUIDANCE_PAGE = `${GUIDANCE}/doporuceni-uoou-c-022024-k-postaveni-poverencu-pro-ochranu-osobnich-udaju`;
const GUIDANCE_PDF = `${ORIGIN}/media/publikace/dokumnety/doporuceni-uoou-02-2024-z-1-8-2024.pdf`;
const QA_PROFESSIONAL = `${ORIGIN}/profesional/qa-otazky-a-odpovedi`;
const QA_PUBLIC = `${ORIGIN}/verejnost/qa-otazky-a-odpovedi`;
const QA_PAGE = `${QA_PROFESSIONAL}/politicka-reklama`;
const INSPECTION_REPORT = `${INSPECTIONS}/kontroly-za-rok-2021/kontrolni-cinnost-v-oblasti-ochrany-osobnich-udaju-2021/pojistovna-uoou-0474820`;
const SECTION_PAGE = `${INSPECTIONS}/kontroly-za-rok-2025`;
/** Guidance 10, professional Q&A 25, public Q&A 19, inspections 822, cross-linked 2. */
const WALKED_PAGE_COUNT = 878;
const FIXTURES = [
  "uoou-cz-sitemap.xml",
  "uoou-cz-decisions-root.html",
  "uoou-cz-decisions-2022.html",
  "uoou-cz-decision.pdf",
  "uoou-cz-guidance-root.html",
  "uoou-cz-guidance-page.html",
  "uoou-cz-guidance.pdf",
  "uoou-cz-qa-root.html",
  "uoou-cz-qa-public-root.html",
  "uoou-cz-qa-page.html",
  "uoou-cz-inspections-root.html",
  "uoou-cz-inspection-section.html",
  "uoou-cz-inspection-report.html",
] as const;
type FixtureName = (typeof FIXTURES)[number];

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
  contentType: "text/html; charset=UTF-8",
});
const publisher = async (overrides: Record<string, FixtureResponse> = {}) => {
  const responses = new Map<string, FixtureResponse>([
    [
      SITEMAP,
      {
        bytes: await fixture("uoou-cz-sitemap.xml"),
        contentType: "text/xml; charset=UTF-8",
      },
    ],
    [DECISIONS, html(await fixture("uoou-cz-decisions-root.html"))],
    [DECISIONS_2022, html(await fixture("uoou-cz-decisions-2022.html"))],
    [
      DECISION_PDF,
      {
        bytes: await fixture("uoou-cz-decision.pdf"),
        contentType: "application/pdf",
      },
    ],
    [GUIDANCE, html(await fixture("uoou-cz-guidance-root.html"))],
    [GUIDANCE_PAGE, html(await fixture("uoou-cz-guidance-page.html"))],
    [
      GUIDANCE_PDF,
      {
        bytes: await fixture("uoou-cz-guidance.pdf"),
        contentType: "application/pdf",
      },
    ],
    [QA_PROFESSIONAL, html(await fixture("uoou-cz-qa-root.html"))],
    [QA_PUBLIC, html(await fixture("uoou-cz-qa-public-root.html"))],
    [QA_PAGE, html(await fixture("uoou-cz-qa-page.html"))],
    [INSPECTIONS, html(await fixture("uoou-cz-inspections-root.html"))],
    [SECTION_PAGE, html(await fixture("uoou-cz-inspection-section.html"))],
    [INSPECTION_REPORT, html(await fixture("uoou-cz-inspection-report.html"))],
    ...Object.entries(overrides),
  ]);
  return transport((url) => responses.get(url));
};
type Publisher = Awaited<ReturnType<typeof publisher>>;
const decisionsYearUrls = async () =>
  parseUoouPage(await fixtureText("uoou-cz-decisions-root.html"))
    .unwrap()
    .cards.map((card) => card.url);
/** Every year section of the root answers with the 2022 fixture. */
const yearsPublisher = async () => {
  const rootCards = await decisionsYearUrls();
  const root = await fixture("uoou-cz-decisions-root.html");
  const year = await fixture("uoou-cz-decisions-2022.html");
  return {
    rootCards,
    ...transport((url) => {
      if (url === DECISIONS) {
        return html(root);
      }
      return rootCards.includes(url) ? html(year) : undefined;
    }),
  };
};
const yearCursor = (index: number, digest: string) =>
  `decisions:${index}:${digest}`;
const cardsDigest = (urls: readonly string[]) =>
  sha256Hex(JSON.stringify(urls));
const documentEntry = (entry: SoftLawDiscoveryEntry | undefined) => {
  if (entry?.type !== "document") {
    return panic("Expected a document entry");
  }
  return entry;
};
const decisions2022Page = async (fetch: SoftLawFetch) => {
  const rootCards = await decisionsYearUrls();
  return (
    await uoouCzAdapter.discover({
      cursor: yearCursor(
        rootCards.indexOf(DECISIONS_2022),
        cardsDigest(rootCards),
      ),
      signal: signal(),
      fetch,
    })
  ).unwrap();
};
const firstDecision = async ({ fetch }: Pick<Publisher, "fetch">) =>
  documentEntry(
    (await decisions2022Page(fetch)).entries.find(
      (entry) => entry.url === DECISION_PDF,
    ),
  );
type DiscoverResult = Awaited<ReturnType<typeof uoouCzAdapter.discover>>;
const discoverAllPagesWithCursors = async (fetch: SoftLawFetch) => {
  const entries: SoftLawDiscoveryEntry[] = [];
  const cursors: (string | null)[] = [];
  let cursor: string | null = `pages:0:${"0".repeat(64)}`;
  do {
    const result: DiscoverResult = await uoouCzAdapter.discover({
      cursor,
      signal: signal(),
      fetch,
    });
    const page = result.unwrap();
    entries.push(...page.entries);
    cursor = page.nextCursor;
    cursors.push(cursor);
  } while (cursor !== null);
  return { entries, cursors };
};
/** One walk parses the sitemap eighteen times; the tests share its result. */
let walkedPages: Awaited<ReturnType<typeof discoverAllPagesWithCursors>>;
// timeout: parses the 867 kB sitemap once per discovery page, on a loaded runner.
beforeAll(async () => {
  walkedPages = await discoverAllPagesWithCursors((await publisher()).fetch);
}, 120_000);
const pageEntry = (url: string) =>
  documentEntry(walkedPages.entries.find((entry) => entry.url === url));

test("ÚOOÚ fixtures preserve publisher response bytes and capture provenance", async () => {
  for (const name of FIXTURES) {
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

test("the decisions year page keeps each row's čj. but refuses a repeated label as a reference", async () => {
  const page = parseUoouPage(
    await fixtureText("uoou-cz-decisions-2022.html"),
  ).unwrap();
  expect(page.title).toBe("Rozhodnutí předsedy úřadu v roce 2022");
  expect(page.documents.map((row) => row.label)).toEqual([
    "UOOU-04856/21-13",
    "UOOU-03988/20-54",
    "UOOU-03988/20-54",
  ]);
  const decision = await firstDecision(await publisher());
  expect(decision.metadata).toMatchObject({
    title: "Rozhodnutí předsedy úřadu UOOU-03988/20-54",
    kind: "other",
    sourceKind: "Rozhodnutí předsedy úřadu",
    statedReference: { state: "not_stated" },
    sourceDocumentId:
      "/media/rozhodnuti/rozhodnuti-predsedy/2022/uoou-0398820-54.pdf",
  });
  expect(decision.sourceDates).toEqual({ listingYear: "2022" });
});

test("ÚOOÚ decisions identity stays unique when two rows share a label", async () => {
  const page = await decisions2022Page((await publisher()).fetch);
  const identities = page.entries.map((entry) =>
    softLawIdentityKey("cz-uoou", documentEntry(entry).metadata).unwrap(),
  );
  expect(new Set(identities).size).toBe(3);
});

test("ÚOOÚ discovery walks every year section, then hands over to the sitemap", async () => {
  const { rootCards, fetch } = await yearsPublisher();
  const digest = cardsDigest(rootCards);
  const entries: SoftLawDiscoveryEntry[] = [];
  const cursors: (string | null)[] = [];
  let cursor: string | null = null;
  for (const _card of rootCards) {
    const result: DiscoverResult = await uoouCzAdapter.discover({
      cursor,
      signal: signal(),
      fetch,
    });
    const page = result.unwrap();
    entries.push(...page.entries);
    cursor = page.nextCursor;
    cursors.push(cursor);
  }
  expect(cursors).toEqual([
    ...rootCards.slice(1).map((_, index) => yearCursor(index + 1, digest)),
    `pages:0:${"0".repeat(64)}`,
  ]);
  expect(entries).toHaveLength(rootCards.length * 3);
});

test("ÚOOÚ sitemap discovery pages every walked collection in bounded batches", () => {
  const { entries, cursors } = walkedPages;
  expect(entries.filter((entry) => entry.type === "document")).toHaveLength(
    WALKED_PAGE_COUNT,
  );
  expect(cursors.at(0)).toMatch(/^pages:50:[0-9a-f]{64}$/u);
  expect(cursors.at(-1)).toBeNull();
  const urls = entries.map((entry) => entry.url);
  expect(new Set(urls).size).toBe(urls.length);
  expect(urls).toContain(GUIDANCE_PAGE);
  expect(urls).toContain(
    `${ORIGIN}/vyjadreni-uradu-k-otazce-zverejnovani-osobnich-udaju-ucastniku-soudnich-jednani`,
  );
});

test("a third-party guidance card is rejected visibly and an unknown or unlisted card stops the walk", async () => {
  expect(
    walkedPages.entries
      .filter((entry) => entry.type === "rejected")
      .map((entry) => entry.url),
  ).toEqual([`${ORIGIN}/publikace-fra-o-legislative-pro-ochranu-dat-v-evrope`]);
  const appendCard = async (href: string) => {
    const $ = load(await fixtureText("uoou-cz-guidance-root.html"));
    $("main#mainblock").append(
      `<a class="u-sections-card" href="${href}"><h3 class="u-sections-card__title">Nová</h3></a>`,
    );
    return (await publisher({ [GUIDANCE]: html($.html()) })).fetch;
  };
  for (const href of [
    `${ORIGIN}/novinky/vse/neznama-stranka`,
    `${GUIDANCE}/nova-metodika-mimo-sitemapu`,
  ]) {
    const result = await uoouCzAdapter.discover({
      cursor: `pages:0:${"0".repeat(64)}`,
      signal: signal(),
      fetch: await appendCard(href),
    });
    expect(result.isErr() && SoftLawIngestionError.is(result.error)).toBeTrue();
  }
});

test("a thin or malformed sitemap fails the walk instead of shrinking it", async () => {
  expect(
    parseUoouSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/a</loc></url></urlset>`,
    ).isErr(),
  ).toBeTrue();
  expect(parseUoouSitemap("<html></html>").isErr()).toBeTrue();
  const sitemap = await fixtureText("uoou-cz-sitemap.xml");
  expect(parseUoouSitemap(sitemap).unwrap().length).toBeGreaterThan(2000);
});

test("a malformed cursor is refused before any request", async () => {
  const { fetch, calls } = await publisher();
  for (const cursor of [
    "1",
    "decisions:1",
    `decisions:x:${"0".repeat(64)}`,
    `other:1:${"0".repeat(64)}`,
    `pages:01:${"0".repeat(64)}`,
    "pages:1:abc",
  ]) {
    const result = await uoouCzAdapter.discover({
      cursor,
      signal: signal(),
      fetch,
    });
    expect(result.isErr() && SoftLawIngestionError.is(result.error)).toBeTrue();
  }
  expect(calls).toEqual([]);
});

test("a changed section list restarts the decisions walk instead of skipping years", async () => {
  const { rootCards, fetch, calls } = await yearsPublisher();
  const result = await uoouCzAdapter.discover({
    cursor: `decisions:3:${"a".repeat(64)}`,
    signal: signal(),
    fetch,
  });
  expect(result.unwrap().nextCursor).toBe(
    yearCursor(1, cardsDigest(rootCards)),
  );
  expect(calls).toEqual([DECISIONS, ...rootCards.slice(0, 1)]);
});

test("a recommendation keeps its number, date and attachment; repeated fetches hash the same", async () => {
  const known = await publisher();
  const entry = pageEntry(GUIDANCE_PAGE);
  const first = (
    await uoouCzAdapter.fetchDocument(entry, {
      signal: signal(),
      fetch: known.fetch,
    })
  ).unwrap();
  expect(first.metadata).toMatchObject({
    title: "Doporučení ÚOOÚ k postavení pověřenců pro ochranu osobních údajů",
    kind: "recommendation",
    statedReference: { state: "stated", value: "02/2024" },
    issuedOn: { state: "stated", value: "2024-08-01" },
  });
  expect(first.extractionQuality).toBe("text_layer");
  expect(first.text).toContain("pověřenc");
  expect(first.raw.map((part) => [part.role, part.purpose])).toEqual([
    ["page", "discovery"],
    ["document", "document"],
    ["attachment-0", "document"],
  ]);
  for (const part of first.raw) {
    expect(part.provenance?.sha256).toBe(sha256Hex(part.bytes));
  }
  expect(softLawIdentityKey("cz-uoou", first.metadata).unwrap()).toContain(
    "02/2024",
  );
  const replay = (
    await uoouCzAdapter.fetchDocument(entry, {
      signal: signal(),
      fetch: known.fetch,
    })
  ).unwrap();
  expect(softLawContentHash(replay)).toBe(softLawContentHash(first));
});

test("the per-response form token does not register as a content change", async () => {
  const entry = pageEntry(GUIDANCE_PAGE);
  const page = await fixtureText("uoou-cz-guidance-page.html");
  expect(page).toMatch(/name="_token"\s+value="/u);
  const rotated = page.replace(
    /(name="_token"\s+value=")[^"]+/u,
    (_, prefix: string) => `${prefix}${"r".repeat(40)}`,
  );
  expect(rotated).not.toBe(page);
  const hashOf = async (body: string) =>
    softLawContentHash(
      (
        await uoouCzAdapter.fetchDocument(entry, {
          signal: signal(),
          fetch: (await publisher({ [GUIDANCE_PAGE]: html(body) })).fetch,
        })
      ).unwrap(),
    );
  expect(await hashOf(rotated)).toBe(await hashOf(page));
});

test("a changed answer does register as a content change", async () => {
  const entry = pageEntry(QA_PAGE);
  const original = await fixtureText("uoou-cz-qa-page.html");
  const edited = original.replace(
    "Transparentnost a cílení politické reklamy",
    "Transparentnost a cílení politické reklamy (upraveno)",
  );
  expect(edited).not.toBe(original);
  const hash = async (body: string) =>
    softLawContentHash(
      (
        await uoouCzAdapter.fetchDocument(entry, {
          signal: signal(),
          fetch: transport((url) => (url === QA_PAGE ? html(body) : undefined))
            .fetch,
        })
      ).unwrap(),
    );
  expect(await hash(original)).toBe(await hash(original));
  expect(await hash(edited)).not.toBe(await hash(original));
});

test("an anonymised inspection report keeps its case number and no sitemap timestamp", async () => {
  const known = await publisher();
  const entry = pageEntry(INSPECTION_REPORT);
  expect(entry.sourceDates).toMatchObject({
    sitemapLastmod: expect.any(String),
  });
  const input = (
    await uoouCzAdapter.fetchDocument(entry, {
      signal: signal(),
      fetch: known.fetch,
    })
  ).unwrap();
  expect(input.metadata).toMatchObject({
    title: "Pojišťovna (UOOU-04748/20)",
    kind: "inspection_report",
    statedReference: { state: "stated", value: "UOOU-04748/20" },
  });
  expect(input.extractionQuality).toBe("html");
  expect(input.text).toContain("čl. 32 odst. 2");
  expect(input.sourceDates).toEqual({ inspectionYear: "2021" });
});

test("a Q&A category page is one FAQ document with paragraph structure", async () => {
  const known = await publisher();
  const input = (
    await uoouCzAdapter.fetchDocument(pageEntry(QA_PAGE), {
      signal: signal(),
      fetch: known.fetch,
    })
  ).unwrap();
  expect(input.metadata).toMatchObject({
    title: "Politická reklama",
    kind: "faq",
    sourceKind: "Q&A (otázky a odpovědi)",
  });
  expect(input.text).toContain("\n\n");
});

test("a section page with no document is a visible rejection, not a silent skip", async () => {
  const known = await publisher();
  const entry = pageEntry(SECTION_PAGE);
  const result = await uoouCzAdapter.fetchDocument(entry, {
    signal: signal(),
    fetch: known.fetch,
  });
  expect(result.isErr() && SoftLawItemError.is(result.error)).toBeTrue();
});

test("a decision PDF keeps its captured index and refuses forged receipts", async () => {
  const known = await publisher();
  const entry = await firstDecision(known);
  const first = (
    await uoouCzAdapter.fetchDocument(entry, {
      signal: signal(),
      fetch: known.fetch,
    })
  ).unwrap();
  expect(first.extractionQuality).toBe("text_layer");
  expect(first.text).toContain("ROZHODNUTÍ");
  // The publisher's anonymisation marker survives extraction verbatim.
  expect(first.text).toContain("XXXXXX");
  expect(first.raw.map((part) => [part.role, part.purpose])).toEqual([
    ["page", "discovery"],
    ["document", "document"],
  ]);
  const captured = entry.sourceRaw?.at(0) ?? panic("Missing captured index");
  const tampered = Buffer.from(
    (await fixtureText("uoou-cz-decisions-2022.html")).replace(
      "UOOU-04856/21-13",
      "UOOU-00000/00-00",
    ),
  ).toString("base64");
  for (const forged of [
    { ...entry, sourceRaw: [] },
    { ...entry, sourceRaw: [{ ...captured, contentBase64: tampered }] },
    { ...entry, url: `${DECISION_PDF.slice(0, -4)}-other.pdf` },
  ] as const satisfies readonly SoftLawEntry[]) {
    const result = await uoouCzAdapter.fetchDocument(forged, {
      signal: signal(),
      fetch: known.fetch,
    });
    expect(result.isErr() && SoftLawItemError.is(result.error)).toBeTrue();
  }
});

test("a decision PDF whose font map turns full stops into slashes is not trusted as text", () => {
  const damaged =
    "podle § 152 odst/ 2 zákona č/ 500/2004 Sb/, správní řád, a zákona č/ 110/2019 Sb/, a zákona č/ 480/2004 Sb/";
  expect(hasDamagedPdfTextLayer(damaged)).toBeTrue();
  expect(
    hasDamagedPdfTextLayer(
      "podle zákona č. 500/2004 Sb., správní řád, a zákona č. 110/2019 Sb., ve spojení s přílohou Sb/1 a Sb/2 a Sb/3 a Sb. a Sb. a Sb.",
    ),
  ).toBeFalse();
});

test("a non-PDF decision response is an item rejection", async () => {
  const known = await publisher();
  const entry = await firstDecision(known);
  const result = await uoouCzAdapter.fetchDocument(entry, {
    signal: signal(),
    fetch: transport((url) =>
      url === DECISION_PDF
        ? {
            bytes: new TextEncoder().encode("<html></html>"),
            contentType: "application/pdf",
          }
        : undefined,
    ).fetch,
  });
  expect(result.isErr() && SoftLawItemError.is(result.error)).toBeTrue();
});

test("the newsletter CAPTCHA on ordinary pages passes the access gate; real challenges stop it", async () => {
  const signalOf = new AbortController().signal;
  const reader = (body: string, status = 200) =>
    createSoftLawFetch({
      policy: uoouCzAdapter.access,
      signal: signalOf,
      reserve: async () => {},
      request: async () =>
        new Response(body, {
          status,
          headers: { "content-type": "text/html; charset=UTF-8" },
        }),
    });
  const ordinary = (
    await reader(await fixtureText("uoou-cz-guidance-page.html"))(GUIDANCE_PAGE)
  ).unwrap();
  expect(new TextDecoder().decode(ordinary.bytes)).toContain("g-recaptcha");
  for (const [body, status] of [
    ['<title>Just a moment...</title><div id="cf-chl"></div>', 503],
    ['<form id="challenge-form"></form>', 200],
    ["Access denied", 403],
    ["Too many requests", 429],
  ] as const) {
    const fetch = reader(body, status);
    const result = await uoouCzAdapter.discover({
      cursor: null,
      signal: signal(),
      fetch,
    });
    expect(result.isErr() && SoftLawBlockedError.is(result.error)).toBeTrue();
    expect(fetch.getBlockReason()).not.toBeNull();
  }
});

test("a 200 response without the publisher shell fails the walk visibly", async () => {
  const { fetch } = transport((url) =>
    url === DECISIONS
      ? html("<html><body><form>Ověřte, že nejste robot</form></body></html>")
      : undefined,
  );
  const result = await uoouCzAdapter.discover({
    cursor: null,
    signal: signal(),
    fetch,
  });
  expect(result.isErr() && SoftLawIngestionError.is(result.error)).toBeTrue();
});

test("ÚOOÚ declares its page fields and needs no admission file", async () => {
  const fields = new Set([
    ...uoouCzAdapter.sourceFields.listSourceFields({
      page: await fixtureText("uoou-cz-guidance-page.html"),
    }),
    ...uoouCzAdapter.sourceFields.listSourceFields({
      page: await fixtureText("uoou-cz-inspection-section.html"),
    }),
  ]);
  expect(Object.keys(uoouCzAdapter.sourceFields.fields).toSorted()).toEqual(
    [...fields].toSorted(),
  );
  expect(
    (
      await configureSoftLawAdapter(SOFT_LAW_ADMISSIONS["cz-uoou"].adapter, {
        type: "default",
      })
    ).unwrap(),
  ).toBe(SOFT_LAW_ADMISSIONS["cz-uoou"].adapter);
});
