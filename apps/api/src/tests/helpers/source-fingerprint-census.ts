/**
 * Which registered case-law sources write `rawHash` as the fingerprint of what
 * they store.
 *
 * Every source registration is driven through its enrolled fixtures (the same
 * ones the field inventory reads), and each built decision is checked against
 * `sourceFingerprint` over its own stored fields. The driver table is total over
 * the registry, so a source registered without a driver does not compile, and
 * the guard test fails a registration the table does not reach at run time.
 *
 * Building a decision replaces `globalThis.fetch` for some adapters, so a
 * suite using this restores the original in an `afterEach`.
 */

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import type { SourceRegistrationKey } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { courtListenerConformanceFixture } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/conformance-fixture";
import { COURTLISTENER_IMPORT_KEY } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/map";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
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
  plCourtsSearchFixture,
  plKioFixture,
  plKisFixture,
  plNcourtFixture,
  plNsaFixture,
  plSnFixture,
  plTkFixture,
  plUodoFixture,
  plUokikFixture,
  plUokikRulingFixture,
  skCourtsFixture,
  skUsFixture,
  type EnrolledAdapterFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

/** One way of building a decision of a source, named for the baseline key. */
type FingerprintDriver = {
  readonly name: string;
  readonly fixture: () => EnrolledAdapterFixture;
};

const one = (fixture: () => EnrolledAdapterFixture) =>
  [{ name: "decision", fixture }] as const;

const atRis = (key: Parameters<typeof atRisFixture>[0]) =>
  one(() => atRisFixture(key));

/**
 * Total over the registry: a registration missing here is a compile error,
 * and one with an empty list fails the guard test.
 */
export const SOURCE_FINGERPRINT_DRIVERS = {
  [COURTLISTENER_IMPORT_KEY]: one(courtListenerConformanceFixture),
  [ADAPTER_KEYS.CZ_NS]: one(czNsFixture),
  [ADAPTER_KEYS.CZ_NSS]: one(czNssFixture),
  [ADAPTER_KEYS.CZ_US]: one(czUsFixture),
  [ADAPTER_KEYS.CZ_REGIONAL]: one(czRegionalFixture),
  [ADAPTER_KEYS.SK_COURTS]: one(skCourtsFixture),
  [ADAPTER_KEYS.SK_US]: one(skUsFixture),
  [ADAPTER_KEYS.PL_COURTS]: [
    { name: "decision", fixture: plCourtsFixture },
    { name: "search", fixture: plCourtsSearchFixture },
  ],
  [ADAPTER_KEYS.PL_SN]: one(plSnFixture),
  [ADAPTER_KEYS.PL_KIO]: one(plKioFixture),
  [ADAPTER_KEYS.PL_TK]: one(plTkFixture),
  [ADAPTER_KEYS.PL_NSA]: one(plNsaFixture),
  [ADAPTER_KEYS.PL_NCOURT]: one(plNcourtFixture),
  [ADAPTER_KEYS.AT_COURTS]: atRis(ADAPTER_KEYS.AT_COURTS),
  [ADAPTER_KEYS.AT_VFGH]: atRis(ADAPTER_KEYS.AT_VFGH),
  [ADAPTER_KEYS.AT_VWGH]: atRis(ADAPTER_KEYS.AT_VWGH),
  [ADAPTER_KEYS.AT_BVWG]: atRis(ADAPTER_KEYS.AT_BVWG),
  [ADAPTER_KEYS.AT_LVWG]: atRis(ADAPTER_KEYS.AT_LVWG),
  [ADAPTER_KEYS.AT_ASYLGH]: atRis(ADAPTER_KEYS.AT_ASYLGH),
  [ADAPTER_KEYS.AT_UBAS]: atRis(ADAPTER_KEYS.AT_UBAS),
  [ADAPTER_KEYS.AT_UVS]: atRis(ADAPTER_KEYS.AT_UVS),
  [ADAPTER_KEYS.AT_VERG]: atRis(ADAPTER_KEYS.AT_VERG),
  [ADAPTER_KEYS.AT_UMSE]: atRis(ADAPTER_KEYS.AT_UMSE),
  [ADAPTER_KEYS.AT_BKS]: atRis(ADAPTER_KEYS.AT_BKS),
  [ADAPTER_KEYS.AT_FINDOK]: one(atFindokFixture),
  [ADAPTER_KEYS.EU_ECJ]: one(euEcjFixture),
  [ADAPTER_KEYS.HU_BHGY]: one(huBhgyFixture),
  [ADAPTER_KEYS.PL_KIS]: one(plKisFixture),
  [ADAPTER_KEYS.PL_UODO]: one(plUodoFixture),
  [ADAPTER_KEYS.PL_UOKIK]: [
    { name: "decision", fixture: plUokikFixture },
    { name: "ruling", fixture: plUokikRulingFixture },
  ],
} as const satisfies Record<
  SourceRegistrationKey,
  readonly FingerprintDriver[]
>;

/**
 * How a built decision's `rawHash` relates to what it stores.
 *
 * `covers` is the only conforming outcome. The other three name what the hash
 * leaves out, which is what a baseline row records.
 */
export type FingerprintFinding =
  | { readonly type: "covers" }
  | { readonly type: "no-envelope" }
  | { readonly type: "objects-not-covered" }
  | { readonly type: "not-from-stored-bytes" };

/**
 * The envelope as the adapter encoded it.
 *
 * The pipeline fills the envelope's `objects` map in with the address it wrote
 * each object at, and some fixtures do the same to mirror a stored row. The
 * adapter hashed the envelope before that, and the addresses are derived from
 * the object bytes the fingerprint already covers.
 */
const emittedEnvelope = (
  decision: Pick<IngestionResult, "sourceRaw" | "sourceRawObjects">,
): string | undefined => {
  const { sourceRaw, sourceRawObjects } = decision;
  if (sourceRaw === undefined || sourceRawObjects === undefined) {
    return sourceRaw;
  }
  const parts = decodeSourceRawEnvelope(sourceRaw);
  return parts === null ? sourceRaw : encodeSourceRawEnvelope(parts);
};

export const fingerprintFinding = (
  decision: Pick<IngestionResult, "rawHash" | "sourceRaw" | "sourceRawObjects">,
): FingerprintFinding => {
  const envelope = emittedEnvelope(decision);
  if (envelope === undefined) {
    return { type: "no-envelope" };
  }
  if (
    decision.rawHash ===
    sourceFingerprint({
      sourceRaw: envelope,
      sourceRawObjects: decision.sourceRawObjects,
    })
  ) {
    return { type: "covers" };
  }
  return decision.rawHash === sourceFingerprint({ sourceRaw: envelope })
    ? { type: "objects-not-covered" }
    : { type: "not-from-stored-bytes" };
};

/** The baseline reason a generated row carries for each finding. */
export const FINGERPRINT_FINDING_REASONS = {
  "no-envelope":
    "Builds this decision without envelope text; store the source in an envelope and derive rawHash with sourceFingerprint.",
  "objects-not-covered":
    "rawHash is derived from the envelope only; pass the objects stored beside it to sourceFingerprint.",
  "not-from-stored-bytes":
    "rawHash is derived from part of the stored source; derive it with sourceFingerprint over the stored envelope and objects.",
} as const satisfies Record<
  Exclude<FingerprintFinding["type"], "covers">,
  string
>;

export type FingerprintCensusRow = {
  /** `<registration>::<driver>`; no line numbers, so it survives edits. */
  readonly key: string;
  readonly finding: FingerprintFinding;
};

/** Every driver of every registration, with what its decision's hash covers. */
export const sourceFingerprintCensus = async (): Promise<
  FingerprintCensusRow[]
> => {
  const rows: FingerprintCensusRow[] = [];
  for (const [registration, drivers] of Object.entries(
    SOURCE_FINGERPRINT_DRIVERS,
  )) {
    for (const { name, fixture } of drivers) {
      // Sequential: fixtures replace the shared fetch while they build.
      const decision = await fixture().buildDecision();
      rows.push({
        key: `${registration}::${name}`,
        finding: fingerprintFinding(decision),
      });
    }
  }
  // Ordinal order over unique identifier keys, as the baseline sorts them.
  return rows.toSorted((left, right) => (left.key < right.key ? -1 : 1));
};
