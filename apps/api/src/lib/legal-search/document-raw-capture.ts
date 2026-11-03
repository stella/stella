import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

/** The envelope locations that keep fetched document responses, before parsing. */
type DocumentRawCapture =
  | {
      readonly type: "inline";
      readonly parts: readonly [string, ...string[]];
      readonly objectPrefixes: readonly string[];
    }
  | {
      readonly type: "deferred";
      readonly owner: "sk-document-backfill";
      readonly objectPart: "document-pdf";
    };

const document = {
  type: "inline",
  parts: ["document"],
  objectPrefixes: [],
} as const satisfies DocumentRawCapture;
const ris = {
  type: "inline",
  parts: ["document-xml"],
  objectPrefixes: [],
} as const satisfies DocumentRawCapture;

/**
 * Adding a source requires a storage decision. The conformance suite reads
 * these locations from decisions built by the adapters, so a declaration
 * without captured bytes cannot pass merely by naming an envelope part.
 * Prefixes account for publisher-ordered attachments of arbitrary length.
 */
export const DOCUMENT_RAW_CAPTURE = {
  [ADAPTER_KEYS.CZ_REGIONAL]: document,
  [ADAPTER_KEYS.CZ_NS]: {
    type: "inline",
    parts: ["print"],
    objectPrefixes: [],
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    type: "inline",
    parts: ["document", "text", "extended-chamber-pdf-base64"],
    objectPrefixes: [],
  },
  [ADAPTER_KEYS.CZ_US]: document,
  [ADAPTER_KEYS.CZ_UOHS]: {
    type: "inline",
    parts: ["document"],
    objectPrefixes: ["document"],
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    type: "deferred",
    owner: "sk-document-backfill",
    objectPart: "document-pdf",
  },
  [ADAPTER_KEYS.SK_US]: {
    type: "inline",
    parts: ["document"],
    objectPrefixes: ["document-file"],
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    type: "inline",
    parts: ["listing-dump", "detail"],
    objectPrefixes: [],
  },
  [ADAPTER_KEYS.PL_SN]: document,
  [ADAPTER_KEYS.PL_KIO]: document,
  [ADAPTER_KEYS.PL_TK]: {
    type: "inline",
    parts: ["case-page"],
    objectPrefixes: [],
  },
  [ADAPTER_KEYS.PL_NSA]: {
    type: "inline",
    parts: ["row"],
    objectPrefixes: [],
  },
  [ADAPTER_KEYS.PL_NCOURT]: document,
  [ADAPTER_KEYS.AT_COURTS]: ris,
  [ADAPTER_KEYS.AT_VFGH]: ris,
  [ADAPTER_KEYS.AT_VWGH]: ris,
  [ADAPTER_KEYS.AT_BVWG]: ris,
  [ADAPTER_KEYS.AT_LVWG]: ris,
  [ADAPTER_KEYS.AT_ASYLGH]: ris,
  [ADAPTER_KEYS.AT_UBAS]: ris,
  [ADAPTER_KEYS.AT_UVS]: ris,
  [ADAPTER_KEYS.AT_VERG]: ris,
  [ADAPTER_KEYS.AT_UMSE]: ris,
  [ADAPTER_KEYS.AT_BKS]: ris,
  [ADAPTER_KEYS.AT_FINDOK]: ris,
  [ADAPTER_KEYS.EU_ECJ]: {
    type: "inline",
    parts: ["document", "formex"],
    objectPrefixes: [],
  },
  [ADAPTER_KEYS.HU_BHGY]: document,
  [ADAPTER_KEYS.UK_FCL]: document,
  [ADAPTER_KEYS.PL_KIS]: {
    type: "inline",
    parts: ["detail"],
    objectPrefixes: ["document-pdf"],
  },
  [ADAPTER_KEYS.PL_UODO]: {
    type: "inline",
    parts: ["body-xml"],
    objectPrefixes: [],
  },
  [ADAPTER_KEYS.PL_UOKIK]: {
    type: "inline",
    parts: ["detail"],
    objectPrefixes: ["decision-file", "ruling-file"],
  },
} as const satisfies Record<AdapterKey, DocumentRawCapture>;
