import { AT_RIS_HEADNOTE_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/at-courts.metadata-urls";
import { EU_ECJ_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj.metadata-urls";
import { PL_COURTS_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/pl-courts.metadata-urls";
import { PL_KIS_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/pl-kis.metadata-urls";
import { PL_NSA_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa.metadata-urls";
import { PL_TK_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/pl-tk.metadata-urls";
import { PL_UOKIK_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/pl-uokik.metadata-urls";
import { SK_COURTS_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/sk-courts.metadata-urls";
import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
  type AdapterKey,
  type ImportSourceKey,
} from "@/api/lib/legal-search/ingestion-constants";

const DOCUMENT_SUPPLEMENTS_METADATA_URL_SCHEMA = {
  documentSupplements: { items: { sourceUrl: "url" } },
} as const;

/** Pure companion imports avoid the eager adapter registry and its source clients. */
export const METADATA_URL_SCHEMAS = {
  [ADAPTER_KEYS.CZ_REGIONAL]: undefined,
  [ADAPTER_KEYS.CZ_NS]: undefined,
  [ADAPTER_KEYS.CZ_NSS]: undefined,
  [ADAPTER_KEYS.CZ_US]: undefined,
  [ADAPTER_KEYS.SK_COURTS]: SK_COURTS_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.SK_US]: undefined,
  [ADAPTER_KEYS.PL_COURTS]: {
    ...PL_COURTS_METADATA_URL_SCHEMA,
    ...DOCUMENT_SUPPLEMENTS_METADATA_URL_SCHEMA,
  },
  [ADAPTER_KEYS.PL_SN]: undefined,
  [ADAPTER_KEYS.PL_KIO]: undefined,
  [ADAPTER_KEYS.PL_TK]: PL_TK_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.PL_NSA]: PL_NSA_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.PL_NCOURT]: DOCUMENT_SUPPLEMENTS_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_COURTS]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_VFGH]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_VWGH]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_BVWG]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_LVWG]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_ASYLGH]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_UBAS]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_UVS]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_VERG]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_UMSE]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_BKS]: AT_RIS_HEADNOTE_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.AT_FINDOK]: undefined,
  [ADAPTER_KEYS.EU_ECJ]: EU_ECJ_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.HU_BHGY]: undefined,
  [ADAPTER_KEYS.PL_KIS]: PL_KIS_METADATA_URL_SCHEMA,
  [ADAPTER_KEYS.PL_UODO]: undefined,
  [ADAPTER_KEYS.PL_UOKIK]: PL_UOKIK_METADATA_URL_SCHEMA,
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: undefined,
} as const satisfies Record<AdapterKey | ImportSourceKey, unknown>;

/** Callers carry the adapter identity; metadata values never select their own contract. */
export const metadataUrlSchemaForAdapter = (adapterKey: string): unknown => {
  if (!Object.hasOwn(METADATA_URL_SCHEMAS, adapterKey)) {
    return undefined;
  }
  return Reflect.get(METADATA_URL_SCHEMAS, adapterKey);
};

export const composedMetadataUrlSchema = (schema?: unknown) => ({
  ...(typeof schema === "object" && schema !== null ? schema : {}),
  ...DOCUMENT_SUPPLEMENTS_METADATA_URL_SCHEMA,
});
