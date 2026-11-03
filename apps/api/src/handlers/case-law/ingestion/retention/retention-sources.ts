import { courtListenerValidationPolicy } from "@/api/handlers/case-law/ingestion/parsers/courtlistener/validation-policy";
import {
  RETENTION_UNPARSED_REASON,
  type RetentionPolicy,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { atFindokRetention } from "@/api/handlers/case-law/ingestion/retention/sources/at-findok";
import { atRisRetention } from "@/api/handlers/case-law/ingestion/retention/sources/at-ris";
import { czNsRetention } from "@/api/handlers/case-law/ingestion/retention/sources/cz-ns";
import { czNssRetention } from "@/api/handlers/case-law/ingestion/retention/sources/cz-nss";
import { czRegionalRetention } from "@/api/handlers/case-law/ingestion/retention/sources/cz-regional";
import { czUohsRetention } from "@/api/handlers/case-law/ingestion/retention/sources/cz-uohs";
import { czUsRetention } from "@/api/handlers/case-law/ingestion/retention/sources/cz-us";
import { euEcjRetention } from "@/api/handlers/case-law/ingestion/retention/sources/eu-ecj";
import { huBhgyRetention } from "@/api/handlers/case-law/ingestion/retention/sources/hu-bhgy";
import { plCourtsRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-courts";
import { plKioRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-kio";
import { plKisRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-kis";
import { plNcourtRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-ncourt";
import { plNsaRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-nsa";
import { plSnRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-sn";
import { plTkRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-tk";
import { plUodoRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-uodo";
import { plUokikRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-uokik";
import { skCourtsRetention } from "@/api/handlers/case-law/ingestion/retention/sources/sk-courts";
import { skUsRetention } from "@/api/handlers/case-law/ingestion/retention/sources/sk-us";
import { ukFclRetention } from "@/api/handlers/case-law/ingestion/retention/sources/uk-fcl";
import { usCourtlistenerRetention } from "@/api/handlers/case-law/ingestion/retention/sources/us-courtlistener";
import {
  ADAPTER_KEYS,
  type AdapterKey,
  IMPORT_SOURCE_KEYS,
  type ImportSourceKey,
} from "@/api/lib/legal-search/ingestion-constants";
import type { ValidationSourcePolicy } from "@/api/lib/legal-search/parsers/validate-ast";

/**
 * Every registered source's retention policy. Total over the adapter and
 * import keys, so a new source cannot register without stating how its
 * decisions are checked against what its publisher served.
 */
const RETENTION_POLICIES = {
  [ADAPTER_KEYS.CZ_REGIONAL]: czRegionalRetention,
  [ADAPTER_KEYS.CZ_NS]: czNsRetention,
  [ADAPTER_KEYS.CZ_NSS]: czNssRetention,
  [ADAPTER_KEYS.CZ_US]: czUsRetention,
  [ADAPTER_KEYS.CZ_UOHS]: czUohsRetention,
  [ADAPTER_KEYS.SK_COURTS]: skCourtsRetention,
  [ADAPTER_KEYS.SK_US]: skUsRetention,
  [ADAPTER_KEYS.PL_COURTS]: plCourtsRetention,
  [ADAPTER_KEYS.PL_SN]: plSnRetention,
  [ADAPTER_KEYS.PL_KIO]: plKioRetention,
  [ADAPTER_KEYS.PL_TK]: plTkRetention,
  [ADAPTER_KEYS.PL_NSA]: plNsaRetention,
  [ADAPTER_KEYS.PL_NCOURT]: plNcourtRetention,
  [ADAPTER_KEYS.AT_COURTS]: atRisRetention,
  [ADAPTER_KEYS.AT_VFGH]: atRisRetention,
  [ADAPTER_KEYS.AT_VWGH]: atRisRetention,
  [ADAPTER_KEYS.AT_BVWG]: atRisRetention,
  [ADAPTER_KEYS.AT_LVWG]: atRisRetention,
  [ADAPTER_KEYS.AT_ASYLGH]: atRisRetention,
  [ADAPTER_KEYS.AT_UBAS]: atRisRetention,
  [ADAPTER_KEYS.AT_UVS]: atRisRetention,
  [ADAPTER_KEYS.AT_VERG]: atRisRetention,
  [ADAPTER_KEYS.AT_UMSE]: atRisRetention,
  [ADAPTER_KEYS.AT_BKS]: atRisRetention,
  [ADAPTER_KEYS.AT_FINDOK]: atFindokRetention,
  [ADAPTER_KEYS.EU_ECJ]: euEcjRetention,
  [ADAPTER_KEYS.HU_BHGY]: huBhgyRetention,
  [ADAPTER_KEYS.PL_KIS]: plKisRetention,
  [ADAPTER_KEYS.PL_UODO]: plUodoRetention,
  [ADAPTER_KEYS.PL_UOKIK]: plUokikRetention,
  [ADAPTER_KEYS.UK_FCL]: ukFclRetention,
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: usCourtlistenerRetention,
} as const satisfies Record<AdapterKey | ImportSourceKey, RetentionPolicy>;

/** The map as a stored `adapter_key` addresses it: an arbitrary string. */
const RETENTION_POLICY_BY_KEY: Readonly<Record<string, RetentionPolicy>> =
  RETENTION_POLICIES;

const UNREGISTERED_SOURCE: RetentionPolicy = {
  type: "unparsed",
  reason: RETENTION_UNPARSED_REASON.UNREGISTERED_SOURCE,
};

/**
 * How the oracle reads a source's text on both sides, where it reads it
 * differently from the default. It is the parser's policy too (the parser
 * measures its candidates with it), so it is attached here rather than in
 * the projection, which may not reach parser code.
 */
const SOURCE_POLICIES: Readonly<
  Partial<Record<AdapterKey | ImportSourceKey, ValidationSourcePolicy>>
> = {
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: courtListenerValidationPolicy,
};

/** What a decision of this source was declared to be checked against. */
export type SourceRetention = {
  readonly adapterKey: string;
  readonly policy: RetentionPolicy;
  readonly sourcePolicy: ValidationSourcePolicy | undefined;
};

/**
 * Callers carry the adapter identity. A seeded source no adapter was written
 * for declares nothing, and any document it produces is reported as
 * unverifiable rather than passed unchecked.
 */
export const sourceRetentionForAdapter = (
  adapterKey: string,
): SourceRetention => ({
  adapterKey,
  // Own properties only: an object literal would answer `toString` too.
  policy: Object.hasOwn(RETENTION_POLICY_BY_KEY, adapterKey)
    ? (RETENTION_POLICY_BY_KEY[adapterKey] ?? UNREGISTERED_SOURCE)
    : UNREGISTERED_SOURCE,
  sourcePolicy: Object.entries(SOURCE_POLICIES).find(
    ([key]) => key === adapterKey,
  )?.[1],
});
