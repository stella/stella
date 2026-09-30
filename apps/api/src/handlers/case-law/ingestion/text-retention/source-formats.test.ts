import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  getAdapter,
  listSourceRegistrations,
  type SourceRegistrationKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { courtListenerConformanceFixture } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/conformance-fixture";
import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
  type AdapterKey,
  type ImportSourceKey,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  czNsFixture,
  czNssFixture,
  czUsFixture,
  czRegionalFixture,
  skCourtsFixture,
  skUsFixture,
  plCourtsFixture,
  plSnFixture,
  plKioFixture,
  plTkFixture,
  plNsaFixture,
  plNcourtFixture,
  atFindokFixture,
  euEcjFixture,
  huBhgyFixture,
  plKisFixture,
  plUodoFixture,
  plUokikFixture,
  atRisFixture,
  type EnrolledAdapterFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

import {
  ADAPTER_SOURCE_FORMATS,
  IMPORT_SOURCE_FORMATS,
  type SourceFormat,
} from "./source-formats";
import { TEXT_FORMAT } from "./types";

/** Real adapter builders, including all twelve Austrian registrations. */
const PRODUCER_FIXTURES = {
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
  [ADAPTER_KEYS.AT_FINDOK]: atFindokFixture,
  [ADAPTER_KEYS.EU_ECJ]: euEcjFixture,
  [ADAPTER_KEYS.HU_BHGY]: huBhgyFixture,
  [ADAPTER_KEYS.PL_KIS]: plKisFixture,
  [ADAPTER_KEYS.PL_UODO]: plUodoFixture,
  [ADAPTER_KEYS.PL_UOKIK]: plUokikFixture,
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
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: courtListenerConformanceFixture,
} as const satisfies Record<
  SourceRegistrationKey,
  () => EnrolledAdapterFixture
>;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** This is transport evidence; it does not assert a pipeline retention verdict. */
describe("registered source text transports", () => {
  test("format contracts cover every registration exactly once", () => {
    expect(Object.keys(PRODUCER_FIXTURES).toSorted()).toEqual(
      listSourceRegistrations()
        .map(({ key }) => key)
        .toSorted(),
    );
    expect(
      [
        ...Object.keys(ADAPTER_SOURCE_FORMATS),
        ...Object.keys(IMPORT_SOURCE_FORMATS),
      ].toSorted(),
    ).toEqual(Object.keys(PRODUCER_FIXTURES).toSorted());
  });

  for (const { key, format } of listSourceRegistrations()) {
    test(`${key} declares a captured decision transport or an explicit raw gap`, async () => {
      const decision = await PRODUCER_FIXTURES[key]().buildDecision();
      const raw =
        decision.sourceRaw ?? panic(`Missing producer raw for ${key}`);
      const parts =
        decodeSourceRawEnvelope(raw) ??
        panic(`Malformed producer envelope for ${key}`);
      const objects = decodeSourceRawEnvelopeObjects(raw);
      const capturedNames = new Set([
        ...Object.keys(parts),
        ...Object.keys(objects ?? {}),
        ...Object.keys(decision.sourceRawObjects ?? {}),
      ]);
      const captured = format.branches.filter(({ recipe }) => {
        if (recipe.type === "unretained" || !capturedNames.has(recipe.part)) {
          return false;
        }
        if (recipe.type === "envelope-base64") {
          return parts[recipe.contentTypePart] === recipe.contentType;
        }
        return true;
      });
      const gaps = format.branches.filter(
        ({ recipe }) => recipe.type === "unretained",
      );
      expect(captured.length + gaps.length).toBeGreaterThan(0);
      for (const { recipe } of gaps) {
        if (recipe.type !== "unretained") {
          continue;
        }
        expect(recipe.reason.trim().length).toBeGreaterThan(0);
        expect(capturedNames.has(recipe.part)).toBe(false);
      }
    });
  }

  test("the AT census records the checkout's actual replay capability", () => {
    const austrian = listSourceRegistrations().filter(({ key }) =>
      key.startsWith("at-"),
    );
    expect(austrian).toHaveLength(12);
    const census = austrian.map(({ key, format }) => ({
      key,
      formats: format.branches.map(({ format: branchFormat }) => branchFormat),
      replay:
        (getAdapter(key) ?? panic(`Missing AT crawler ${key}`))
          .reparseStoredRaw === undefined
          ? "live-only"
          : "stored-raw-replay",
    }));
    expect(
      census.every(({ formats }) => formats.includes(TEXT_FORMAT.XML)),
    ).toBe(true);
  });

  test("a missing crawler entry cannot satisfy the total format contract", () => {
    const { [ADAPTER_KEYS.CZ_NS]: removed, ...incomplete } =
      ADAPTER_SOURCE_FORMATS;
    // @ts-expect-error removing a registered source must fail the total map contract
    incomplete satisfies Record<AdapterKey, SourceFormat>;
    expect(removed.branches.length).toBeGreaterThan(0);
    expect(Object.keys(incomplete)).not.toContain(ADAPTER_KEYS.CZ_NS);
  });

  test("a missing import entry cannot satisfy the total format contract", () => {
    const { [IMPORT_SOURCE_KEYS.COURTLISTENER]: removed, ...incomplete } =
      IMPORT_SOURCE_FORMATS;
    // @ts-expect-error imports have the same mandatory format contract as crawlers
    incomplete satisfies Record<ImportSourceKey, SourceFormat>;
    expect(removed.branches.length).toBeGreaterThan(0);
    expect(Object.keys(incomplete)).not.toContain(
      IMPORT_SOURCE_KEYS.COURTLISTENER,
    );
  });
});
