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
import type { AdapterKey } from "@/api/handlers/case-law/consts";
import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceFieldDisposition,
  SourceFieldTarget,
  SourceRawParts,
} from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { storeTextField } from "@/api/lib/case-law/decision-text";
import {
  atFindokFixture,
  atRisFixture,
  czNsFixture,
  czNssFixture,
  czRegionalFixture,
  czUsFixture,
  euEcjFixture,
  huBhgyFixture,
  plCourtsFixture,
  plKioFixture,
  plKisFixture,
  plNsaFixture,
  plNcourtFixture,
  plSnFixture,
  plTkFixture,
  plUodoFixture,
  skCourtsFixture,
  skUsFixture,
  type EnrolledAdapterFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Coverage declaration ─────────────────────────────────

/**
 * What this suite drives each adapter with. Total over the registry, so a
 * source registered without a fixture to read its own envelope back through
 * does not compile.
 */
const ADAPTER_INVENTORY_COVERAGE = {
  [ADAPTER_KEYS.CZ_NS]: czNsFixture,
  [ADAPTER_KEYS.CZ_NSS]: czNssFixture,
  [ADAPTER_KEYS.CZ_US]: czUsFixture,
  [ADAPTER_KEYS.CZ_REGIONAL]: czRegionalFixture,
  [ADAPTER_KEYS.SK_COURTS]: skCourtsFixture,
  [ADAPTER_KEYS.SK_US]: skUsFixture,
  [ADAPTER_KEYS.PL_COURTS]: plCourtsFixture,
  [ADAPTER_KEYS.PL_SN]: plSnFixture,
  [ADAPTER_KEYS.PL_KIO]: plKioFixture,
  [ADAPTER_KEYS.PL_TK]: plTkFixture,
  [ADAPTER_KEYS.PL_NSA]: plNsaFixture,
  [ADAPTER_KEYS.PL_NCOURT]: plNcourtFixture,
  [ADAPTER_KEYS.AT_COURTS]: () => atRisFixture(ADAPTER_KEYS.AT_COURTS),
  [ADAPTER_KEYS.AT_VFGH]: () => atRisFixture(ADAPTER_KEYS.AT_VFGH),
  [ADAPTER_KEYS.AT_VWGH]: () => atRisFixture(ADAPTER_KEYS.AT_VWGH),
  [ADAPTER_KEYS.AT_BVWG]: () => atRisFixture(ADAPTER_KEYS.AT_BVWG),
  [ADAPTER_KEYS.AT_LVWG]: () => atRisFixture(ADAPTER_KEYS.AT_LVWG),
  [ADAPTER_KEYS.AT_ASYLGH]: () => atRisFixture(ADAPTER_KEYS.AT_ASYLGH),
  [ADAPTER_KEYS.AT_UBAS]: () => atRisFixture(ADAPTER_KEYS.AT_UBAS),
  [ADAPTER_KEYS.AT_UVS]: () => atRisFixture(ADAPTER_KEYS.AT_UVS),
  [ADAPTER_KEYS.AT_VERG]: () => atRisFixture(ADAPTER_KEYS.AT_VERG),
  [ADAPTER_KEYS.AT_UMSE]: () => atRisFixture(ADAPTER_KEYS.AT_UMSE),
  [ADAPTER_KEYS.AT_BKS]: () => atRisFixture(ADAPTER_KEYS.AT_BKS),
  [ADAPTER_KEYS.AT_FINDOK]: atFindokFixture,
  [ADAPTER_KEYS.EU_ECJ]: euEcjFixture,
  [ADAPTER_KEYS.HU_BHGY]: huBhgyFixture,
  [ADAPTER_KEYS.PL_KIS]: plKisFixture,
  [ADAPTER_KEYS.PL_UODO]: plUodoFixture,
} as const satisfies Record<AdapterKey, () => EnrolledAdapterFixture>;

const DECLARED_ADAPTER_KEYS = Object.values(ADAPTER_KEYS);

const adapterFor = (key: AdapterKey) =>
  getAdapter(key) ?? panic(`${key} is declared but not registered`);

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
  key: AdapterKey,
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

// ── Invariants ───────────────────────────────────────────

describe("every adapter accounts for the fields its source states", () => {
  for (const key of DECLARED_ADAPTER_KEYS) {
    const fixture = ADAPTER_INVENTORY_COVERAGE[key];

    test(`${key}: every field its source states is stored or excluded`, async () => {
      const { sourceFields } = adapterFor(key);
      const decision = await fixture().buildDecision();
      const parts = storedPartsOf(key, decision);

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
