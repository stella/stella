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

  [ADAPTER_KEYS.CZ_NSS]: 39,

  [ADAPTER_KEYS.CZ_REGIONAL]: 27,

  [ADAPTER_KEYS.CZ_UOHS]: 17,

  [ADAPTER_KEYS.CZ_US]: 44,

  [ADAPTER_KEYS.EU_ECJ]: 27,

  [ADAPTER_KEYS.HU_BHGY]: 31,

  [ADAPTER_KEYS.PL_COURTS]: 38,

  [ADAPTER_KEYS.PL_KIO]: 32,

  [ADAPTER_KEYS.PL_KIS]: 35,

  [ADAPTER_KEYS.PL_NCOURT]: 39,

  [ADAPTER_KEYS.PL_NSA]: 12,

  [ADAPTER_KEYS.PL_SN]: 32,

  [ADAPTER_KEYS.PL_TK]: 14,

  [ADAPTER_KEYS.PL_UODO]: 21,

  [ADAPTER_KEYS.PL_UOKIK]: 37,

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

  [ADAPTER_KEYS.CZ_NSS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS], scope: {"type":"all","reason":"Recompute publisher field occurrences, table tuples and references from every held detail page; document-only legacy raw retains its existing metadata."} },

  [ADAPTER_KEYS.CZ_REGIONAL]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_REGIONAL], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.CZ_UOHS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_UOHS], scope: {"type":"all","reason":"Revalidate publisher head-matter ordering and recompute printed paragraph labels from stored raw: local duplicate or OCR markers preserve surrounding labels, and Czech and Slovak separate opinions have independent numbering scopes. AST roles and labels have no separate feature storage. Re-read legacy, suffixed and Unicode Adobe Glyph List names from stored PDF bytes; extraction has no separate feature storage. Re-read the body and footnotes from stored PDF bytes through the shared PDF band reader: running headers, barcodes and page numbers leave the body by their shape, footnotes are read off each page's foot with their raised references as linked superscripts, and printed lines join into paragraphs across page breaks; the AST has no separate feature storage. Block text folds letter-spaced emphasis through the one shared reading, which also reads a short spaced word beside a spaced word and treats a no-break space as a word gap; only whitespace in block text changes and it has no feature storage of its own. Re-derive the file number with its year from the export record (older rows state only the serial), the issue date from the reference-number letterhead line, and the decision type from the printed title, typing its absence when none is printed; the identifiers and the case number have no separate feature storage. Roles are recomputed from stored PDF bytes through the shared Czech grammar of an authority's decision: the head matter up to the lead-in (rozhodl takto:, ROZHODNUTÍ:) is intro, the operative part after it is holding, the reasons from their heading carry no ruling role, the document barcode is apparatus and the head of the Office signs under its office; the title, the reasons and instruction headings and the reasons' Roman section titles are headings. Roles and headings have no feature storage of their own. Printed paragraph labels are read by one grammar: a label opens a paragraph except inside a date wrapped after its day or after a word its number belongs to, sub-paragraphs (`5.5.`) open their own and count as items beside the court's numbering, and positioned-line paragraphs are read by the one line-join owner; block text, boundaries and numbers are recomputed from stored raw and have no feature storage of their own. Court paragraph numbers are re-read from stored raw: a run that counts up by one from its start to within a closing line of the reasoning's end is numbered however much unnumbered text lies between its numbers, the lead-in before the first number is counted from the end of the operative part, and the one paragraph that opens the reasoning before a printed 2 is numbered 1; paragraph numbers have no feature storage of their own. The reference number is kept as a lookup identifier only when it fits the identifier bound: a joined proceeding's reference number that lists every joined file is left out rather than cut, and the file number stays the decision's identity; identifiers have no separate feature storage."} },

  [ADAPTER_KEYS.CZ_US]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_US], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.EU_ECJ]: { version: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.HU_BHGY]: { version: PARSER_VERSIONS[ADAPTER_KEYS.HU_BHGY], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_COURTS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_COURTS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_KIO]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_KIO], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_KIS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_KIS], scope: {"type":"all","reason":"Retain the publisher's excluded fields in the stored record instead of naming them as exclusions. Read a parliamentary answer's question (TRESC_INTERP_ZAPYT) before its text, and a newsletter's own text (TRESC_NEWS), into the document. Drop lines that only link back within the document, and join a footnote's line its sentence runs across."} },

  [ADAPTER_KEYS.PL_NCOURT]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_NCOURT], scope: {"type":"all","reason":"Retain the publisher's excluded fields in the stored record instead of naming them as exclusions."} },

  [ADAPTER_KEYS.PL_NSA]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_NSA], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_SN]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_SN], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_TK]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_TK], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.PL_UODO]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_UODO], scope: {"type":"all","reason":"Retain the publisher's excluded fields in the stored record instead of naming them as exclusions."} },

  [ADAPTER_KEYS.PL_UOKIK]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_UOKIK], scope: {"type":"all","reason":"Retain the publisher's excluded fields in the stored record instead of naming them as exclusions."} },

  [ADAPTER_KEYS.SK_COURTS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.SK_US]: { version: PARSER_VERSIONS[ADAPTER_KEYS.SK_US], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },

  [ADAPTER_KEYS.UK_FCL]: { version: PARSER_VERSIONS[ADAPTER_KEYS.UK_FCL], scope: {"type":"all","reason":"Dependency patch tracking only: @tanstack/ai is reached through the desktop runner wire schema in transaction infrastructure, not parser execution. No parser-owned value changes; the matching no-stored-row-effect declaration requires no replay."} },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];
export type ImportSourceKey = (typeof IMPORT_SOURCE_KEYS)[keyof typeof IMPORT_SOURCE_KEYS];
