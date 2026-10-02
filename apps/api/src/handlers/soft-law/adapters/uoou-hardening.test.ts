import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { load } from "cheerio";
import * as v from "valibot";

import {
  SoftLawAccessError,
  SoftLawBlockedError,
} from "@/api/lib/legal-search/soft-law-access-types";
import type {
  SoftLawFetch,
  SoftLawFetchError,
  SoftLawFetchOptions,
  SoftLawResponse,
} from "@/api/lib/legal-search/soft-law-access-types";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";
import { sha256Of } from "@/api/tests/fixture-provenance";

import { uoouAdapter, UOOU_PARSER_REVISION } from "./uoou";
import { classifyUoouUrl, UOOU_ORIGIN } from "./uoou-pages";

const INDEX_URL = `${UOOU_ORIGIN}/sitemap/index.xml`;
const CS_URL = `${UOOU_ORIGIN}/sitemap/cs.xml`;
const METHOD_URL = `${
  UOOU_ORIGIN
}/profesional/metodiky-a-doporuceni-pro-spravce/generated-guidance`;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
// Independent source contract: root, child, and sibling cases bind discovery eligibility.
const THEMATIC_CONTRACT = [
  "/profesional/poverenec-pro-ochranu-osobnich-udaju",
  "/profesional/posouzeni-vlivu-na-ochranu-osobnich-udaju-dpia",
  "/profesional/predavani-osobnich-udaju-do-tretich-zemi-1",
  "/profesional/hodnoceni-shody-s-gdpr",
  "/profesional/poruseni-zabezpeceni-osobnich-udaju",
] as const;
const PREFIX_CONTRACT = [
  "/profesional/metodiky-a-doporuceni-pro-spravce/",
  "/profesional/qa-otazky-a-odpovedi/",
  "/verejnost/qa-otazky-a-odpovedi/",
] as const;
const CAPTURES = {
  index: "uoou-index.xml.gz",
  sitemap: "uoou-cs.xml.gz",
  recommendation: "uoou-recommendation.html.gz",
  pdf: "uoou-recommendation.pdf",
} as const;
const provenanceSchema = v.object({
  capture: v.literal("recorded"),
  sourceUrl: v.pipe(v.string(), v.url()),
  contentType: v.pipe(v.string(), v.minLength(1)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

const capturedResponse = async (key: keyof typeof CAPTURES) => {
  const name = CAPTURES[key];
  const file = new URL(`__fixtures__/${name}`, import.meta.url);
  const stored = await Bun.file(file).bytes();
  const bytes = name.endsWith(".gz")
    ? new Uint8Array(Bun.gunzipSync(stored))
    : stored;
  const provenance = v.parse(
    provenanceSchema,
    await Bun.file(`${file.pathname}.provenance.json`).json(),
  );
  expect(sha256Of(bytes)).toBe(provenance.sha256);
  return {
    url: provenance.sourceUrl,
    bytes,
    contentType: provenance.contentType,
  };
};
const generatedResponse = (body: string, contentType = "text/xml") => ({
  bytes: new TextEncoder().encode(body),
  contentType,
});

const fakeFetch = (
  responses: ReadonlyMap<string, Result<SoftLawResponse, SoftLawFetchError>>,
) => {
  const calls: { url: string; options: SoftLawFetchOptions }[] = [];
  const fetch = Object.assign(
    async (url: string, options: SoftLawFetchOptions) => {
      calls.push({ url, options });
      const response =
        responses.get(url) ?? panic(`Unregistered fixture request: ${url}`);
      return response;
    },
    {
      getBlockReason: (): null => null,
      getWindowState: (): "open" => "open",
      getLeaseState: (): "active" => "active",
    },
  ) satisfies SoftLawFetch;
  return { fetch, calls };
};

const contractAdmits = (value: string) => {
  const url = new URL(value);
  if (
    url.origin !== UOOU_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  const path = url.pathname.replace(/\/$/u, "");
  if (/\/pokyny-sboru-|\/pokyny-doporuceni-a-stanoviska-sboru-/u.test(path)) {
    return false;
  }
  return (
    PREFIX_CONTRACT.some((prefix) => path.startsWith(prefix)) ||
    THEMATIC_CONTRACT.some(
      (root) => path === root || path.startsWith(`${root}/`),
    )
  );
};
const generatedSitemap = (url: string, lastmod?: string) =>
  generatedResponse(
    `<urlset><url><loc>${url}</loc>${
      lastmod ? `<lastmod>${  lastmod  }</lastmod>` : ""
    }</url></urlset>`,
  );

describe("UOOÚ eligible publisher surfaces form a complete discovery contract", () => {
  test("every thematic root and child is guidance, while prefix-sharing siblings are excluded", () => {
    for (const root of THEMATIC_CONTRACT) {
      for (const path of [root, `${root}/`, `${root}/generated-child`]) {
        expect(classifyUoouUrl(UOOU_ORIGIN + path)).toEqual({
          type: "guidance",
          kind: "guideline",
        });
      }
      expect(classifyUoouUrl(`${UOOU_ORIGIN + root}-unrelated`).type).toBe(
        "excluded",
      );
    }
  });

  test("discovery equals every eligible URL in the recorded Czech sitemap, including DPIA", async () => {
    const index = await capturedResponse("index");
    const sitemap = await capturedResponse("sitemap");
    const xml = load(new TextDecoder().decode(sitemap.bytes), { xml: true });
    const sourceUrls = xml("urlset > url > loc")
      .toArray()
      .map((node) => xml(node).text().trim());
    const dpia = `${
      UOOU_ORIGIN
    }/profesional/posouzeni-vlivu-na-ochranu-osobnich-udaju-dpia`;
    expect(sourceUrls).toContain(dpia);
    const expected = [...new Set(sourceUrls.filter(contractAdmits))].toSorted();
    expect(expected).toContain(dpia);
    const { fetch, calls } = fakeFetch(
      new Map([
        [index.url, Result.ok(index)],
        [sitemap.url, Result.ok(sitemap)],
      ]),
    );
    const signal = new AbortController().signal;
    const first = (
      await uoouAdapter.discover({ cursor: null, signal, fetch })
    ).unwrap();
    const entries = [...first.entries];
    let cursor = first.nextCursor;
    for (let page = 1; cursor !== null && page < 20; page++) {
      const next = (
        await uoouAdapter.discover({ cursor, signal, fetch })
      ).unwrap();
      entries.push(...next.entries);
      cursor = next.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(entries.map((item) => item.url)).toEqual(expected);
    expect(
      (await uoouAdapter.getTotalCount({ signal, fetch })).unwrap(),
    ).toEqual({ type: "count", total: expected.length });
    expect(calls.map((call) => call.url)).toEqual([INDEX_URL, CS_URL]);
  });

  test("the generated revision cache key binds the parser revision separately from publisher lastmod", async () => {
    const lastmod = "2024-08-12T16:35:36+0200";
    const index = await capturedResponse("index");
    const sitemap = generatedSitemap(METHOD_URL, lastmod);
    const { fetch } = fakeFetch(
      new Map([
        [
          INDEX_URL,
          Result.ok({ bytes: index.bytes, contentType: index.contentType }),
        ],
        [CS_URL, Result.ok(sitemap)],
      ]),
    );
    const page = (
      await uoouAdapter.discover({
        cursor: null,
        signal: new AbortController().signal,
        fetch,
      })
    ).unwrap();
    expect(page.entries).toHaveLength(1);
    expect(page.entries.at(0)?.cacheKey).toBe(
      JSON.stringify([UOOU_PARSER_REVISION, lastmod]),
    );
    expect(page.entries.at(0)?.sourceDates).toEqual({
      "sitemap.lastmod": lastmod,
    });
  });

  test("missing Czech membership in the sitemap index fails before any Czech sitemap request", async () => {
    const index = generatedResponse(
      `<sitemapindex><sitemap><loc>${
        UOOU_ORIGIN
      }/sitemap/en.xml</loc></sitemap></sitemapindex>`,
    );
    const { fetch, calls } = fakeFetch(
      new Map([
        [INDEX_URL, Result.ok(index)],
        [CS_URL, Result.ok(generatedSitemap(METHOD_URL, "2024-01-01"))],
      ]),
    );
    const rejected = await uoouAdapter.discover({
      cursor: null,
      signal: new AbortController().signal,
      fetch,
    });
    if (!Result.isError(rejected)) {
      panic("Absent Czech index membership was accepted");
    }
    expect(rejected.error).toBeInstanceOf(SoftLawIngestionError);
    expect(rejected.error).toMatchObject({
      message: "Czech sitemap is absent from the index",
    });
    expect(calls.map((call) => call.url)).toEqual([INDEX_URL]);
  });
});

describe("UOOÚ multipart failures preserve their source semantics", () => {
  test("typed publisher-block and lease-loss attachment failures propagate the identical error", async () => {
    const page = await capturedResponse("recommendation");
    const pdf = await capturedResponse("pdf");
    for (const sentinel of [
      new SoftLawBlockedError({
        message: "Publisher challenge sentinel",
        reason: "challenge",
      }),
      new SoftLawAccessError({ message: "Ingestion lease was lost" }),
    ]) {
      const calls: { url: string; options: SoftLawFetchOptions }[] = [];
      let failed = false;
      const fetch = Object.assign(
        async (url: string, options: SoftLawFetchOptions) => {
          calls.push({ url, options });
          if (url === page.url) {
            return Result.ok(page);
          }
          if (url !== pdf.url) {
            panic(`Unexpected attachment URL: ${url}`);
          }
          failed = true;
          return Result.err(sentinel);
        },
        {
          getBlockReason: () =>
            failed && SoftLawBlockedError.is(sentinel) ? sentinel.reason : null,
          getWindowState: (): "open" => "open",
          getLeaseState: (): "active" | "lost" =>
            failed && SoftLawAccessError.is(sentinel) ? "lost" : "active",
        },
      ) satisfies SoftLawFetch;
      const result = await uoouAdapter.fetchDocument(
        { url: page.url, metadata: null, sourceDates: {} },
        {
          fetch,
          signal: new AbortController().signal,
          maxRawBytes: MAX_RAW_BYTES,
        },
      );
      expect(calls).toEqual([
        { url: page.url, options: { surface: "page" } },
        {
          url: pdf.url,
          options: {
            surface: "attachment",
            expectedContentTypes: ["application/pdf"],
          },
        },
      ]);
      if (!Result.isError(result)) {
        panic(
          "Attachment access failure was swallowed as an extraction outcome",
        );
      }
      expect(result.error).toBe(sentinel);
    }
  });

  test("a generated corrupt-first PDF page keeps failed quality after a valid later PDF and retains all exact raw bytes", async () => {
    const valid = await capturedResponse("pdf");
    const corruptUrl = `${UOOU_ORIGIN}/media/generated-corrupt.pdf`;
    const htmlText = "HTML guidance sentinel.";
    const html = `<h1>Generated methodology</h1><div class="_cms-content"><p>${
      htmlText
    }</p></div><div class="u-l-documents"><a href="${
      corruptUrl
    }">Corrupt generated PDF</a><a href="${
      valid.url
    }">Recorded publisher PDF</a></div>`;
    const page = generatedResponse(html, "text/html");
    const corrupt = {
      bytes: new TextEncoder().encode("%PDF-broken\n"),
      contentType: "application/pdf",
    };
    expect(new TextDecoder().decode(corrupt.bytes.subarray(0, 5))).toBe(
      "%PDF-",
    );
    const { fetch, calls } = fakeFetch(
      new Map([
        [METHOD_URL, Result.ok(page)],
        [corruptUrl, Result.ok(corrupt)],
        [
          valid.url,
          Result.ok({ bytes: valid.bytes, contentType: valid.contentType }),
        ],
      ]),
    );
    const result = await uoouAdapter.fetchDocument(
      { url: METHOD_URL, metadata: null, sourceDates: {} },
      {
        fetch,
        signal: new AbortController().signal,
        maxRawBytes: MAX_RAW_BYTES,
      },
    );
    if (!Result.isOk(result)) {
      panic("Extraction failure discarded the original guidance");
    }
    const document = result.value;
    if (document.type !== "document") {
      panic("Generated original guidance was excluded");
    }
    expect(document.extractionQuality).toBe("extraction_failed");
    expect(document.raw).toEqual([
      { role: "page", bytes: page.bytes, contentType: page.contentType },
      {
        role: `attachment:${corruptUrl}`,
        bytes: corrupt.bytes,
        contentType: corrupt.contentType,
      },
      {
        role: `attachment:${valid.url}`,
        bytes: valid.bytes,
        contentType: valid.contentType,
      },
    ]);
    expect(document.text?.startsWith(`${htmlText}\n\n`)).toBe(true);
    expect(document.text).toMatch(/0?2\s*\/\s*2024/u);
    expect(calls.map((call) => call.url)).toEqual([
      METHOD_URL,
      corruptUrl,
      valid.url,
    ]);
    expect(
      calls.slice(1).every((call) => call.options.surface === "attachment"),
    ).toBe(true);
  });
});
