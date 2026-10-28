import { afterEach, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { czNssAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
} from "@/api/lib/legal-search/ingestion-types";
import {
  approveMetadataUrls,
  META_URL_DIAGNOSTICS,
} from "@/api/lib/legal-search/metadata-urls";
import { czNssFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";

import { extractNssPublisherMetadata } from "./cz-nss-publisher-metadata";
import { CZ_NSS_PUBLISHER_METADATA_URL_SCHEMA } from "./cz-nss.metadata-urls";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const capture = async (id: number) =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      await Bun.file(
        new URL(`__fixtures__/cz-nss-publisher-${id}.html.gz`, import.meta.url),
      ).bytes(),
    ),
  );

const REVIEW_FIELDS = [
  "krajskysoud",
  "kasacnistiznostoznacenivecivcelku",
  "datumrozhodnutikrajskehosoudu",
  "rozhodnutonapkasst",
] as const;

const tableOf = (rows: readonly (readonly string[])[]) =>
  `<table><thead><tr>${REVIEW_FIELDS.map((field) => `<th data-field-id="${field}">Label ${field}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, index) => `<td class="det-textval" data-field-id="${REVIEW_FIELDS.at(index)}">${value}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

test("the recorded NSS review keeps the challenged court, docket, date and outcome in one tuple", async () => {
  const { publisherFields, publisherTables } = extractNssPublisherMetadata(
    await capture(641_750),
  );
  const expected = [
    "Krajský soud v Ostravě",
    "22 A 108/2012-84",
    "27.06.2014",
    "zrušeno a vráceno",
  ];
  for (const [index, field] of REVIEW_FIELDS.entries()) {
    expect(publisherFields[field]).toContain(expected.at(index));
  }
  expect(
    publisherTables.flatMap(({ rows }) =>
      rows.map(({ cells }) =>
        cells
          .filter(({ field }) =>
            REVIEW_FIELDS.some((reviewField) => reviewField === field),
          )
          .map(({ value }) => value),
      ),
    ),
  ).toContainEqual(expected);
});

test.each([641_750, 641_220])(
  "all publisher field ids in captured NSS record %s have a distinct retained entry",
  async (id) => {
    const html = await capture(id);
    const stated = await czNssAdapter.sourceFields.listSourceFields({
      detail: html,
    });
    const metadata = extractNssPublisherMetadata(html);
    expect(Object.keys(metadata.publisherFields).toSorted()).toEqual(
      [...stated].toSorted(),
    );
    for (const table of metadata.publisherTables) {
      for (const row of table.rows) {
        for (const cell of row.cells) {
          expect(
            metadata.publisherFields[cell.field]?.at(cell.occurrence),
          ).toBe(cell.value);
        }
      }
    }
  },
);

test("NSS review tuples retain their occurrences under arbitrary repeated proceedings", () => {
  assertProperty(
    "nss-publisher-review-tuples",
    fc.property(
      fc.array(
        fc.tuple(
          fc.constantFrom("Krajský soud v Ostravě", "Městský soud v Praze"),
          fc.integer({ min: 1, max: 999 }),
          fc.constantFrom("zamítnuto", "zrušeno a vráceno"),
        ),
        { minLength: 2, maxLength: 12 },
      ),
      (proceedings) => {
        const expected = proceedings.map(([court, number, outcome]) => [
          court,
          `22 A ${number}/2026`,
          `2026-01-${String((number % 28) + 1).padStart(2, "0")}`,
          outcome,
        ]);
        const metadata = extractNssPublisherMetadata(
          tableOf(expected.slice(0, 1)) + tableOf(expected.slice(1)),
        );
        expect(metadata.publisherTables).toHaveLength(2);
        expect(metadata.publisherTables.at(0)?.rows).toHaveLength(1);
        expect(metadata.publisherTables.at(1)?.rows).toHaveLength(
          expected.length - 1,
        );
        expect(
          metadata.publisherTables.flatMap(({ rows }) =>
            rows.map(({ cells }) => cells.map(({ value }) => value)),
          ),
        ).toEqual(expected);
        for (const [index, field] of REVIEW_FIELDS.entries()) {
          expect(metadata.publisherFields[field]?.length).toBe(expected.length);
          for (const [rowIndex, row] of expected.entries()) {
            expect(metadata.publisherFields[field]?.at(rowIndex)).toBe(
              row.at(index),
            );
          }
        }
      },
    ),
  );
});

test.each([10, 100])(
  "NSS grid retention keeps all cells at %s publisher rows",
  (rowCount) => {
    const rows = Array.from({ length: rowCount }, (_, index) => [
      "Krajský soud v Ostravě",
      `22 A ${index + 1}/2026`,
      "27.06.2026",
      "zrušeno a vráceno",
    ]);
    const metadata = extractNssPublisherMetadata(tableOf(rows));
    expect(
      metadata.publisherTables.flatMap(({ rows: tableRows }) =>
        tableRows.map(({ cells }) => cells.map(({ value }) => value)),
      ),
    ).toEqual(rows);
    expect(
      metadata.publisherTables.reduce(
        (total, table) =>
          total +
          table.rows.reduce((cells, row) => cells + row.cells.length, 0),
        0,
      ),
    ).toBe(rowCount * REVIEW_FIELDS.length);
    expect(
      Object.values(metadata.publisherFields).reduce(
        (total, values) => total + values.length,
        0,
      ),
    ).toBe(rowCount * REVIEW_FIELDS.length);
  },
);

test("empty values, new fields and nested styling survive without turning headings into values", () => {
  const metadata = extractNssPublisherMetadata(
    `<div data-field-id="new-field"><span class="det-textitle">A label only</span><span class="det-textval">Outer <span class="det-textval">nested</span></span></div><div data-field-id="empty"><span class="det-textval"></span></div><table><thead><tr><th data-field-id="header-only">Column label</th></tr></thead></table><div data-field-id="paragraf&#xA7;"><span class="det-textval"><b>§</b> 17 &amp; 18</span></div>`,
  );
  expect(metadata.publisherFields).toEqual({
    "new-field": ["Outer nested"],
    empty: [""],
    "header-only": [],
    "paragraf§": ["§ 17 & 18"],
  });
  expect(Object.hasOwn(metadata.publisherFields, "absent")).toBe(false);
});

test("NSS publisher links retain their field occurrence through the declared URL boundary", () => {
  const metadata = extractNssPublisherMetadata(
    `<div data-field-id="prejudikatura"><span class="det-textval"><a href="/DokumentDetail/Index/641750">22 A 108/2012-84</a><a href="https://example.test/decision">Other</a></span><span class="det-textval"><a href="javascript:alert(1)">Unsafe</a></span></div>`,
  );
  const projected = approveMetadataUrls(
    metadata,
    CZ_NSS_PUBLISHER_METADATA_URL_SCHEMA,
  );
  expect(projected["publisherReferences"]).toMatchObject([
    {
      field: "prejudikatura",
      occurrence: 0,
      text: "22 A 108/2012-84",
      sourceUrl: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/641750",
    },
    {
      field: "prejudikatura",
      occurrence: 0,
      text: "Other",
      sourceUrl: "https://example.test/decision",
    },
    { field: "prejudikatura", occurrence: 1, text: "Unsafe" },
  ]);
  expect(projected[META_URL_DIAGNOSTICS]).toMatchObject({
    entries: [
      {
        address: "publisherReferences[2].sourceUrl",
        reason: "unsafe-protocol",
      },
    ],
  });
});

test("normal NSS reparse promotes every held detail field and preserves the projection at a fixed point", async () => {
  const decision = await czNssFixture().buildDecision();
  const reparse = czNssAdapter.reparseStoredRaw;
  expect(reparse).toBeDefined();
  if (reparse === undefined) {
    return;
  }
  const stored = {
    raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
    contentType: decision.sourceRawContentType ?? null,
    caseNumber: decision.caseNumber,
    sourceDocumentId: decision.sourceDocumentId ?? null,
    language: decision.language,
    court: decision.court,
    ecli: decision.ecli ?? null,
    decisionDate: decision.decisionDate ?? null,
    decisionType: decision.decisionType ?? null,
    sourceUrl: decision.sourceUrl ?? null,
    documentUrl: decision.documentUrl ?? null,
    metadata: decision.metadata,
  };
  const first = await reparse(stored);
  expect(first.type).toBe("parsed");
  if (first.type !== "parsed") {
    return;
  }
  expect(first.result.metadata["publisherFields"]).toEqual(
    decision.metadata["publisherFields"],
  );
  expect(first.result.metadata["publisherTables"]).toEqual(
    decision.metadata["publisherTables"],
  );
  expect(first.result.metadata["publisherReferences"]).toEqual(
    decision.metadata["publisherReferences"],
  );
  const second = await reparse({ ...stored, metadata: first.result.metadata });
  expect(second.type).toBe("parsed");
  if (second.type === "parsed") {
    expect(second.result.metadata).toEqual(first.result.metadata);
  }
  const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
  expect(parts).not.toBeNull();
  if (parts === null) {
    return;
  }
  const { detail: _detail, ...documentOnly } = parts;
  const {
    publisherFields: _fields,
    publisherTables: _tables,
    publisherReferences: _references,
    ...legacyMetadata
  } = decision.metadata;
  const legacy = await reparse({
    ...stored,
    raw: new TextEncoder().encode(encodeSourceRawEnvelope(documentOnly)),
    metadata: legacyMetadata,
  });
  expect(legacy.type).toBe("parsed");
  if (legacy.type === "parsed") {
    expect(Object.hasOwn(legacy.result.metadata, "publisherFields")).toBe(
      false,
    );
  }
  const retained = await reparse({
    ...stored,
    raw: new TextEncoder().encode(encodeSourceRawEnvelope(documentOnly)),
  });
  expect(retained.type).toBe("parsed");
  if (retained.type === "parsed") {
    expect(retained.result.metadata["publisherFields"]).toEqual(
      decision.metadata["publisherFields"],
    );
  }
});
