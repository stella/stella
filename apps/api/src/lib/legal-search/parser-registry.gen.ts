// Generated from parser-entries/*.json by scripts/generate-parser-registry.ts.
import type { ParserVersionScopes } from "./parser-reparse-scopes";

export const ADAPTER_KEYS = {
  AT_ASYLGH: "at-asylgh",

  AT_BKS: "at-bks",

  AT_BVWG: "at-bvwg",

  AT_COURTS: "at-courts",

  AT_FINDOK: "at-findok",

  AT_LVWG: "at-lvwg",

  AT_UBAS: "at-ubas",

  AT_UMSE: "at-umse",

  AT_UVS: "at-uvs",

  AT_VERG: "at-verg",

  AT_VFGH: "at-vfgh",

  AT_VWGH: "at-vwgh",

  CZ_NS: "cz-ns",

  CZ_NSS: "cz-nss",

  CZ_REGIONAL: "cz-regional",

  CZ_UOHS: "cz-uohs",

  CZ_US: "cz-us",

  EU_ECJ: "eu-ecj",

  HU_BHGY: "hu-bhgy",

  PL_COURTS: "pl-courts",

  PL_KIO: "pl-kio",

  PL_KIS: "pl-kis",

  PL_NCOURT: "pl-ncourt",

  PL_NSA: "pl-nsa",

  PL_SN: "pl-sn",

  PL_TK: "pl-tk",

  PL_UODO: "pl-uodo",

  PL_UOKIK: "pl-uokik",

  SK_COURTS: "sk-courts",

  SK_US: "sk-us",

  UK_FCL: "uk-fcl",
} as const;
export const IMPORT_SOURCE_KEYS = {
  COURTLISTENER: "us-courtlistener",
} as const;
export const PARSER_VERSIONS = {
  [ADAPTER_KEYS.AT_ASYLGH]: 13,

  [ADAPTER_KEYS.AT_BKS]: 13,

  [ADAPTER_KEYS.AT_BVWG]: 13,

  [ADAPTER_KEYS.AT_COURTS]: 13,

  [ADAPTER_KEYS.AT_FINDOK]: 15,

  [ADAPTER_KEYS.AT_LVWG]: 13,

  [ADAPTER_KEYS.AT_UBAS]: 13,

  [ADAPTER_KEYS.AT_UMSE]: 13,

  [ADAPTER_KEYS.AT_UVS]: 13,

  [ADAPTER_KEYS.AT_VERG]: 13,

  [ADAPTER_KEYS.AT_VFGH]: 13,

  [ADAPTER_KEYS.AT_VWGH]: 13,

  [ADAPTER_KEYS.CZ_NS]: 32,

  [ADAPTER_KEYS.CZ_NSS]: 38,

  [ADAPTER_KEYS.CZ_REGIONAL]: 27,

  [ADAPTER_KEYS.CZ_UOHS]: 16,

  [ADAPTER_KEYS.CZ_US]: 44,

  [ADAPTER_KEYS.EU_ECJ]: 27,

  [ADAPTER_KEYS.HU_BHGY]: 31,

  [ADAPTER_KEYS.PL_COURTS]: 38,

  [ADAPTER_KEYS.PL_KIO]: 32,

  [ADAPTER_KEYS.PL_KIS]: 34,

  [ADAPTER_KEYS.PL_NCOURT]: 38,

  [ADAPTER_KEYS.PL_NSA]: 12,

  [ADAPTER_KEYS.PL_SN]: 32,

  [ADAPTER_KEYS.PL_TK]: 14,

  [ADAPTER_KEYS.PL_UODO]: 20,

  [ADAPTER_KEYS.PL_UOKIK]: 36,

  [ADAPTER_KEYS.SK_COURTS]: 33,

  [ADAPTER_KEYS.SK_US]: 29,

  [ADAPTER_KEYS.UK_FCL]: 7,
} as const satisfies Record<AdapterKey, number>;
export const SOURCE_FINGERPRINT_VERSIONS = {
  [ADAPTER_KEYS.AT_ASYLGH]: 0,

  [ADAPTER_KEYS.AT_BKS]: 0,

  [ADAPTER_KEYS.AT_BVWG]: 0,

  [ADAPTER_KEYS.AT_COURTS]: 0,

  [ADAPTER_KEYS.AT_FINDOK]: 0,

  [ADAPTER_KEYS.AT_LVWG]: 0,

  [ADAPTER_KEYS.AT_UBAS]: 0,

  [ADAPTER_KEYS.AT_UMSE]: 0,

  [ADAPTER_KEYS.AT_UVS]: 0,

  [ADAPTER_KEYS.AT_VERG]: 0,

  [ADAPTER_KEYS.AT_VFGH]: 0,

  [ADAPTER_KEYS.AT_VWGH]: 0,

  [ADAPTER_KEYS.CZ_NS]: 0,

  [ADAPTER_KEYS.CZ_NSS]: 0,

  [ADAPTER_KEYS.CZ_REGIONAL]: 0,

  [ADAPTER_KEYS.CZ_UOHS]: 0,

  [ADAPTER_KEYS.CZ_US]: 0,

  [ADAPTER_KEYS.EU_ECJ]: 0,

  [ADAPTER_KEYS.HU_BHGY]: 0,

  [ADAPTER_KEYS.PL_COURTS]: 0,

  [ADAPTER_KEYS.PL_KIO]: 0,

  [ADAPTER_KEYS.PL_KIS]: 0,

  [ADAPTER_KEYS.PL_NCOURT]: 0,

  [ADAPTER_KEYS.PL_NSA]: 0,

  [ADAPTER_KEYS.PL_SN]: 0,

  [ADAPTER_KEYS.PL_TK]: 0,

  [ADAPTER_KEYS.PL_UODO]: 0,

  [ADAPTER_KEYS.PL_UOKIK]: 0,

  [ADAPTER_KEYS.SK_COURTS]: 0,

  [ADAPTER_KEYS.SK_US]: 0,

  [ADAPTER_KEYS.UK_FCL]: 0,

  [IMPORT_SOURCE_KEYS.COURTLISTENER]: 0,
} as const satisfies Record<AdapterKey | ImportSourceKey, number>;
export const PARSER_VERSION_SCOPES = {
  [ADAPTER_KEYS.AT_ASYLGH]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_ASYLGH], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_BKS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_BKS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_BVWG]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_BVWG], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_COURTS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_COURTS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_FINDOK]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_FINDOK], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_LVWG]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_LVWG], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_UBAS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_UBAS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_UMSE]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_UMSE], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_UVS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_UVS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_VERG]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_VERG], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_VFGH]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_VFGH], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.AT_VWGH]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_VWGH], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.CZ_NS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.CZ_NSS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.CZ_REGIONAL]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_REGIONAL], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.CZ_UOHS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_UOHS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.CZ_US]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_US], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.EU_ECJ]: { version: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.HU_BHGY]: { version: PARSER_VERSIONS[ADAPTER_KEYS.HU_BHGY], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_COURTS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_COURTS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_KIO]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_KIO], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_KIS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_KIS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_NCOURT]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_NCOURT], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_NSA]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_NSA], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_SN]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_SN], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_TK]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_TK], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_UODO]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_UODO], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_UOKIK]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_UOKIK], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.SK_COURTS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.SK_US]: { version: PARSER_VERSIONS[ADAPTER_KEYS.SK_US], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.UK_FCL]: { version: PARSER_VERSIONS[ADAPTER_KEYS.UK_FCL], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];
export type ImportSourceKey = (typeof IMPORT_SOURCE_KEYS)[keyof typeof IMPORT_SOURCE_KEYS];
