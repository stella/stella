import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { assertProperty } from "@stll/property-testing";
import { sha256Hex } from "@stll/sha256/bun";

import type { SoftLawFetch } from "@/api/lib/legal-search/soft-law-access-types";
import { SoftLawAccessError } from "@/api/lib/legal-search/soft-law-access-types";
import {
  softLawContentHash,
  softLawIdentityKey,
} from "@/api/lib/legal-search/soft-law-fingerprint";

import {
  createBfdiAdapter,
  loadBfdiAdapter,
  parseBfdiDocument,
  parseBfdiListing,
} from "./bfdi";
import { configureSoftLawAdapter, SOFT_LAW_ADMISSIONS } from "./registry";

const ORIGIN = "https://www.bfdi.bund.de";
const INDEX = `${ORIGIN}/DE/Fachthemen/Datenschutzpraxis/Datenverarbeitung/Datenverarbeitung-node.html`;
const DETAIL = `${ORIGIN}/SharedDocs/Downloads/DE/DokumenteBfDI/Stellungnahmen/2020/Auskunftsersuchen_Besch%C3%A4ftigtendatenschutz.html?nn=340692`;
const ASSET = `${ORIGIN}/SharedDocs/Downloads/DE/DokumenteBfDI/Stellungnahmen/2020/Auskunftsersuchen_Besch%C3%A4ftigtendatenschutz.pdf?__blob=publicationFile&v=5`;
const admitted = {
  url: DETAIL,
  documentUrl: ASSET,
  sourceDocumentId: "340692",
};
const index = { url: INDEX, documents: [admitted] };
const policy = {
  version: 1,
  admissionReference: "fixture-only",
  indexes: [index],
};
const fixture = async (name: string) =>
  gunzipSync(
    await readFile(new URL(`__fixtures__/${name}.gz`, import.meta.url)),
  );
const fixtureText = async (name: string) =>
  (await fixture(name)).toString("utf-8");
const signal = () => AbortSignal.timeout(60_000);
const transport = (
  responses: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }>,
) => {
  const calls: string[] = [];
  const fetch: SoftLawFetch = Object.assign(
    async (url: string) => {
      calls.push(url);
      const response = responses.get(url);
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
const responses = async () =>
  new Map([
    [
      INDEX,
      { bytes: await fixture("bfdi-topical.html"), contentType: "text/html" },
    ],
    [
      DETAIL,
      {
        bytes: await fixture("bfdi-recommendation.html"),
        contentType: "text/html",
      },
    ],
    [
      ASSET,
      {
        bytes: await fixture("bfdi-recommendation.pdf"),
        contentType: "application/pdf",
      },
    ],
  ]);

test("BfDI loading requires an explicit bounded private admission file", async () => {
  expect((await loadBfdiAdapter({ type: "default" })).isErr()).toBe(true);
  expect(
    (
      await configureSoftLawAdapter(SOFT_LAW_ADMISSIONS["de-bfdi"].adapter, {
        type: "default",
      })
    ).isErr(),
  ).toBe(true);
  expect(
    (
      await configureSoftLawAdapter(SOFT_LAW_ADMISSIONS["eu-edpb"].adapter, {
        type: "default",
      })
    ).unwrap(),
  ).toBe(SOFT_LAW_ADMISSIONS["eu-edpb"].adapter);
  const directory = await mkdtemp(path.join(tmpdir(), "bfdi-admission-test-"));
  const admissionPath = path.join(directory, "admission.json");
  try {
    await writeFile(admissionPath, JSON.stringify(policy));
    expect(
      (
        await configureSoftLawAdapter(SOFT_LAW_ADMISSIONS["eu-edpb"].adapter, {
          type: "admission-file",
          path: admissionPath,
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await configureSoftLawAdapter(SOFT_LAW_ADMISSIONS["de-bfdi"].adapter, {
          type: "admission-file",
          path: admissionPath,
        })
      ).unwrap().authority,
    ).toBe("de-bfdi");
    expect(
      (
        await loadBfdiAdapter({ type: "admission-file", path: admissionPath })
      ).isOk(),
    ).toBe(true);
    await writeFile(admissionPath, "x".repeat(1024 * 1024 + 1));
    expect(
      (
        await loadBfdiAdapter({ type: "admission-file", path: admissionPath })
      ).isErr(),
    ).toBe(true);
    await writeFile(admissionPath, "{invalid");
    expect(
      (
        await loadBfdiAdapter({ type: "admission-file", path: admissionPath })
      ).isErr(),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("BfDI fixtures preserve publisher response bytes and capture provenance", async () => {
  for (const name of [
    "bfdi-topical.html",
    "bfdi-recommendation.html",
    "bfdi-recommendation.pdf",
  ]) {
    const bytes = await fixture(name);
    const provenance: unknown = JSON.parse(
      await readFile(
        new URL(`__fixtures__/${name}.gz.provenance.json`, import.meta.url),
        "utf-8",
      ),
    );
    expect(provenance).toMatchObject({
      sha256: sha256Hex(bytes),
      sourceUrl: expect.stringContaining(ORIGIN),
      retrievedAt: expect.any(String),
    });
  }
});

test("BfDI topical discovery keeps recommendations apart from books and third-party material", async () => {
  expect(
    parseBfdiListing(await fixtureText("bfdi-topical.html"), INDEX).unwrap(),
  ).toEqual([DETAIL]);
  const entry = parseBfdiDocument({
    html: await fixtureText("bfdi-recommendation.html"),
    ...admitted,
  }).unwrap();
  expect(entry.metadata).toEqual({
    title:
      "Handlungsempfehlung an öffentliche Stellen des Bundes zu Auskunftsersuchen im Beschäftigtendatenschutz",
    kind: "recommendation",
    sourceKind: "Handlungsempfehlung",
    sourceDocumentId: "gsb:340692",
    statedReference: { state: "not_stated" },
    issuedOn: { state: "stated", value: "2020-06-24" },
    expression: {
      type: "identified",
      language: "de",
      revision: { state: "not_stated" },
    },
    stage: { state: "not_stated" },
    relations: [],
    validity: { state: "not_stated", basis: "source_stated" },
  });
});

test("BfDI refuses incomplete pages, ambiguous assets, changed identity and unsupported pagination", async () => {
  const detail = await fixtureText("bfdi-recommendation.html");
  for (const changed of [
    detail.replace('data-nn="340692-252958"', 'data-nn="340693-252958"'),
    detail.replace('lang="de"', 'lang="en"'),
    detail.replace("24.06.2020", "31.02.2020"),
    detail.replace('rel="canonical"', 'rel="alternate"'),
    detail.replace('class="downloadLink"', 'class="otherLink"'),
    detail.replace(
      '<ul class="links">',
      () =>
        `<ul class="links"><li class="download"><a class="downloadLink" href="${ASSET}">duplicate</a></li>`,
    ),
  ]) {
    expect(parseBfdiDocument({ html: changed, ...admitted }).isErr()).toBe(
      true,
    );
  }
  const html = await fixtureText("bfdi-topical.html");
  expect(
    parseBfdiListing(
      html.replace("</main>", '<a rel="next" href="?page=2">Next</a></main>'),
      INDEX,
    ).isErr(),
  ).toBe(true);
  expect(
    parseBfdiListing("<html><main>unavailable</main></html>", INDEX).isErr(),
  ).toBe(true);
});

test("blob counter changes preserve source identity without inventing an edition", async () => {
  const html = await fixtureText("bfdi-recommendation.html");
  const original = parseBfdiDocument({ html, ...admitted }).unwrap();
  assertProperty(
    "blob counter changes preserve source identity without inventing an edition",
    fc.property(fc.integer({ min: 1, max: 9999 }), (counter) => {
      const documentUrl = ASSET.replace("v=5", () => `v=${counter}`);
      const changed = parseBfdiDocument({
        html: html.replace("&amp;v=5", () => `&amp;v=${counter}`),
        ...admitted,
        documentUrl,
      }).unwrap();
      expect(softLawIdentityKey("de-bfdi", changed.metadata).unwrap()).toBe(
        softLawIdentityKey("de-bfdi", original.metadata).unwrap(),
      );
      expect(changed.metadata.expression.revision).toEqual({
        state: "not_stated",
      });
    }),
  );
});

test("admission validation and stale cursors fail before publisher requests", async () => {
  expect(createBfdiAdapter({}).isErr()).toBe(true);
  expect(
    createBfdiAdapter({
      ...policy,
      indexes: [{ ...index, url: "https://example.org/topic" }],
    }).isErr(),
  ).toBe(true);
  const adapter = createBfdiAdapter({
    ...policy,
    indexes: [index, index],
  }).unwrap();
  const read = transport(await responses());
  const first = (
    await adapter.discover({
      cursor: null,
      signal: signal(),
      fetch: read.fetch,
    })
  ).unwrap();
  expect(first.nextCursor).not.toBeNull();
  const changed = createBfdiAdapter({
    ...policy,
    admissionReference: "changed",
    indexes: [index, index],
  }).unwrap();
  const denied = transport(new Map());
  expect(
    (
      await changed.discover({
        cursor: first.nextCursor,
        signal: signal(),
        fetch: denied.fetch,
      })
    ).isErr(),
  ).toBe(true);
  expect(
    (
      await adapter.discover({
        cursor: "malformed",
        signal: signal(),
        fetch: denied.fetch,
      })
    ).isErr(),
  ).toBe(true);
  expect(denied.calls).toEqual([]);
});

test("admission locators are normalized before discovery and document reads", async () => {
  const policies = [
    {
      indexUrl: INDEX.replace("www.bfdi.bund.de", "WWW.BFDI.BUND.DE"),
      detailUrl: DETAIL,
      documentUrl: ASSET,
    },
    {
      indexUrl: INDEX,
      detailUrl: DETAIL.replace("www.bfdi.bund.de", "www.bfdi.bund.de:443"),
      documentUrl: ASSET,
    },
    {
      indexUrl: INDEX,
      detailUrl: DETAIL,
      documentUrl: ASSET.replace(
        "Besch%C3%A4ftigtendatenschutz",
        "Beschäftigtendatenschutz",
      ),
    },
  ];
  for (const locators of policies) {
    const adapter = createBfdiAdapter({
      ...policy,
      indexes: [
        {
          url: locators.indexUrl,
          documents: [
            {
              ...admitted,
              url: locators.detailUrl,
              documentUrl: locators.documentUrl,
            },
          ],
        },
      ],
    }).unwrap();
    const read = transport(await responses());
    const page = (
      await adapter.discover({
        cursor: null,
        signal: signal(),
        fetch: read.fetch,
      })
    ).unwrap();
    const entry = page.entries.at(0) ?? panic("Missing normalized BfDI entry");
    expect(
      (
        await adapter.fetchDocument(entry, {
          signal: signal(),
          fetch: read.fetch,
        })
      ).isOk(),
    ).toBe(true);
    expect(read.calls).toEqual([INDEX, DETAIL, ASSET]);
  }
});

test("one bounded discovery batch reuses its topical index response", async () => {
  const adapter = createBfdiAdapter({
    ...policy,
    indexes: [
      { ...index, documents: Array.from({ length: 11 }, () => admitted) },
    ],
  }).unwrap();
  const read = transport(await responses());
  const page = (
    await adapter.discover({
      cursor: null,
      signal: signal(),
      fetch: read.fetch,
    })
  ).unwrap();
  expect(page.entries).toHaveLength(10);
  expect(page.nextCursor).not.toBeNull();
  expect(read.calls.filter((url) => url === INDEX)).toHaveLength(1);
  expect(read.calls.filter((url) => url === DETAIL)).toHaveLength(10);
});

test("overlapping discovery and replay converge while preserving complete raw and local PDF text", async () => {
  const adapter = createBfdiAdapter({
    ...policy,
    indexes: [index, index],
  }).unwrap();
  const read = transport(await responses());
  const first = (
    await adapter.discover({
      cursor: null,
      signal: signal(),
      fetch: read.fetch,
    })
  ).unwrap();
  const second = (
    await adapter.discover({
      cursor: first.nextCursor,
      signal: signal(),
      fetch: read.fetch,
    })
  ).unwrap();
  const entry = first.entries.at(0) ?? panic("Missing BfDI fixture entry");
  const duplicate =
    second.entries.at(0) ?? panic("Missing overlapping BfDI fixture entry");
  expect(entry).toBeDefined();
  expect(duplicate).toBeDefined();
  // Discovery entries carry the document discriminator ingestion switches on.
  expect(entry.type).toBe("document");
  expect(duplicate.type).toBe("document");
  const document = (
    await adapter.fetchDocument(entry, { signal: signal(), fetch: read.fetch })
  ).unwrap();
  const replay = (
    await adapter.fetchDocument(duplicate, {
      signal: signal(),
      fetch: read.fetch,
    })
  ).unwrap();
  expect(document.extractionQuality).toBe("text_layer");
  expect(document.text).toContain("Juni 2020");
  expect(document.raw.map((part) => part.role)).toEqual([
    "index",
    "detail",
    "document",
  ]);
  expect(softLawContentHash(document)).toBe(softLawContentHash(replay));
  expect(softLawIdentityKey("de-bfdi", document.metadata).unwrap()).toBe(
    softLawIdentityKey("de-bfdi", replay.metadata).unwrap(),
  );
  for (const part of document.raw) {
    expect(part.provenance).toMatchObject({
      sha256: sha256Hex(part.bytes),
      retrievedAt: expect.any(String),
    });
  }
  expect(read.calls.every((url) => [INDEX, DETAIL, ASSET].includes(url))).toBe(
    true,
  );
  expect(second.nextCursor).toBeNull();
  expect(await adapter.getTotalCount()).toEqual({ type: "no-count-endpoint" });
});

test("retry evidence and revoked document locators cannot trigger a publisher request", async () => {
  const adapter = createBfdiAdapter(policy).unwrap();
  const read = transport(await responses());
  const page = (
    await adapter.discover({
      cursor: null,
      signal: signal(),
      fetch: read.fetch,
    })
  ).unwrap();
  const entry = page.entries.at(0) ?? panic("Missing BfDI fixture entry");
  expect(entry).toBeDefined();
  const denied = transport(new Map());
  for (const changed of [
    { ...entry, url: "https://example.org/document.pdf" },
    { ...entry, sourceRaw: [] },
    {
      ...entry,
      sourceRaw: entry.sourceRaw.map((part) => ({
        ...part,
        contentBase64: "Y2hhbmdlZA==",
      })),
    },
  ]) {
    expect(
      (
        await adapter.fetchDocument(changed, {
          signal: signal(),
          fetch: denied.fetch,
        })
      ).isErr(),
    ).toBe(true);
  }
  expect(denied.calls).toEqual([]);
});

test("a failed local extraction retains bytes and provenance for repair", async () => {
  const adapter = createBfdiAdapter(policy).unwrap();
  const records = await responses();
  records.set(ASSET, {
    bytes: Buffer.from("%PDF-invalid"),
    contentType: "application/pdf",
  });
  const read = transport(records);
  const page = (
    await adapter.discover({
      cursor: null,
      signal: signal(),
      fetch: read.fetch,
    })
  ).unwrap();
  const entry = page.entries.at(0) ?? panic("Missing BfDI fixture entry");
  const document = (
    await adapter.fetchDocument(entry, { signal: signal(), fetch: read.fetch })
  ).unwrap();
  expect(document.extractionQuality).toBe("extraction_failed");
  expect(document.raw.at(-1)?.bytes).toEqual(Buffer.from("%PDF-invalid"));
});
