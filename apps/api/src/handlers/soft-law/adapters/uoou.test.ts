import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { load } from "cheerio";
import JSZip from "jszip";
import { gunzipSync } from "node:zlib";
import * as v from "valibot";

import type { SourceFieldDisposition } from "@/api/lib/legal-search/ingestion-types";
import type {
  SoftLawFetch,
  SoftLawFetchOptions,
  SoftLawResponse,
} from "@/api/lib/legal-search/soft-law-access-types";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";
import { readSourceRawField } from "@/api/lib/legal-search/source-raw-field";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { isCapturedFixture, sha256Of } from "@/api/tests/fixture-provenance";

import { SOFT_LAW_ADAPTERS } from "./registry";
import { uoouAdapter } from "./uoou";
import { classifyUoouUrl, parseUoouPage, UOOU_ORIGIN } from "./uoou-pages";

const FIXTURES = {
  index: "uoou-index.xml.gz",
  sitemap: "uoou-cs.xml.gz",
  recommendation: "uoou-recommendation.html.gz",
  methodology: "uoou-methodology.html.gz",
  faq: "uoou-faq.html.gz",
  thematic: "uoou-thematic.html.gz",
  pdf: "uoou-recommendation.pdf",
} as const;
const PAGE_FIXTURES = [
  "recommendation",
  "methodology",
  "faq",
  "thematic",
] as const;
const REGISTRY_FIXTURES = {
  "cz-uoou": PAGE_FIXTURES,
} as const satisfies Record<
  keyof typeof SOFT_LAW_ADAPTERS,
  readonly (typeof PAGE_FIXTURES)[number][]
>;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
type SurfaceMap = typeof uoouAdapter.sourceSurfaces.surfaces;
type StoredSurface = {
  [Key in keyof SurfaceMap]: SurfaceMap[Key]["disposition"] extends "stored"
    ? Key
    : never;
}[keyof SurfaceMap];
const SURFACE_EVIDENCE = {
  html: { scenario: "recorded_pdf", contentType: "text/html" },
  pdf: { scenario: "recorded_pdf", contentType: "application/pdf" },
  docx: { scenario: "generated_docx", contentType: DOCX_MIME_TYPE },
} as const satisfies Record<
  StoredSurface,
  { scenario: "recorded_pdf" | "generated_docx"; contentType: string }
>;
const provenanceSchema = v.object({
  capture: v.literal("recorded"),
  sourceUrl: v.pipe(v.string(), v.url()),
  capturedAt: v.pipe(v.string(), v.isoTimestamp()),
  contentType: v.pipe(v.string(), v.minLength(1)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

const readFixture = async (key: keyof typeof FIXTURES) => {
  const name = FIXTURES[key];
  const file = new URL(`__fixtures__/${name}`, import.meta.url);
  const compressed = await Bun.file(file).bytes();
  const bytes = name.endsWith(".gz")
    ? new Uint8Array(gunzipSync(compressed))
    : compressed;
  const provenance = v.parse(
    provenanceSchema,
    await Bun.file(`${file.pathname}.provenance.json`).json(),
  );
  expect(sha256Of(bytes)).toBe(provenance.sha256);
  return {
    bytes,
    contentType: provenance.contentType,
    url: provenance.sourceUrl,
  };
};
const textOf = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const failure = (result: Result<unknown, unknown>) => {
  if (result.status !== "error") {
    panic("Expected a typed source failure");
  }
  return result.error;
};

const fakeFetch = (responses: ReadonlyMap<string, SoftLawResponse>) => {
  const calls: { url: string; options: SoftLawFetchOptions }[] = [];
  const fetch = Object.assign(
    async (url: string, options: SoftLawFetchOptions) => {
      calls.push({ url, options });
      const response = responses.get(url);
      if (!response) {
        panic(`Unrecorded fixture request: ${url}`);
      }
      return Result.ok(response);
    },
    {
      getBlockReason: (): null => null,
      getWindowState: (): "open" => "open",
      getLeaseState: (): "active" => "active",
    },
  ) satisfies SoftLawFetch;
  return { fetch, calls };
};

type AssertSurfaceEvidenceOptions = {
  raw: readonly { role: string; contentType: string }[];
  scenario: "recorded_pdf" | "generated_docx";
};
const assertSurfaceEvidence = ({
  raw,
  scenario,
}: AssertSurfaceEvidenceOptions) => {
  const surfaces = new Map(Object.entries(uoouAdapter.sourceSurfaces.surfaces));
  expect(
    [...surfaces]
      .filter(([, surface]) => surface.disposition === "stored")
      .map(([key]) => key)
      .toSorted(),
  ).toEqual(Object.keys(SURFACE_EVIDENCE).toSorted());
  for (const [key, evidence] of Object.entries(SURFACE_EVIDENCE)) {
    if (evidence.scenario !== scenario) {
      continue;
    }
    const surface = surfaces.get(key);
    if (surface?.disposition !== "stored") {
      panic(`Stored surface coverage drift: ${key}`);
    }
    const prefix = surface.part.replace("<url>", "");
    expect(
      raw.some(
        (part) =>
          part.role.startsWith(prefix) &&
          part.contentType.split(";").at(0) === evidence.contentType,
      ),
    ).toBe(true);
  }
  if (scenario === "generated_docx") {
    expect(
      raw.some(
        (part) => part.role === "page" && part.contentType === "text/html",
      ),
    ).toBe(true);
  }
};

type GeneratedPageOptions = {
  title?: string;
  body?: string;
  jsonLd?: string;
  downloads?: string;
};
const generatedPage = ({
  title = "Metodika",
  body = "Pokyny správce.",
  jsonLd,
  downloads = "",
}: GeneratedPageOptions = {}) =>
  `<h1>${title}</h1><div class="_cms-content">${body}</div><div class="u-l-documents">${downloads}</div>${jsonLd === undefined ? "" : `<script type="application/ld+json">${jsonLd}</script>`}`;
const METHODOLOGY_URL = `${UOOU_ORIGIN}/profesional/metodiky-a-doporuceni-pro-spravce/metodika-test`;

type AssertStoredFieldOptions = {
  disposition: SourceFieldDisposition;
  html: string;
  parsed: ReturnType<ReturnType<typeof parseUoouPage>["unwrap"]>;
};
const assertStoredField = ({
  disposition,
  html,
  parsed,
}: AssertStoredFieldOptions) => {
  if (disposition.disposition === "excluded") {
    expect(disposition.reason.trim()).not.toBe("");
    return;
  }
  const target = disposition.target;
  switch (target.type) {
    case "rawText":
      expect(readSourceRawField({ page: html }, target)).toBe(html);
      expect(target.reason.trim()).not.toBe("");
      return;
    case "metadata":
      expect(
        new Map(Object.entries(parsed.metadata)).get(target.key),
      ).toBeTruthy();
      return;
    case "document":
      expect(parsed.text.trim()).not.toBe("");
      return;
    case "raw":
    case "textField":
    case "result":
    case "identity":
      panic(`Unsupported soft-law field target: ${target.type}`);
      break;
    default:
      target satisfies never;
  }
};

describe("UOOÚ recorded publisher pages", () => {
  test("all captures have recorded provenance and hashes of the verbatim response", async () => {
    const root = new URL("__fixtures__/", import.meta.url).pathname;
    const files = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: root }));
    expect(files.filter(isCapturedFixture).toSorted()).toEqual(
      Object.values(FIXTURES).toSorted(),
    );
    for (const key of ["index", "sitemap", ...PAGE_FIXTURES, "pdf"] as const) {
      await readFixture(key);
    }
  });

  test("recommendation reads its number and issue date from the body, retaining CMS dates separately", async () => {
    const fixture = await readFixture("recommendation");
    const parsed = parseUoouPage(textOf(fixture.bytes), fixture.url).unwrap();
    expect(parsed.metadata).toEqual({
      title: "Doporučení ÚOOÚ k postavení pověřenců pro ochranu osobních údajů",
      kind: "recommendation",
      statedReference: { state: "stated", value: "02/2024" },
      issuedOn: { state: "stated", value: "2024-08-01" },
      validity: { state: "not_stated", basis: "source_stated" },
    });
    expect(parsed.sourceDates).toEqual({
      "cms.dateCreated": "2024-08-12T16:32:28+0200",
      "cms.dateModified": "2024-08-12T16:35:36+0200",
      "cms.datePublished": "2024-08-12T16:27:00+0200",
    });
    const pdf = await readFixture("pdf");
    expect(parsed.attachments).toEqual([pdf.url]);
    expect(parsed.text).toContain("02/2024");
    expect(parsed.excluded).toBeNull();
  });

  test("methodology, FAQ and thematic guidance never promote CMS dates to legal issue dates", async () => {
    const kinds = {
      methodology: "methodology",
      faq: "faq",
      thematic: "guideline",
    } as const;
    for (const key of ["methodology", "faq", "thematic"] as const) {
      const fixture = await readFixture(key);
      const parsed = parseUoouPage(textOf(fixture.bytes), fixture.url).unwrap();
      expect(parsed.metadata.kind).toBe(kinds[key]);
      expect(parsed.metadata.issuedOn).toEqual({ state: "not_stated" });
      expect(parsed.metadata.statedReference).toEqual({ state: "not_stated" });
      expect(parsed.metadata.validity).toEqual({
        state: "not_stated",
        basis: "source_stated",
      });
      expect(Object.keys(parsed.sourceDates).toSorted()).toEqual([
        "cms.dateCreated",
        "cms.dateModified",
        "cms.datePublished",
      ]);
      expect(parsed.text.length).toBeGreaterThan(100);
      expect(parsed.excluded).toBeNull();
      if (key !== "methodology") {
        const { fetch } = fakeFetch(new Map([[fixture.url, fixture]]));
        const document = (
          await uoouAdapter.fetchDocument(
            { url: fixture.url, metadata: null, sourceDates: {} },
            {
              fetch,
              signal: new AbortController().signal,
              maxRawBytes: MAX_RAW_BYTES,
            },
          )
        ).unwrap();
        if (document.type !== "document") {
          panic(`Captured guidance was excluded: ${key}`);
        }
        expect(document.raw).toEqual([
          {
            role: "page",
            bytes: fixture.bytes,
            contentType: fixture.contentType,
          },
        ]);
        expect(document.text).toBe(parsed.text);
        expect(document.extractionQuality).toBe("html");
      }
    }
  });

  test("FAQ retains the displayed question before its hidden answer without accordion controls", async () => {
    const fixture = await readFixture("faq");
    const parsed = parseUoouPage(textOf(fixture.bytes), fixture.url).unwrap();
    expect(parsed.text).toMatch(
      /Je třeba kamerový systém registrovat u ÚOOÚ\?\s*NE\. Dnem 25\. května 2018/u,
    );
    expect(parsed.text).not.toMatch(/Zobrazit|Skrýt/u);
  });

  test("registry field inventories exactly cover fields actually served by every captured page", async () => {
    expect(Object.keys(REGISTRY_FIXTURES).toSorted()).toEqual(
      Object.keys(SOFT_LAW_ADAPTERS).toSorted(),
    );
    for (const [key, fixtures] of Object.entries(REGISTRY_FIXTURES)) {
      const adapter = new Map(Object.entries(SOFT_LAW_ADAPTERS)).get(key);
      if (!adapter) {
        panic(`Adapter coverage drift: ${key}`);
      }
      const observed = new Set<string>();
      const declared = new Map<string, SourceFieldDisposition>(
        Object.entries(adapter.sourceFields.fields),
      );
      for (const fixtureKey of fixtures) {
        const fixture = await readFixture(fixtureKey);
        const html = textOf(fixture.bytes);
        const parsed = parseUoouPage(html, fixture.url).unwrap();
        for (const field of adapter.sourceFields.listSourceFields({
          page: html,
        })) {
          observed.add(field);
          const disposition = declared.get(field);
          if (!disposition) {
            panic(`Undeclared publisher field: ${field}`);
          }
          assertStoredField({ disposition, html, parsed });
        }
      }
      expect([...observed].toSorted()).toEqual([...declared.keys()].toSorted());
    }
  });

  test("adapter preserves the original HTML and PDF bytes and supplies the attachment MIME contract", async () => {
    const page = await readFixture("recommendation");
    const pdf = await readFixture("pdf");
    const { fetch, calls } = fakeFetch(
      new Map([
        [page.url, page],
        [pdf.url, pdf],
      ]),
    );
    const document = (
      await uoouAdapter.fetchDocument(
        {
          url: page.url,
          metadata: null,
          sourceDates: { "sitemap.lastmod": "2024-08-12" },
        },
        {
          fetch,
          signal: new AbortController().signal,
          maxRawBytes: MAX_RAW_BYTES,
        },
      )
    ).unwrap();
    if (document.type !== "document") {
      panic("Recorded recommendation was excluded");
    }
    expect(document.raw).toEqual([
      { role: "page", bytes: page.bytes, contentType: page.contentType },
      {
        role: `attachment:${pdf.url}`,
        bytes: pdf.bytes,
        contentType: pdf.contentType,
      },
    ]);
    expect(document.extractionQuality).toBe("text_layer");
    expect(document.text).toContain("02/2024");
    expect(document.text?.length).toBeGreaterThan(
      parseUoouPage(textOf(page.bytes), page.url).unwrap().text.length,
    );
    expect(document.sourceDates["sitemap.lastmod"]).toBe("2024-08-12");
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
    const surfaces = uoouAdapter.sourceSurfaces.surfaces;
    expect(Object.keys(surfaces).toSorted()).toEqual(
      [
        "html",
        "pdf",
        "docx",
        "sitemap_index",
        "czech_sitemap",
        "edpb_translations",
        "president_decisions",
        "third_party_publications",
      ].toSorted(),
    );
    for (const surface of Object.values(surfaces)) {
      if (surface.disposition === "excluded") {
        expect(surface.reason.trim()).not.toBe("");
      }
    }
    assertSurfaceEvidence({ raw: document.raw, scenario: "recorded_pdf" });
  });
});

describe("UOOÚ sitemap discovery and exclusion boundaries", () => {
  test("statute citations in an unnumbered recommendation do not supply its reference or issue date", () => {
    const url = `${UOOU_ORIGIN}/profesional/metodiky-a-doporuceni-pro-spravce/doporuceni-test`;
    const parsed = parseUoouPage(
      generatedPage({
        title: "Doporučení ke kamerovým systémům",
        body: "Postup podle zákona č. 110/2019 ze dne 24. dubna 2019.",
      }),
      url,
    ).unwrap();
    expect(parsed.metadata.statedReference).toEqual({ state: "not_stated" });
    expect(parsed.metadata.issuedOn).toEqual({ state: "not_stated" });
  });
  test("recorded sitemap pages replay without duplicates and preserve the publisher lastmod", async () => {
    const index = await readFixture("index");
    const sitemap = await readFixture("sitemap");
    const { fetch, calls } = fakeFetch(
      new Map([
        [index.url, index],
        [sitemap.url, sitemap],
      ]),
    );
    const signal = new AbortController().signal;
    const first = (
      await uoouAdapter.discover({ cursor: null, signal, fetch })
    ).unwrap();
    const entries = [...first.entries];
    let cursor = first.nextCursor;
    for (let page = 1; cursor !== null && page < 20; page += 1) {
      const discovered = (
        await uoouAdapter.discover({ cursor, signal, fetch })
      ).unwrap();
      expect(discovered.entries.length).toBeLessThanOrEqual(100);
      entries.push(...discovered.entries);
      cursor = discovered.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(cursor).toBeNull();
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(
      entries.length,
    );
    expect(entries.map((entry) => entry.url)).toEqual(
      entries.map((entry) => entry.url).toSorted(),
    );
    expect(
      (await uoouAdapter.getTotalCount({ signal, fetch })).unwrap(),
    ).toEqual({
      type: "count",
      total: entries.length,
    });
    const $ = load(textOf(sitemap.bytes), { xml: true });
    const revisions = new Map(
      $("urlset > url")
        .toArray()
        .map((node) => [
          $(node).children("loc").text().trim(),
          $(node).children("lastmod").text().trim(),
        ]),
    );
    for (const entry of entries) {
      expect(revisions.has(entry.url)).toBe(true);
      const lastmod = revisions.get(entry.url);
      expect(entry.sourceDates).toEqual(
        lastmod ? { "sitemap.lastmod": lastmod } : {},
      );
      if (lastmod) {
        expect(entry.cacheKey).toContain(lastmod);
      } else {
        expect(entry.cacheKey).toBeUndefined();
      }
    }
    for (const key of PAGE_FIXTURES) {
      expect(entries.map((entry) => entry.url)).toContain(
        (await readFixture(key)).url,
      );
    }
    expect(
      entries.some((entry) =>
        entry.url.includes("/profesional/qa-otazky-a-odpovedi/"),
      ),
    ).toBe(true);
    expect(
      entries.some((entry) =>
        entry.url.includes("/verejnost/qa-otazky-a-odpovedi/"),
      ),
    ).toBe(true);
    expect(
      entries.some((entry) =>
        /pokyny-sboru-|rozhodnuti-predsedy-uradu/u.test(entry.url),
      ),
    ).toBe(false);
    expect(
      (await uoouAdapter.discover({ cursor: null, signal, fetch })).unwrap()
        .entries,
    ).toEqual(entries.slice(0, 100));
    expect(calls.every((call) => call.options.surface === "page")).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([index.url, sitemap.url]);
  });

  test("listing snapshots belong to one fetch capability and the next run sees revised sitemap data", async () => {
    const index = await readFixture("index");
    const sitemapUrl = `${UOOU_ORIGIN}/sitemap/cs.xml`;
    const sitemap = (revision: string) => ({
      url: sitemapUrl,
      bytes: new TextEncoder().encode(
        `<urlset><url><loc>${METHODOLOGY_URL}</loc><lastmod>${revision}</lastmod></url></urlset>`,
      ),
      contentType: "text/xml",
    });
    const responses = new Map([
      [index.url, index],
      [sitemapUrl, sitemap("2024-01-01")],
    ]);
    const first = fakeFetch(responses);
    const signal = new AbortController().signal;
    const old = (
      await uoouAdapter.discover({
        cursor: null,
        signal,
        fetch: first.fetch,
      })
    ).unwrap();
    responses.set(sitemapUrl, sitemap("2024-02-01"));
    expect(
      (
        await uoouAdapter.discover({ cursor: null, signal, fetch: first.fetch })
      ).unwrap(),
    ).toEqual(old);
    expect(
      (
        await uoouAdapter.getTotalCount({ signal, fetch: first.fetch })
      ).unwrap(),
    ).toEqual({ type: "count", total: 1 });
    expect(first.calls).toHaveLength(2);
    const next = fakeFetch(responses);
    const revised = (
      await uoouAdapter.discover({
        cursor: null,
        signal,
        fetch: next.fetch,
      })
    ).unwrap();
    expect(revised.entries.at(0)?.sourceDates).toEqual({
      "sitemap.lastmod": "2024-02-01",
    });
    expect(revised.entries.at(0)?.cacheKey).not.toBe(
      old.entries.at(0)?.cacheKey,
    );
    expect(next.calls).toHaveLength(2);
  });

  test("invalid and conflicting sitemap revisions fail rather than silently selecting a version", async () => {
    const index = await readFixture("index");
    const signal = new AbortController().signal;
    for (const revisions of [
      ["not-a-date"],
      ["2024-02-30"],
      ["2024-01-01", "2024-02-01"],
    ]) {
      const bytes = new TextEncoder().encode(
        `<urlset>${revisions.map((date) => `<url><loc>${METHODOLOGY_URL}</loc><lastmod>${date}</lastmod></url>`).join("")}</urlset>`,
      );
      const url = `${UOOU_ORIGIN}/sitemap/cs.xml`;
      const { fetch } = fakeFetch(
        new Map([
          [index.url, index],
          [url, { url, bytes, contentType: "text/xml" }],
        ]),
      );
      expect(
        failure(await uoouAdapter.discover({ cursor: null, signal, fetch })),
      ).toBeInstanceOf(SoftLawIngestionError);
    }
  });

  test("multipart bytes cannot exceed the caller's remaining budget", async () => {
    const page = await readFixture("recommendation");
    const pdf = await readFixture("pdf");
    const signal = new AbortController().signal;
    const pageOnly = fakeFetch(new Map([[page.url, page]]));
    expect(
      failure(
        await uoouAdapter.fetchDocument(
          { url: page.url, metadata: null, sourceDates: {} },
          {
            fetch: pageOnly.fetch,
            signal,
            maxRawBytes: page.bytes.byteLength - 1,
          },
        ),
      ),
    ).toMatchObject({
      message: "Guidance exceeds the remaining page byte budget",
    });
    expect(pageOnly.calls).toHaveLength(1);
    const multipart = fakeFetch(
      new Map([
        [page.url, page],
        [pdf.url, pdf],
      ]),
    );
    expect(
      failure(
        await uoouAdapter.fetchDocument(
          { url: page.url, metadata: null, sourceDates: {} },
          {
            fetch: multipart.fetch,
            signal,
            maxRawBytes: page.bytes.byteLength + pdf.bytes.byteLength - 1,
          },
        ),
      ),
    ).toMatchObject({
      message: "Guidance attachments exceed the remaining page byte budget",
    });
    expect(multipart.calls).toHaveLength(2);
  });

  test("foreign, credentialed, translated and third-party surfaces stay outside the guidance slice", () => {
    for (const url of [
      "https://example.test/profesional/metodiky-a-doporuceni-pro-spravce/metodika",
      "https://name@uoou.gov.cz/profesional/metodiky-a-doporuceni-pro-spravce/metodika",
      `${METHODOLOGY_URL}?preview=1`,
      `${METHODOLOGY_URL}#translation`,
      `${UOOU_ORIGIN}/profesional/poverenec-pro-ochranu-osobnich-udaju/pokyny-sboru-k-poverencum`,
      `${UOOU_ORIGIN}/cinnost/ochrana-osobnich-udaju/rozhodnuti-predsedy-uradu`,
      `${UOOU_ORIGIN}/publikace/jine-publikace`,
    ]) {
      expect(classifyUoouUrl(url).type).toBe("excluded");
    }
    for (const audience of ["profesional", "verejnost"]) {
      expect(
        classifyUoouUrl(
          `${UOOU_ORIGIN}/${audience}/qa-otazky-a-odpovedi/kamerove-systemy`,
        ),
      ).toEqual({ type: "guidance", kind: "faq" });
    }
  });

  test("translated publications are terminal exclusions while original guidance may cite EDPB", async () => {
    const bytes = new TextEncoder().encode(
      generatedPage({ title: "Český překlad pokynů EDPB" }),
    );
    const { fetch } = fakeFetch(
      new Map([[METHODOLOGY_URL, { bytes, contentType: "text/html" }]]),
    );
    expect(
      (
        await uoouAdapter.fetchDocument(
          { url: METHODOLOGY_URL, metadata: null, sourceDates: {} },
          {
            fetch,
            signal: new AbortController().signal,
            maxRawBytes: MAX_RAW_BYTES,
          },
        )
      ).unwrap(),
    ).toEqual({ type: "excluded", reason: "edpb_translation" });
    expect(
      parseUoouPage(
        generatedPage({ body: "Úřad doporučuje postup podle pokynů EDPB." }),
        METHODOLOGY_URL,
      ).unwrap().excluded,
    ).toBeNull();
  });

  test("malformed publisher metadata fails explicitly instead of inventing source dates", () => {
    for (const jsonLd of [
      "{",
      "42",
      '{"datePublished":"yesterday"}',
      '{"dateCreated":"2024-02-30T10:00:00+0200"}',
      '{"dateCreated":2024}',
      '[{"dateModified":"2024-01-01T12:00:00+0100"},{"dateModified":"2024-02-01T12:00:00+0100"}]',
    ]) {
      expect(
        failure(parseUoouPage(generatedPage({ jsonLd }), METHODOLOGY_URL)),
      ).toBeInstanceOf(SoftLawIngestionError);
    }
    expect(
      failure(parseUoouPage("<h1>Metodika</h1>", METHODOLOGY_URL)),
    ).toMatchObject({ message: "Publisher title or guidance body is missing" });
    expect(
      failure(parseUoouPage(generatedPage({ body: " " }), METHODOLOGY_URL)),
    ).toMatchObject({ message: "Guidance body is empty" });
  });

  test("foreign and credentialed attachments are never followed, including download-list links", () => {
    const links = [
      "https://elsewhere.test/media/guidance.pdf",
      "https://name@uoou.gov.cz/media/guidance.pdf",
      `${UOOU_ORIGIN}/outside/guidance.pdf`,
      `${UOOU_ORIGIN}/media/guidance.exe`,
      `${UOOU_ORIGIN}/media/guidance.pdf#page=1`,
      "/media/guidance.pdf",
    ];
    const parsed = parseUoouPage(
      generatedPage({
        downloads: links
          .map((href) => `<a href="${href}">Příloha</a>`)
          .join(""),
      }),
      METHODOLOGY_URL,
    ).unwrap();
    expect(parsed.attachments).toEqual([`${UOOU_ORIGIN}/media/guidance.pdf`]);
  });
});

test("generated DOCX traverses the real security scan and extraction path with verbatim raw bytes", async () => {
  // Generated OOXML, not a recorded publisher fixture or a replacement extractor.
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Generated DOCX guidance sentinel</w:t></w:r></w:p></w:body></w:document>',
  );
  const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  const url = `${UOOU_ORIGIN}/media/generated-guidance.docx`;
  const page = {
    bytes: new TextEncoder().encode(
      generatedPage({ downloads: `<a href="${url}">DOCX</a>` }),
    ),
    contentType: "text/html",
  };
  const { fetch, calls } = fakeFetch(
    new Map([
      [METHODOLOGY_URL, page],
      [url, { bytes, contentType: DOCX_MIME_TYPE }],
    ]),
  );
  const document = (
    await uoouAdapter.fetchDocument(
      { url: METHODOLOGY_URL, metadata: null, sourceDates: {} },
      {
        fetch,
        signal: new AbortController().signal,
        maxRawBytes: MAX_RAW_BYTES,
      },
    )
  ).unwrap();
  if (document.type !== "document") {
    panic("Generated DOCX page was excluded");
  }
  expect(
    document.raw.find((part) => part.role === `attachment:${url}`),
  ).toEqual({ role: `attachment:${url}`, bytes, contentType: DOCX_MIME_TYPE });
  expect(calls.at(-1)).toEqual({
    url,
    options: { surface: "attachment", expectedContentTypes: [DOCX_MIME_TYPE] },
  });
  expect(document.extractionQuality).toBe("text_layer");
  expect(document.text).toContain("Generated DOCX guidance sentinel");
  assertSurfaceEvidence({ raw: document.raw, scenario: "generated_docx" });
}, 30_000);
