import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { load } from "cheerio";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { sha256Hex } from "@stll/sha256/bun";

import { SoftLawAccessError } from "@/api/lib/legal-search/soft-law-access-types";
import type { SoftLawFetch } from "@/api/lib/legal-search/soft-law-access-types";
import { softLawIdentityKey } from "@/api/lib/legal-search/soft-law-fingerprint";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";
import type { SoftLawSourceAdapter } from "@/api/lib/legal-search/soft-law-types";

import { edpbAdapter, parseEdpbDocument, parseEdpbListing } from "./edpb";

const ORIGIN = "https://www.edpb.europa.eu";
const CONSENT = `${ORIGIN}/documents/guideline/guidelines-052020-on-consent-under-regulation-2016679_en`;
const FINAL = `${ORIGIN}/documents/guideline/guidelines-32025-on-the-interplay-between-the-dsa-and-the-gdpr_en`;
const DRAFT = `${ORIGIN}/public-consultations/guidelines-32025-on-the-interplay-between-the-dsa-and-the-gdpr_en`;
const fixture = async (name: string) =>
  gunzipSync(
    await readFile(
      new URL(`../__fixtures__/edpb-${name}.html.gz`, import.meta.url),
    ),
  ).toString("utf-8");
const adapter: SoftLawSourceAdapter = edpbAdapter;
const signal = () => new AbortController().signal;

test("EDPB official captures preserve publisher bytes and provenance hashes", async () => {
  for (const name of [
    "consent",
    "draft",
    "final",
    "listing",
    "consultations",
  ]) {
    const html = await fixture(name);
    const provenance: unknown = JSON.parse(
      await readFile(
        new URL(
          `../__fixtures__/edpb-${name}.html.gz.provenance.json`,
          import.meta.url,
        ),
        "utf-8",
      ),
    );
    expect(provenance).toMatchObject({
      sourceUrl: expect.stringContaining(ORIGIN),
      sha256: sha256Hex(html),
    });
  }
});

test("EDPB language expressions retain distinct publisher locators without summaries", async () => {
  const entries = parseEdpbDocument({
    html: await fixture("consent"),
    url: CONSENT,
  }).unwrap();
  expect(entries).toHaveLength(23);
  expect(new Set(entries.map((entry) => entry.url)).size).toBe(entries.length);
  expect(
    entries.every((entry) => entry.metadata.expression?.type === "identified"),
  ).toBe(true);
  expect(
    entries.some(
      (entry) =>
        entry.metadata.expression?.type === "identified" &&
        entry.metadata.expression.language === "cs",
    ),
  ).toBe(true);
  for (const entry of entries) {
    expect(entry.url).not.toContain("summary");
    expect(entry.metadata).toMatchObject({
      title: "Guidelines 05/2020 on consent under Regulation 2016/679",
      kind: "guideline",
      issuedOn: { state: "stated", value: "2020-05-04" },
      expression: { revision: { state: "not_stated" } },
      stage: { state: "not_stated" },
    });
  }
});

test.each(["Tracked changes", "Track changes", "track-changes version"])(
  "EDPB %s PDFs beside the clean PDF are not instrument expressions",
  async (label) => {
    const html = await fixture("consent");
    const clean = parseEdpbDocument({ html, url: CONSENT }).unwrap();
    const $ = load(html);
    const original = $(
      ".document-full__files .paragraph-documents-file-partial",
    ).first();
    const marked = original.clone();
    const anchor = marked.find(".file__title a").first();
    const href = anchor.attr("href");
    if (!href) {
      panic("Official EDPB fixture has no document href");
    }
    anchor.text(`${anchor.text()} ${label}`);
    anchor.attr("href", href.replace(/\.pdf/u, "_tracked.pdf"));
    marked.find("option[data-url]").remove();
    original.after(marked);

    const entries = parseEdpbDocument({
      html: $.html(),
      url: CONSENT,
    }).unwrap();

    expect(entries.map((entry) => entry.url)).toEqual(
      clean.map((entry) => entry.url),
    );
  },
);

test("EDPB consultation and adopted editions keep independent dates and supersession evidence", async () => {
  const draft = parseEdpbDocument({ html: await fixture("draft"), url: DRAFT })
    .unwrap()
    .at(0);
  const final = parseEdpbDocument({ html: await fixture("final"), url: FINAL })
    .unwrap()
    .at(0);
  expect(draft).toBeDefined();
  expect(final).toBeDefined();
  expect(draft?.metadata).toMatchObject({
    expression: { language: "en", revision: { state: "stated", value: "1" } },
    stage: { state: "consultation" },
    issuedOn: { state: "not_stated" },
    validity: { state: "superseded" },
    relations: [
      {
        type: "superseded_by",
        reference: FINAL,
        evidence: {
          quote: expect.stringContaining("final version of this publication"),
        },
      },
    ],
  });
  expect(draft?.sourceDates).toEqual({
    consultationStart: "2025-09-12",
    consultationEnd: "2025-10-31",
  });
  expect(final?.metadata).toMatchObject({
    expression: { revision: { state: "stated", value: "2" } },
    stage: { state: "adopted", evidence: { quote: "Final version" } },
    relations: [{ type: "supersedes", reference: DRAFT }],
    issuedOn: { state: "stated", value: "2026-09-17" },
    validity: { state: "not_stated" },
  });
  expect(draft?.url).not.toBe(final?.url);
  expect(
    parseEdpbDocument({ html: await fixture("final"), url: FINAL }).unwrap(),
  ).toHaveLength(1);
});

test("EDPB listing excludes binding decisions while consultation pagination remains discoverable", async () => {
  const listing = parseEdpbListing(
    await fixture("listing"),
    `${ORIGIN}/documents_en?page=1`,
  ).unwrap();
  expect(
    listing.documents.some((url) => url.includes("guidelines-022025")),
  ).toBe(true);
  expect(
    listing.documents.every((url) => !url.includes("binding-decision")),
  ).toBe(true);
  expect(listing.next).toBe(`${ORIGIN}/documents_en?page=2`);
  const consultations = parseEdpbListing(
    await fixture("consultations"),
    `${ORIGIN}/public-consultations_en`,
  ).unwrap();
  expect(consultations.documents.length).toBeGreaterThan(0);
  expect(consultations.next).toBe(`${ORIGIN}/public-consultations_en?page=1`);
  // The captured page lists open consultations in their own view beside the
  // closed overview; both are publications of the index.
  expect(consultations.documents).toEqual(
    expect.arrayContaining([
      `${ORIGIN}/public-consultations/guidelines-022026-on-anonymisation_en`,
      `${ORIGIN}/public-consultations/guidelines-12026-on-processing-of-personal-data-for-scientific-research_en`,
    ]),
  );
});

const fakeFetch = (
  responses: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }>,
  requested: string[],
): SoftLawFetch =>
  Object.assign(
    async (url: string) => {
      requested.push(url);
      const response = responses.get(url);
      return response
        ? Result.ok(response)
        : Result.err(
            new SoftLawAccessError({ message: "Fixture response unavailable" }),
          );
    },
    {
      getBlockReason: () => null,
      getWindowState: () => "open" as const,
      getLeaseState: () => "active" as const,
    },
  );

test("EDPB discovery snapshots survive a retry without refetching mutable metadata", async () => {
  const listing = await fixture("listing");
  const detailUrl = parseEdpbListing(listing, `${ORIGIN}/documents_en?page=1`)
    .unwrap()
    .documents.at(0);
  if (!detailUrl) {
    panic("Official EDPB listing fixture has no admitted documents");
  }
  const detail = await fixture("final");
  const requests: string[] = [];
  const responses = new Map([
    [
      `${ORIGIN}/documents_en?page=1`,
      { bytes: Buffer.from(listing), contentType: "text/html" },
    ],
    [detailUrl, { bytes: Buffer.from(detail), contentType: "text/html" }],
  ]);
  const fetch = fakeFetch(responses, requests);
  const discovered = (
    await adapter.discover({
      cursor: "index=0&page=1&item=0",
      signal: signal(),
      fetch,
    })
  ).unwrap();
  const entry = discovered.entries.at(0);
  if (!entry || entry.type !== "document") {
    panic("Official EDPB detail fixture has no expressions");
  }
  const serialized = JSON.stringify(entry);
  const restored: unknown = JSON.parse(serialized);
  expect(restored).toEqual(entry);
  const pdf = gunzipSync(
    await readFile(
      new URL("../__fixtures__/edpb-final.pdf.gz", import.meta.url),
    ),
  );
  responses.set(entry.url, { bytes: pdf, contentType: "application/pdf" });
  requests.length = 0;
  const result = await adapter.fetchDocument(entry, {
    signal: signal(),
    fetch,
  });
  if (result.isErr()) {
    panic(result.error.message);
  }
  expect(requests).toEqual([entry.url]);
  expect(result.value.raw.map((part) => part.role)).toEqual([
    "index",
    "detail",
    "document",
  ]);
  expect(
    Buffer.from(
      result.value.raw.find((part) => part.role === "detail")?.bytes ?? [],
    ).toString(),
  ).toBe(detail);
  expect(result.value.raw.map((part) => part.purpose)).toEqual([
    "discovery",
    "discovery",
    "document",
  ]);
  expect(result.value.text).toContain("Guidelines");
  expect(result.value.extractionQuality).toBe("text_layer");
  const failure = await adapter.fetchDocument(entry, {
    signal: signal(),
    fetch: fakeFetch(new Map(), []),
  });
  expect(failure.isErr()).toBe(true);
  if (failure.isOk()) {
    panic("Missing fixture PDF did not fail");
  }
  expect(failure.error).toBeInstanceOf(SoftLawAccessError);
});

test("EDPB discovery records a malformed detail and advances its cursor", async () => {
  const listing = await fixture("listing");
  const indexUrl = `${ORIGIN}/documents_en?page=1`;
  const detailUrl = parseEdpbListing(listing, indexUrl)
    .unwrap()
    .documents.at(0);
  if (!detailUrl) {
    panic("Official EDPB listing fixture has no admitted documents");
  }
  const malformed = (await fixture("final")).replace(/_en\.pdf/u, "_xxx.pdf");
  const discovered = (
    await adapter.discover({
      cursor: "index=0&page=1&item=0",
      signal: signal(),
      fetch: fakeFetch(
        new Map([
          [indexUrl, { bytes: Buffer.from(listing), contentType: "text/html" }],
          [
            detailUrl,
            { bytes: Buffer.from(malformed), contentType: "text/html" },
          ],
        ]),
        [],
      ),
    })
  ).unwrap();
  expect(discovered.nextCursor).not.toBeNull();
  expect(discovered.entries).toHaveLength(1);
  expect(discovered.entries.at(0)).toEqual({
    type: "rejected",
    url: detailUrl,
    rejection: {
      tag: "invalid_document",
      reason: "EDPB document language is not stated",
    },
    sourceRaw: expect.any(Array),
  });
});

test("EDPB references come only from the instrument's own title phrase", async () => {
  const html = (await fixture("final")).replaceAll(
    "Guidelines 3/2025",
    "Opinion on Regulation 12/2024",
  );
  const entry = parseEdpbDocument({ html, url: FINAL }).unwrap().at(0);
  expect(entry?.metadata.statedReference).toEqual({ state: "not_stated" });
});

test("EDPB rejects unknown taxonomy labels and off-publisher document locators", async () => {
  const taxonomy = parseEdpbListing(
    '<div class="view-documents-overview-documents"><div class="document-card"><div class="document-card__document-type">New source category</div></div></div>',
    `${ORIGIN}/documents_en`,
  );
  expect(taxonomy.isErr()).toBe(true);
  if (taxonomy.isOk()) {
    panic("Unknown taxonomy was admitted");
  }
  expect(taxonomy.error.message).toContain("Unclassified EDPB document kind");
  const html = await fixture("consent");
  const escaped = parseEdpbDocument({
    html: html.replaceAll(
      "/system/files/",
      "https://example.invalid/system/files/",
    ),
    url: CONSENT,
  });
  expect(escaped.isErr()).toBe(true);
  if (escaped.isOk()) {
    panic("Off-publisher locator was admitted");
  }
  expect(escaped.error.message).toContain("publisher boundary");
});

test("EDPB empty HTML shells cannot complete a publication inventory", () => {
  for (const path of ["/documents_en", "/public-consultations_en"]) {
    const result = parseEdpbListing(
      "<html><main>Unavailable</main></html>",
      `${ORIGIN}${path}`,
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      panic("An empty publisher shell was admitted");
    }
    expect(result.error.message).toContain("expected publication index");
  }
});

test("EDPB empty index wrappers fail while explicitly excluded cards remain valid", () => {
  for (const [path, wrapper, card] of [
    ["/documents_en", "view-documents-overview-documents", "document-card"],
    [
      "/public-consultations_en",
      "view-public-consultations-closed-overview",
      "node-public-consultation-card",
    ],
  ]) {
    const empty = parseEdpbListing(
      `<div class="${String(wrapper)}"></div>`,
      `${ORIGIN}${String(path)}`,
    );
    expect(empty.isErr()).toBe(true);
    if (empty.isOk()) {
      panic("An empty publication index wrapper was admitted");
    }
    expect(SoftLawIngestionError.is(empty.error)).toBe(true);
    expect(empty.error.message).toContain("publication cards");
    const excluded = parseEdpbListing(
      `<div class="${String(wrapper)}"><article class="${String(card)}"><h3>Internal rules</h3><span class="document-card__document-type">Rules of procedure</span></article></div>`,
      `${ORIGIN}${String(path)}`,
    );
    expect(excluded.unwrap()).toEqual({ documents: [], next: null });
  }
});

test("EDPB malformed PDFs retain raw bytes with an explicit extraction failure", async () => {
  const html = await fixture("final");
  const entry = parseEdpbDocument({ html, url: FINAL }).unwrap().at(0);
  if (!entry) {
    panic("Official detail has no admitted PDF");
  }
  const pdf = Buffer.from("%PDF-1.7\nmalformed-publisher-response");
  const result = await adapter.fetchDocument(
    {
      ...entry,
      sourceRaw: [
        {
          role: "index",
          contentBase64: Buffer.from(await fixture("listing")).toBase64(),
          contentType: "text/html",
        },
        {
          role: "detail",
          contentBase64: Buffer.from(html).toBase64(),
          contentType: "text/html",
        },
      ],
    },
    {
      signal: signal(),
      fetch: fakeFetch(
        new Map([[entry.url, { bytes: pdf, contentType: "application/pdf" }]]),
        [],
      ),
    },
  );
  if (result.isErr()) {
    panic(result.error.message);
  }
  expect(result.value).toMatchObject({
    text: null,
    extractionQuality: "extraction_failed",
    extractionFailure: "Could not extract publisher PDF text",
  });
  expect(
    Buffer.from(
      result.value.raw.find((part) => part.role === "document")?.bytes ?? [],
    ),
  ).toEqual(pdf);
});

test("EDPB unnumbered statements retain the publisher identity across title changes", async () => {
  const original = await fixture("consent");
  const title = "Guidelines 05/2020 on consent under Regulation 2016/679";
  expect(original).toContain(title);
  const unnumbered = original
    .replaceAll(title, "Statement on data portability")
    .replace(
      /(<div class="document-full__document-type">)\s*Guideline\s*(<\/div>)/u,
      "$1Statement$2",
    );
  const english = parseEdpbDocument({ html: unnumbered, url: CONSENT })
    .unwrap()
    .at(0);
  const translated = parseEdpbDocument({
    html: unnumbered.replaceAll(
      "Statement on data portability",
      "Prohlášení o přenositelnosti údajů",
    ),
    url: CONSENT,
  })
    .unwrap()
    .at(0);
  if (!english || !translated) {
    panic("Official EDPB identity fixture lacks an expression");
  }
  expect(english.metadata).toMatchObject({
    sourceDocumentId: "documents/215",
    kind: "statement",
    statedReference: { state: "not_stated" },
  });
  expect(english.metadata.title).not.toBe(translated.metadata.title);
  expect(softLawIdentityKey("eu-edpb", english.metadata).unwrap()).toBe(
    softLawIdentityKey("eu-edpb", translated.metadata).unwrap(),
  );
});
