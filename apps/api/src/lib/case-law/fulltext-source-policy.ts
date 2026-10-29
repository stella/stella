import { panic } from "better-result";

import { DAY_IN_MS } from "@stll/time";

import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
} from "@/api/lib/legal-search/ingestion-constants";
import type {
  AdapterKey,
  ImportSourceKey,
} from "@/api/lib/legal-search/ingestion-constants";

export const FULLTEXT_RECOVERY_KIND = {
  LISTING: "listing",
  DEFERRED_PDF: "deferred_pdf",
  IMPORT: "import",
} as const;

type FulltextSourcePolicy = {
  recovery: (typeof FULLTEXT_RECOVERY_KIND)[keyof typeof FULLTEXT_RECOVERY_KIND];
  retryFloorMs: number;
  failedThreshold: number;
};

const listing = {
  recovery: FULLTEXT_RECOVERY_KIND.LISTING,
  retryFloorMs: DAY_IN_MS / 96,
  failedThreshold: 100,
} as const;
const deferredPdf = {
  recovery: FULLTEXT_RECOVERY_KIND.DEFERRED_PDF,
  retryFloorMs: DAY_IN_MS / 48,
  failedThreshold: 1000,
} as const;

/** Every registered source must choose a recovery path and operational threshold. */
export const FULLTEXT_SOURCE_POLICIES = {
  [ADAPTER_KEYS.CZ_REGIONAL]: listing,
  [ADAPTER_KEYS.CZ_NS]: listing,
  [ADAPTER_KEYS.CZ_NSS]: listing,
  [ADAPTER_KEYS.CZ_US]: listing,
  [ADAPTER_KEYS.CZ_UOHS]: listing,
  [ADAPTER_KEYS.SK_COURTS]: deferredPdf,
  [ADAPTER_KEYS.SK_US]: listing,
  [ADAPTER_KEYS.PL_COURTS]: listing,
  [ADAPTER_KEYS.PL_SN]: listing,
  [ADAPTER_KEYS.PL_KIO]: listing,
  [ADAPTER_KEYS.PL_TK]: listing,
  [ADAPTER_KEYS.PL_NSA]: listing,
  [ADAPTER_KEYS.PL_NCOURT]: listing,
  [ADAPTER_KEYS.AT_COURTS]: listing,
  [ADAPTER_KEYS.AT_VFGH]: listing,
  [ADAPTER_KEYS.AT_VWGH]: listing,
  [ADAPTER_KEYS.AT_BVWG]: listing,
  [ADAPTER_KEYS.AT_LVWG]: listing,
  [ADAPTER_KEYS.AT_ASYLGH]: listing,
  [ADAPTER_KEYS.AT_UBAS]: listing,
  [ADAPTER_KEYS.AT_UVS]: listing,
  [ADAPTER_KEYS.AT_VERG]: listing,
  [ADAPTER_KEYS.AT_UMSE]: listing,
  [ADAPTER_KEYS.AT_BKS]: listing,
  [ADAPTER_KEYS.AT_FINDOK]: listing,
  [ADAPTER_KEYS.EU_ECJ]: listing,
  [ADAPTER_KEYS.HU_BHGY]: listing,
  [ADAPTER_KEYS.UK_FCL]: listing,
  [ADAPTER_KEYS.PL_KIS]: listing,
  [ADAPTER_KEYS.PL_UODO]: listing,
  [ADAPTER_KEYS.PL_UOKIK]: listing,
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: {
    recovery: FULLTEXT_RECOVERY_KIND.IMPORT,
    retryFloorMs: DAY_IN_MS,
    failedThreshold: 100,
  },
} as const satisfies Record<AdapterKey | ImportSourceKey, FulltextSourcePolicy>;

export const fulltextPolicyForSource = (
  source: string,
): FulltextSourcePolicy => {
  const entry = Object.entries(FULLTEXT_SOURCE_POLICIES).find(
    ([key]) => key === source,
  );
  if (entry === undefined) {
    return panic(`Unregistered full-text source policy: ${source}`);
  }
  return entry[1];
};
