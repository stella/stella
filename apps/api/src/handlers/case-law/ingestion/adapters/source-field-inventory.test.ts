/**
 * Source-field conformance: what every case-law adapter must say about the
 * fields its publisher states.
 *
 * A per-adapter test certifies what its author noticed, which is exactly the
 * blind spot: a labelled field on a page the adapter already fetches can go
 * unread for years and no assertion anywhere goes red, because nobody wrote
 * one about a field they did not see. So the check lives outside the adapters
 * and is driven from the registry: each enrolled adapter reads its own stored
 * envelope back through `listSourceFields`, and every name that comes out has
 * to be in the inventory as stored or as excluded with a reason.
 *
 * Three invariants, run over every registered adapter:
 *
 * 1. Every field its envelope states is in the map, and every field the map
 *    stores is on the decision built from that fixture — at the metadata key,
 *    result field, document or identity the disposition names.
 * 2. The other direction: a field the map declares that the envelope never
 *    states is a disposition nothing exercises, which reads like a decision
 *    and certifies nothing.
 * 3. What the inventory reads is the stored raw itself. A field captured later
 *    is only recoverable for stored rows if the response stating it was kept,
 *    so the reader is given the parts of the envelope and nothing else.
 */

import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  decodeSourceRawEnvelope,
  EMPTY_AST,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceFieldDisposition,
  SourceFieldTarget,
  SourceRawParts,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  getSourceRegistration,
  listSourceRegistrations,
  type SourceRegistrationKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  composedMetadataUrlSchema,
  metadataUrlSchemaForAdapter,
} from "@/api/handlers/case-law/ingestion/metadata-url-schemas";
import { composeDecisionWithSupplements } from "@/api/handlers/case-law/ingestion/supplement-composition";
import { storeTextField } from "@/api/lib/case-law/decision-text";
import { DECISION_SUPPLEMENT_KIND } from "@/api/lib/legal-search/decision-supplement-kind";
import {
  PLAIN_TEXT_FIELD_DEBT,
  PLAIN_TEXT_RESULT_FIELDS,
} from "@/api/lib/legal-search/ingestion-types";
import {
  approveMetadataUrls,
  metadataUrlAddresses,
} from "@/api/lib/legal-search/metadata-urls";
import { entityResiduesInStoredText } from "@/api/lib/legal-search/parsers/entity-residue";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { readSourceRawField } from "@/api/lib/legal-search/source-raw-field";
import { toMetadataUrl } from "@/api/lib/sanitize-url";
import {
  CASE_LAW_CONFORMANCE_FIXTURES,
  plCourtsFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";
import {
  isClassifiedMetadataKey,
  METADATA_TEXT_DISPOSITIONS,
  metadataDisplayTextOf,
  metadataTextAddressDispositionsForAdapter,
  metadataNullOnlyAddressesForAdapter,
  unclassifiedMetadataAddresses,
} from "@/api/tests/helpers/case-law-metadata-text-census";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const DECLARED_ADAPTER_KEYS = listSourceRegistrations().map(
  ({ source }) => source.key,
);

const adapterFor = (key: SourceRegistrationKey) =>
  getSourceRegistration(key)?.source ??
  panic(`${key} is declared but not registered`);

/** The registry and the fixture census must agree even after runtime widening. */
const plainTextFixtureFor = (key: SourceRegistrationKey) => {
  if (!Object.hasOwn(CASE_LAW_CONFORMANCE_FIXTURES, key)) {
    return panic(`Missing plain-text adapter census fixture: ${key}`);
  }
  return CASE_LAW_CONFORMANCE_FIXTURES[key];
};

test("the plain-text census rejects an unaccounted adapter", () => {
  expect(Object.keys(PLAIN_TEXT_FIELD_DEBT)).toEqual([]);
  expect(() => {
    // @ts-expect-error An adapter outside the registry cannot satisfy its census.
    plainTextFixtureFor("fake-plain-text-adapter");
  }).toThrow(
    "Missing plain-text adapter census fixture: fake-plain-text-adapter",
  );
});

// ── Reading a stored field back ──────────────────────────

const isPresent = (value: unknown): boolean => {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return Array.isArray(value) ? value.length > 0 : true;
};

/** What the row holds where a disposition says the field is stored. */
const storedValueOf = (
  decision: IngestionResult,
  target: SourceFieldTarget,
): unknown => {
  switch (target.type) {
    case "raw":
      return readSourceRawField(
        decodeSourceRawEnvelope(decision.sourceRaw ?? "") ?? {},
        target,
      );
    case "metadata":
      return decision.metadata[target.key];
    case "textField":
      return storeTextField(decision.textFields[target.key]);
    case "result":
      return decision[target.key];
    case "document":
      return "blocks" in decision.documentAst &&
        decision.documentAst.blocks.length > 0
        ? decision.documentAst
        : (decision.fulltext ?? undefined);
    case "identity":
      return decision.sourceDocumentId;
    default: {
      target satisfies never;
      return panic(`Unhandled source-field target: ${JSON.stringify(target)}`);
    }
  }
};

const describeTarget = (target: SourceFieldTarget): string => {
  switch (target.type) {
    case "raw":
      return `raw.${target.part}.${target.path.join(".")}`;
    case "metadata":
      return `metadata.${target.key}`;
    case "textField":
      return `textFields.${target.key}`;
    case "result":
      return `the result's ${target.key}`;
    case "document":
      return "the parsed document";
    case "identity":
      return "the row's identity";
    default: {
      target satisfies never;
      return panic(`Unhandled source-field target: ${JSON.stringify(target)}`);
    }
  }
};

/** The envelope a decision was stored under, which is what the reader sees. */
const storedPartsOf = (
  key: SourceRegistrationKey,
  decision: IngestionResult,
): SourceRawParts => {
  const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
  if (parts === null || Object.keys(parts).length === 0) {
    throw new Error(
      `${key}: the decision built from its fixture stores no envelope, so its inventory reads nothing. Store every response fetched for the decision through encodeSourceRawEnvelope.`,
    );
  }
  return parts;
};

/**
 * Every metadata key a decision carries, read through the census's total
 * disposition map: the display strings of the classified keys, and the keys
 * nothing classified yet.
 */
const metadataDisplayTextCensus = (
  metadata: Record<string, unknown>,
  schema?: unknown,
) => {
  const unclassified: string[] = [];
  const texts = Object.entries(metadata).flatMap(([key, value]) => {
    if (!isClassifiedMetadataKey(key)) {
      unclassified.push(key);
      return [];
    }
    return metadataDisplayTextOf(key, value, schema);
  });
  return { texts, unclassified };
};

// ── Invariants ───────────────────────────────────────────

describe("every adapter accounts for the fields its source states", () => {
  for (const key of DECLARED_ADAPTER_KEYS) {
    const fixture = plainTextFixtureFor(key);

    test(`${key}: every field its source states is stored or excluded`, async () => {
      const { sourceFields } = adapterFor(key);
      const evidence = fixture();
      const decision = await evidence.buildDecision();
      const schema = metadataUrlSchemaForAdapter(key);
      // The branded contract covers every registered source with no field debt.
      const normalized = plainTextIngestionResult(decision, schema);
      for (const field of Object.keys(PLAIN_TEXT_RESULT_FIELDS)) {
        expect(Reflect.get(normalized, field), `${key}.${field}`).toEqual(
          Reflect.get(decision, field),
        );
      }
      const parts = storedPartsOf(key, decision);

      expect(
        unclassifiedMetadataAddresses(decision.metadata, {
          schema,
          textAddresses: metadataTextAddressDispositionsForAdapter(key),
          nullOnlyAddresses: metadataNullOnlyAddressesForAdapter(key),
        }),
        `${key}: address fields require exact producer declarations`,
      ).toEqual([]);
      const metadataCensus = metadataDisplayTextCensus(
        decision.metadata,
        schema,
      );
      expect(
        metadataCensus.unclassified,
        `${key}: metadata keys the display-text census does not classify: ${metadataCensus.unclassified.join(", ")}. Add each to METADATA_TEXT_DISPOSITIONS as inspected, or excluded with the reason.`,
      ).toEqual([]);
      const textOutputs = [
        { field: "caseNumber", value: decision.caseNumber },
        { field: "court", value: decision.court },
        ...(decision.decisionType === undefined
          ? []
          : [{ field: "decisionType", value: decision.decisionType }]),
        ...(decision.judges ?? []).map(({ nameAsPrinted }, index) => ({
          field: `judges.${index}.nameAsPrinted`,
          value: nameAsPrinted,
        })),
        ...(decision.fulltext === undefined
          ? []
          : [{ field: "fulltext", value: decision.fulltext }]),
        ...Object.entries(decision.textFields).flatMap(([field, value]) =>
          value.type === "present"
            ? [{ field: `textFields.${field}`, value: value.text }]
            : [],
        ),
        ...("blocks" in decision.documentAst
          ? decision.documentAst.blocks.map((block) => ({
              field: `documentAst.${block.type}.${block.id}`,
              value: block.plainText,
            }))
          : []),
        ...(decision.sections ?? []).flatMap((section) => [
          {
            field: `sections.${section.index}.title`,
            value: section.title ?? "",
          },
          { field: `sections.${section.index}.text`, value: section.text },
        ]),
        ...metadataCensus.texts,
        ...("blocks" in decision.documentAst
          ? [
              ...decision.documentAst.metadata.keywords.map((value, index) => ({
                field: `documentAst.metadata.keywords.${index}`,
                value,
              })),
              ...decision.documentAst.metadata.statutes.map((value, index) => ({
                field: `documentAst.metadata.statutes.${index}`,
                value,
              })),
            ]
          : []),
      ];
      const entityResidues = entityResiduesInStoredText(textOutputs);
      expect(
        entityResidues,
        `${key}: normalized case-law text retains character references`,
      ).toEqual([]);

      const stated = await sourceFields.listSourceFields(parts);
      expect(
        stated.length,
        `${key}: the stored envelope states no fields at all, so this suite would certify nothing. Check listSourceFields against the parts the adapter writes.`,
      ).toBeGreaterThan(0);

      const undeclared = stated.filter(
        (field) => sourceFields.fields[field] === undefined,
      );
      expect(
        undeclared,
        `${key}: its source states fields nothing decided about: ${undeclared.join(", ")}. Store them, or exclude them with the reason.`,
      ).toEqual([]);

      // `excludedSourceField` rejects a blank reason at the call site, so this
      // is the backstop for a reason that reaches an inventory some other way.
      const unreasoned = stated.filter((field) => {
        const disposition: SourceFieldDisposition | undefined =
          sourceFields.fields[field];
        return (
          disposition?.disposition === "excluded" &&
          disposition.reason.trim().length === 0
        );
      });
      expect(
        unreasoned,
        `${key}: these fields are excluded with a blank reason: ${unreasoned.join(", ")}. An exclusion nobody explained is the silence this suite exists to break.`,
      ).toEqual([]);

      // The other direction, or a disposition could be declared and never
      // exercised: the checks below only walk what the envelope states, so a
      // stored field the fixture never carries would be certified by nothing.
      const neverObserved = Object.keys(sourceFields.fields).filter(
        (field) => !stated.includes(field),
      );
      expect(
        neverObserved,
        `${key}: its inventory declares fields the stored envelope never states: ${neverObserved.join(", ")}. The fixture is the union of what the source's pages state, so add them there or drop them from the inventory.`,
      ).toEqual([]);

      const unstored = stated.flatMap((field) => {
        const disposition: SourceFieldDisposition | undefined =
          sourceFields.fields[field];
        if (disposition?.disposition !== "stored") {
          return [];
        }
        if (disposition.target.type === "raw") {
          expect(disposition.target.reason.trim().length).toBeGreaterThan(0);
          expect(
            Object.hasOwn(evidence.rawFieldValues ?? {}, field),
            `${key}: missing source value oracle for ${field}`,
          ).toBe(true);
          expect(
            storedValueOf(decision, disposition.target),
            `${key}: raw field ${field} changed`,
          ).toEqual(evidence.rawFieldValues?.[field]);
          return [];
        }
        return isPresent(storedValueOf(decision, disposition.target))
          ? []
          : [`${field} -> ${describeTarget(disposition.target)}`];
      });

      expect(
        unstored,
        `${key}: these fields are declared stored, and the decision built from the fixture that states them does not carry them: ${unstored.join("; ")}.`,
      ).toEqual([]);
    });
  }
});

describe("the display-text census classifies exactly the metadata adapters emit", () => {
  test("every classified key is emitted by some fixture, and every emitted key is classified", async () => {
    const emitted = new Set<string>();
    for (const key of DECLARED_ADAPTER_KEYS) {
      // Fixtures stub the global fetch, so they build one at a time.
      const decision =
        await CASE_LAW_CONFORMANCE_FIXTURES[key]().buildDecision();
      globalThis.fetch = originalFetch;
      for (const metadataKey of Object.keys(decision.metadata)) {
        emitted.add(metadataKey);
      }
    }
    const judgment = await plCourtsFixture().buildDecision();
    const composed = composeDecisionWithSupplements({
      judgment,
      metadataUrlSchema: metadataUrlSchemaForAdapter(ADAPTER_KEYS.PL_COURTS),
      supplements: [
        {
          kind: DECISION_SUPPLEMENT_KIND.REASONS,
          sourceDocumentId: "census-supplement",
          sourceUrl: "https://example.test/?stated=&amp;amp;",
          sourceHash: "fixture-hash",
          fulltext: null,
          documentAst: EMPTY_AST,
        },
      ],
    });
    const composedSchema = composedMetadataUrlSchema(
      metadataUrlSchemaForAdapter(ADAPTER_KEYS.PL_COURTS),
    );
    expect(
      unclassifiedMetadataAddresses(composed.metadata, {
        schema: composedSchema,
      }),
    ).toEqual([]);
    expect(
      metadataDisplayTextOf(
        "documentSupplements",
        composed.metadata["documentSupplements"],
        composedSchema,
      ),
    ).toEqual([
      { field: "metadata.documentSupplements.0.kind", value: "reasons" },
      {
        field: "metadata.documentSupplements.0.sourceDocumentId",
        value: "census-supplement",
      },
    ]);
    for (const metadataKey of Object.keys(composed.metadata)) {
      emitted.add(metadataKey);
    }
    const unclassified = [...emitted].filter(
      (metadataKey) => !isClassifiedMetadataKey(metadataKey),
    );
    expect(
      unclassified,
      `metadata keys no disposition covers: ${unclassified.join(", ")}`,
    ).toEqual([]);
    const neverEmitted = Object.keys(METADATA_TEXT_DISPOSITIONS).filter(
      (metadataKey) => !emitted.has(metadataKey),
    );
    expect(
      neverEmitted,
      `dispositions no fixture exercises: ${neverEmitted.join(", ")}. Drop them, or add the field to the fixture that states it.`,
    ).toEqual([]);
  });

  test("display text is inspected while exactly declared nested URLs are excluded", () => {
    const schema = {
      referencedLegislation: { items: { url: "url" } },
    } as const;
    const metadata = approveMetadataUrls(
      {
        referencedLegislation: [
          {
            nazov: "Z&#225;kon",
            url: toMetadataUrl(
              "https://example.org/?a=1&amp;b=2",
              "transport-json",
            ),
          },
        ],
      },
      schema,
    );
    const texts = metadataDisplayTextOf(
      "referencedLegislation",
      metadata["referencedLegislation"],
      schema,
    );
    expect(unclassifiedMetadataAddresses(metadata, { schema })).toEqual([]);
    expect(metadataUrlAddresses(schema)).toEqual([
      "referencedLegislation[*].url",
    ]);
    const objectArray = approveMetadataUrls(
      {
        publications: [
          {
            url: toMetadataUrl(
              "https://example.org/?a=&amp;",
              "transport-json",
            ),
          },
        ],
      },
      { publications: { items: { url: "url" } } },
    );
    expect(
      metadataDisplayTextOf("publications", objectArray["publications"], {
        publications: { items: { url: "url" } },
      }),
    ).toEqual([]);
    expect(
      unclassifiedMetadataAddresses({
        referencedLegislation: [{ url: "https://example.org/" }],
      }),
    ).toEqual(["metadata.referencedLegislation.0.url"]);
    expect(
      unclassifiedMetadataAddresses({
        unclassified: { nested: [{ href: null }] },
      }),
    ).toEqual(["metadata.unclassified.nested.0.href"]);
    expect(unclassifiedMetadataAddresses({ guid: { href: "opaque" } })).toEqual(
      ["metadata.guid.href"],
    );
    expect(texts).toEqual([
      { field: "metadata.referencedLegislation.0.nazov", value: "Z&#225;kon" },
    ]);
    expect(entityResiduesInStoredText(texts)).toEqual([
      {
        field: "metadata.referencedLegislation.0.nazov",
        entity: "&#225;",
        index: 1,
      },
    ]);
    expect(metadataDisplayTextOf("guid", "source&amp;key")).toEqual([]);
  });

  test("undeclared URI and link suffixes and HTTP values under other keys fail the census", () => {
    for (const key of ["sourceUri", "referenceLink", "publisherAddress"]) {
      expect(
        unclassifiedMetadataAddresses({
          nested: [{ [key]: "https://example.test/?a=&amp;" }],
        }),
      ).toEqual([`metadata.nested.0.${key}`]);
    }
    expect(
      unclassifiedMetadataAddresses({
        nested: [{ sourceUri: null, referenceLink: null }],
      }),
    ).toEqual([
      "metadata.nested.0.sourceUri",
      "metadata.nested.0.referenceLink",
    ]);
    const schema = {
      nested: { items: { sourceUri: "url", referenceLink: "url" } },
    } as const;
    expect(
      unclassifiedMetadataAddresses(
        { nested: [{ sourceUri: null, referenceLink: null }] },
        { schema },
      ),
    ).toEqual([]);
  });

  test("the captured regional affected-document address permits only null", () => {
    const nullOnlyAddresses = metadataNullOnlyAddressesForAdapter(
      ADAPTER_KEYS.CZ_REGIONAL,
    );
    expect(
      unclassifiedMetadataAddresses(
        { affectedDocs: [{ url: null }] },
        { nullOnlyAddresses },
      ),
    ).toEqual([]);
    for (const value of [
      undefined,
      "",
      "opaque",
      "https://example.test/?a=&amp;",
      "ftp://example.test/",
      0,
      false,
      {},
      [],
    ]) {
      expect(
        unclassifiedMetadataAddresses(
          { affectedDocs: [{ url: value }] },
          { nullOnlyAddresses },
        ),
      ).toEqual(["metadata.affectedDocs.0.url"]);
    }
    expect(
      unclassifiedMetadataAddresses(
        { affectedDocs: { "0": { url: null } } },
        { nullOnlyAddresses },
      ),
    ).toEqual(["metadata.affectedDocs.0.url"]);
    expect(
      unclassifiedMetadataAddresses(
        { affectedDocs: [{ otherUrl: null }] },
        { nullOnlyAddresses },
      ),
    ).toEqual(["metadata.affectedDocs.0.otherUrl"]);
    expect(
      unclassifiedMetadataAddresses({ affectedDocs: [{ url: null }] }),
    ).toEqual(["metadata.affectedDocs.0.url"]);
  });

  test("URL-looking publisher citations need an explicit textual address disposition", () => {
    const metadata = {
      relatedDecisions: ["https://example.test/?citation=&amp;"],
    };
    expect(unclassifiedMetadataAddresses(metadata)).toEqual([
      "metadata.relatedDecisions.0",
    ]);
    expect(
      unclassifiedMetadataAddresses(metadata, {
        textAddresses: metadataTextAddressDispositionsForAdapter(
          ADAPTER_KEYS.AT_COURTS,
        ),
      }),
    ).toEqual([]);
    expect(
      unclassifiedMetadataAddresses(
        { relatedDecisions: "https://example.test/?citation=&amp;" },
        {
          textAddresses: metadataTextAddressDispositionsForAdapter(
            ADAPTER_KEYS.AT_COURTS,
          ),
        },
      ),
    ).toEqual([]);
    expect(
      unclassifiedMetadataAddresses(
        { statedSourceUrl: "https://example.test/?stated=&amp;" },
        {
          textAddresses: metadataTextAddressDispositionsForAdapter(
            ADAPTER_KEYS.SK_COURTS,
          ),
        },
      ),
    ).toEqual([]);
    expect(
      unclassifiedMetadataAddresses(
        { relatedDecisions: [{ publisherAddress: "https://example.test/" }] },
        {
          textAddresses: metadataTextAddressDispositionsForAdapter(
            ADAPTER_KEYS.AT_COURTS,
          ),
        },
      ),
    ).toEqual(["metadata.relatedDecisions.0.publisherAddress"]);
    expect(
      unclassifiedMetadataAddresses(
        { relatedDecisions: { "0": "https://example.test/" } },
        {
          textAddresses: metadataTextAddressDispositionsForAdapter(
            ADAPTER_KEYS.AT_COURTS,
          ),
        },
      ),
    ).toEqual(["metadata.relatedDecisions.0"]);
  });
});
