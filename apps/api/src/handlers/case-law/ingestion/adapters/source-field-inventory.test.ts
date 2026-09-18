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
 * Four invariants, run over every registered adapter:
 *
 * 1. The pending baseline names exactly the adapters without an inventory, and
 *    each of them names itself, so the un-inventoried set can only shrink.
 * 2. For an enrolled adapter: every field its envelope states is in the map,
 *    and every field the map stores is on the decision built from that
 *    fixture — at the metadata key, result field, document or identity the
 *    disposition names.
 * 3. The other direction: a field the map declares that the envelope never
 *    states is a disposition nothing exercises, which reads like a decision
 *    and certifies nothing.
 * 4. What the inventory reads is the stored raw itself. A field captured later
 *    is only recoverable for stored rows if the response stating it was kept,
 *    so the reader is given the parts of the envelope and nothing else.
 */

import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { AdapterKey } from "@/api/handlers/case-law/consts";
import {
  decodeSourceRawEnvelope,
  pendingSourceFieldInventory,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceFieldDisposition,
  SourceFieldTarget,
  SourceRawParts,
} from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import baseline from "@/api/handlers/case-law/ingestion/adapters/source-field-inventory-baseline.json";
import { storeTextField } from "@/api/lib/case-law/decision-text";
import {
  czNsFixture,
  czNssFixture,
  czRegionalFixture,
  czUsFixture,
  plSnFixture,
  skCourtsFixture,
  type EnrolledAdapterFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Coverage declaration ─────────────────────────────────

/**
 * What this suite has to drive one adapter with. Enrolment is stated twice on
 * purpose — here and on the adapter itself — and the first assertion below
 * fails when the two disagree, so a fixture cannot quietly go missing for an
 * adapter that declares an inventory.
 */
type AdapterInventoryCoverage =
  | {
      readonly disposition: "enrolled";
      readonly fixture: () => EnrolledAdapterFixture;
    }
  | { readonly disposition: "pending-inventory" };

const PENDING = { disposition: "pending-inventory" } as const;

const ADAPTER_INVENTORY_COVERAGE = {
  [ADAPTER_KEYS.CZ_NS]: { disposition: "enrolled", fixture: czNsFixture },
  [ADAPTER_KEYS.CZ_NSS]: { disposition: "enrolled", fixture: czNssFixture },
  [ADAPTER_KEYS.CZ_US]: { disposition: "enrolled", fixture: czUsFixture },
  [ADAPTER_KEYS.CZ_REGIONAL]: {
    disposition: "enrolled",
    fixture: czRegionalFixture,
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    disposition: "enrolled",
    fixture: skCourtsFixture,
  },
  [ADAPTER_KEYS.SK_US]: PENDING,
  [ADAPTER_KEYS.PL_COURTS]: PENDING,
  [ADAPTER_KEYS.PL_SN]: { disposition: "enrolled", fixture: plSnFixture },
  [ADAPTER_KEYS.AT_COURTS]: PENDING,
  [ADAPTER_KEYS.AT_VFGH]: PENDING,
  [ADAPTER_KEYS.AT_VWGH]: PENDING,
  [ADAPTER_KEYS.AT_BVWG]: PENDING,
  [ADAPTER_KEYS.AT_LVWG]: PENDING,
  [ADAPTER_KEYS.AT_ASYLGH]: PENDING,
  [ADAPTER_KEYS.AT_UBAS]: PENDING,
  [ADAPTER_KEYS.AT_UVS]: PENDING,
  [ADAPTER_KEYS.AT_VERG]: PENDING,
  [ADAPTER_KEYS.AT_UMSE]: PENDING,
  [ADAPTER_KEYS.AT_BKS]: PENDING,
  [ADAPTER_KEYS.AT_FINDOK]: PENDING,
  [ADAPTER_KEYS.EU_ECJ]: PENDING,
} as const satisfies Record<AdapterKey, AdapterInventoryCoverage>;

const DECLARED_ADAPTER_KEYS = Object.values(ADAPTER_KEYS);

const PENDING_BASELINE: readonly string[] = baseline.pendingInventory;

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
  test("the pending baseline names exactly the adapters without an inventory", () => {
    const pending = DECLARED_ADAPTER_KEYS.filter(
      (key) => adapterFor(key).sourceFields.status === "pending-inventory",
    );
    const enrolledButListed = PENDING_BASELINE.filter(
      (key) => !pending.some((candidate) => candidate === key),
    );
    const pendingButUnlisted = pending.filter(
      (key) => !PENDING_BASELINE.includes(key),
    );

    // A ratchet only tightens: an adapter that enrolled leaves the baseline,
    // and a new adapter without an inventory has to be added to it in the
    // same change rather than inheriting the exemption silently.
    expect(
      enrolledButListed,
      `source-field-inventory-baseline.json still lists adapters that now declare an inventory: ${enrolledButListed.join(", ")}. Delete those lines.`,
    ).toEqual([]);
    expect(
      pendingButUnlisted,
      `these adapters call pendingSourceFieldInventory without being in source-field-inventory-baseline.json: ${pendingButUnlisted.join(", ")}. Declare their source fields, or add them to the baseline in this change.`,
    ).toEqual([]);
  });

  test("a pending adapter names itself, so a copied exemption fails", () => {
    const misnamed = DECLARED_ADAPTER_KEYS.flatMap((key) => {
      const { sourceFields } = adapterFor(key);
      return sourceFields.status === "pending-inventory" &&
        sourceFields.adapter !== key
        ? [`${key} claims the exemption of ${sourceFields.adapter}`]
        : [];
    });

    expect(
      misnamed,
      `these adapters declare a pending inventory under another adapter's name: ${misnamed.join("; ")}.`,
    ).toEqual([]);
  });

  for (const key of DECLARED_ADAPTER_KEYS) {
    const coverage = ADAPTER_INVENTORY_COVERAGE[key];

    test(`${key}: its fixture matches how it declares itself`, () => {
      const { status } = adapterFor(key).sourceFields;
      expect(
        coverage.disposition === "enrolled",
        `${key} declares ${status} but this suite has it as ${coverage.disposition}. An adapter with an inventory needs a fixture here to drive it.`,
      ).toBe(status === "declared");
    });

    if (coverage.disposition === "pending-inventory") {
      continue;
    }

    test(`${key}: every field its source states is stored or excluded`, async () => {
      const { sourceFields } = adapterFor(key);
      if (sourceFields.status !== "declared") {
        throw new Error(`${key}: expected a declared inventory`);
      }
      const decision = await coverage.fixture().buildDecision();
      const parts = storedPartsOf(key, decision);

      const stated = sourceFields.listSourceFields(parts);
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

/**
 * The exemption is a closed union, so the checks that keep it shrinking are
 * the compiler's. Each directive below is the assertion: remove it and the
 * build fails, which is what "a new source cannot name itself into the
 * baseline" means.
 */
describe("the inventory exemption cannot grow", () => {
  test("a source registered tomorrow cannot claim it", () => {
    // @ts-expect-error only the adapters on the committed baseline may call this
    const pending = pendingSourceFieldInventory("zz-new-court");

    expect(pending.status).toBe("pending-inventory");
  });

  test("an adapter that enrolled cannot claim it back", () => {
    // @ts-expect-error cz-us left the union when it declared its inventory
    const pending = pendingSourceFieldInventory(ADAPTER_KEYS.CZ_US);

    expect(pending.status).toBe("pending-inventory");
  });
});
