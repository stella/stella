import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

export type CensusCapability =
  | {
      readonly type: "listing-enumerated";
      readonly unit: string;
      readonly scopeStatus: "full-publisher" | "partial-publisher";
      readonly evidenceRef: string;
    }
  | {
      readonly type: "none-exposed";
      readonly evidence: {
        readonly type: "unverified" | "none-found";
        readonly reason: string;
      };
      readonly evidenceRef: string;
    };

/** Enumeration is the baseline capability; a stated count on the same pages upgrades that observation. */
export const CENSUS_CAPABILITIES = {
  "cz-regional": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/cz-regional.research.md#completeness-census",
  },
  "cz-ns": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/cz-ns.research.md#completeness-census",
  },
  "cz-nss": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/cz-nss.research.md#completeness-census",
  },
  "cz-us": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/cz-us.research.md#completeness-census",
  },
  "sk-courts": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/sk-courts.research.md#completeness-census",
  },
  "sk-us": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/sk-us.research.md#completeness-census",
  },
  "pl-courts": {
    type: "listing-enumerated",
    scopeStatus: "partial-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-courts.research.md#completeness-census",
  },
  "pl-sn": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-sn.research.md#completeness-census",
  },
  "pl-kio": {
    type: "listing-enumerated",
    scopeStatus: "partial-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-kio.research.md#completeness-census",
  },
  "pl-tk": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-tk.research.md#completeness-census",
  },
  "pl-ncourt": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-ncourt.research.md#completeness-census",
  },
  "at-courts": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-courts.research.md#completeness-census",
  },
  "at-vfgh": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-vfgh.research.md#completeness-census",
  },
  "at-vwgh": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-vwgh.research.md#completeness-census",
  },
  "at-bvwg": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-bvwg.research.md#completeness-census",
  },
  "at-lvwg": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-lvwg.research.md#completeness-census",
  },
  "at-asylgh": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-asylgh.research.md#completeness-census",
  },
  "at-ubas": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-ubas.research.md#completeness-census",
  },
  "at-uvs": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-uvs.research.md#completeness-census",
  },
  "at-verg": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-verg.research.md#completeness-census",
  },
  "at-umse": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-umse.research.md#completeness-census",
  },
  "at-bks": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-bks.research.md#completeness-census",
  },
  "at-findok": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/at-findok.research.md#completeness-census",
  },
  "eu-ecj": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "CELEX × language",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/eu-ecj.research.md#completeness-census",
  },
  "hu-bhgy": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "year × kollégium listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/hu-bhgy.research.md#completeness-census",
  },
  "pl-kis": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-kis.research.md#completeness-census",
  },
  "pl-uodo": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-uodo.research.md#completeness-census",
  },
  "pl-uokik": {
    type: "listing-enumerated",
    scopeStatus: "full-publisher",
    unit: "publisher listing identities",
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-uokik.research.md#completeness-census",
  },
  "pl-nsa": {
    type: "none-exposed",
    evidence: {
      type: "unverified",
      reason:
        "The adapter enumerates a pinned third-party snapshot; current original-publisher parity has not been verified.",
    },
    evidenceRef:
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-nsa.research.md#completeness-census",
  },
  "cz-uohs": {
    type: "none-exposed",
    evidence: {
      type: "unverified",
      reason: "Source-wide enumeration has not been independently verified.",
    },
    evidenceRef: "apps/api/src/handlers/case-law/ingestion/adapters/cz-uohs.ts",
  },
  "uk-fcl": {
    type: "none-exposed",
    evidence: {
      type: "unverified",
      reason:
        "The aggregate feed total is not a verified denominator for each year and court slice.",
    },
    evidenceRef: "apps/api/src/handlers/case-law/ingestion/adapters/uk-fcl.ts",
  },
} as const satisfies Record<AdapterKey, CensusCapability>;

const CAPABILITY_BY_KEY: ReadonlyMap<string, CensusCapability> = new Map(
  Object.entries(CENSUS_CAPABILITIES),
);

export const censusCapabilityFor = (
  key: string,
): CensusCapability | undefined => CAPABILITY_BY_KEY.get(key);
