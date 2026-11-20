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

  BR_TJDFT: "br-tjdft",

  BR_TST: "br-tst",

  CZ_NS_SBIRKA: "cz-ns-sbirka",

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
  [ADAPTER_KEYS.AT_ASYLGH]: 14,

  [ADAPTER_KEYS.AT_BKS]: 14,

  [ADAPTER_KEYS.AT_BVWG]: 14,

  [ADAPTER_KEYS.AT_COURTS]: 14,

  [ADAPTER_KEYS.AT_FINDOK]: 16,

  [ADAPTER_KEYS.AT_LVWG]: 14,

  [ADAPTER_KEYS.AT_UBAS]: 14,

  [ADAPTER_KEYS.AT_UMSE]: 14,

  [ADAPTER_KEYS.AT_UVS]: 14,

  [ADAPTER_KEYS.AT_VERG]: 14,

  [ADAPTER_KEYS.AT_VFGH]: 14,

  [ADAPTER_KEYS.AT_VWGH]: 14,

  [ADAPTER_KEYS.BR_TJDFT]: 2,

  [ADAPTER_KEYS.BR_TST]: 2,

  [ADAPTER_KEYS.CZ_NS_SBIRKA]: 2,

  [ADAPTER_KEYS.CZ_NS]: 34,

  [ADAPTER_KEYS.CZ_NSS]: 41,

  [ADAPTER_KEYS.CZ_REGIONAL]: 28,

  [ADAPTER_KEYS.CZ_UOHS]: 20,

  [ADAPTER_KEYS.CZ_US]: 46,

  [ADAPTER_KEYS.EU_ECJ]: 28,

  [ADAPTER_KEYS.HU_BHGY]: 33,

  [ADAPTER_KEYS.PL_COURTS]: 39,

  [ADAPTER_KEYS.PL_KIO]: 33,

  [ADAPTER_KEYS.PL_KIS]: 36,

  [ADAPTER_KEYS.PL_NCOURT]: 40,

  [ADAPTER_KEYS.PL_NSA]: 13,

  [ADAPTER_KEYS.PL_SN]: 33,

  [ADAPTER_KEYS.PL_TK]: 15,

  [ADAPTER_KEYS.PL_UODO]: 22,

  [ADAPTER_KEYS.PL_UOKIK]: 38,

  [ADAPTER_KEYS.SK_COURTS]: 34,

  [ADAPTER_KEYS.SK_US]: 30,

  [ADAPTER_KEYS.UK_FCL]: 8,
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

  [ADAPTER_KEYS.BR_TJDFT]: 0,

  [ADAPTER_KEYS.BR_TST]: 0,

  [ADAPTER_KEYS.CZ_NS_SBIRKA]: 0,

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
  [ADAPTER_KEYS.AT_ASYLGH]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_ASYLGH], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_BKS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_BKS], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_BVWG]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_BVWG], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_COURTS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_COURTS], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_FINDOK]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_FINDOK], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Block text folds letter-spaced emphasis through the one shared reading, which also reads a short spaced word beside a spaced word and treats a no-break space as a word gap; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_LVWG]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_LVWG], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_UBAS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_UBAS], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_UMSE]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_UMSE], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_UVS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_UVS], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_VERG]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_VERG], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_VFGH]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_VFGH], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.AT_VWGH]: { version: PARSER_VERSIONS[ADAPTER_KEYS.AT_VWGH], scope: {"type":"all","reason":"Read the parts of an Austrian decision from what the court printed, not from the publisher's section labels: the docket line, formula and bench recital are head matter, the ruling is the holding wherever it is filed, the reasons, instructions on appeal and the place and date follow in order, and Findok decisions carry the same roles. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.BR_TJDFT]: { version: PARSER_VERSIONS[ADAPTER_KEYS.BR_TJDFT], scope: {"type":"all","reason":"Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.BR_TST]: { version: PARSER_VERSIONS[ADAPTER_KEYS.BR_TST], scope: {"type":"all","reason":"Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.CZ_NS_SBIRKA]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NS_SBIRKA], scope: {"type":"all","reason":"Recognize split and complete report editions from their stored detail HTML; earlier rows do not store the edition layout."} },

  [ADAPTER_KEYS.CZ_NS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NS], scope: {"type":"all","reason":"Recompute procedural review links from the stored opening and holding text; parsed document output is otherwise unchanged."} },

  [ADAPTER_KEYS.CZ_NSS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS], scope: {"type":"all","reason":"Recompute procedural review links from the publisher's review table on every held detail page and from the stored opening and holding text; document-only legacy raw retains its existing metadata."} },

  [ADAPTER_KEYS.CZ_REGIONAL]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_REGIONAL], scope: {"type":"all","reason":"Recompute the instructions from stored raw so the court's own Poučení label, alone or opening the first instruction, is printed once under the synthesized heading; AST blocks have no separate feature storage. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Signature roles are recomputed from the stored decision through the shared Czech role grammar, which reads the office a judge signs under (the president or a member of an extended or grand chamber, the President of a top court); they have no feature storage of their own. Spell the docket's registry as the row's own ECLI spells it (14 Co, not 14 CO) for the stored docket and the listing identity alike; the case number has no separate feature storage. Printed paragraph labels are read by one grammar: a label opens a paragraph except inside a date wrapped after its day or after a word its number belongs to, sub-paragraphs (`5.5.`) open their own and count as items beside the court's numbering, and positioned-line paragraphs are read by the one line-join owner; block text, boundaries and numbers are recomputed from stored raw and have no feature storage of their own. A line break typed inside a paragraph, which the structured entries split and the plain text marks with a carriage return, is read as a space; paragraph text and boundaries are recomputed from stored raw and have no feature storage of their own. Court paragraph numbers are re-read from stored raw: a run that counts up by one from its start to within a closing line of the reasoning's end is numbered however much unnumbered text lies between its numbers, the lead-in before the first number is counted from the end of the operative part, and the one paragraph that opens the reasoning before a printed 2 is numbered 1; paragraph numbers have no feature storage of their own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.CZ_UOHS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_UOHS], scope: {"type":"all","reason":"Revalidate publisher head-matter ordering and recompute printed paragraph labels from stored raw: local duplicate or OCR markers preserve surrounding labels, and Czech and Slovak separate opinions have independent numbering scopes. AST roles and labels have no separate feature storage. Re-read legacy, suffixed and Unicode Adobe Glyph List names from stored PDF bytes; extraction has no separate feature storage. Re-read the body and footnotes from stored PDF bytes through the shared PDF band reader: running headers, barcodes and page numbers leave the body by their shape, footnotes are read off each page's foot with their raised references as linked superscripts, and printed lines join into paragraphs across page breaks; the AST has no separate feature storage. Block text folds letter-spaced emphasis through the one shared reading, which also reads a short spaced word beside a spaced word and treats a no-break space as a word gap; only whitespace in block text changes and it has no feature storage of its own. Re-derive the file number with its year from the export record (older rows state only the serial), the issue date from the reference-number letterhead line, and the decision type from the printed title, typing its absence when none is printed; the identifiers and the case number have no separate feature storage. Roles are recomputed from stored PDF bytes through the shared Czech grammar of an authority's decision: the head matter up to the lead-in (rozhodl takto:, ROZHODNUTÍ:) is intro, the operative part after it is holding, the reasons from their heading carry no ruling role, the document barcode is apparatus and the head of the Office signs under its office; the title, the reasons and instruction headings and the reasons' Roman section titles are headings. Roles and headings have no feature storage of their own. Printed paragraph labels are read by one grammar: a label opens a paragraph except inside a date wrapped after its day or after a word its number belongs to, sub-paragraphs (`5.5.`) open their own and count as items beside the court's numbering, and positioned-line paragraphs are read by the one line-join owner; block text, boundaries and numbers are recomputed from stored raw and have no feature storage of their own. Court paragraph numbers are re-read from stored raw: a run that counts up by one from its start to within a closing line of the reasoning's end is numbered however much unnumbered text lies between its numbers, the lead-in before the first number is counted from the end of the operative part, and the one paragraph that opens the reasoning before a printed 2 is numbered 1; paragraph numbers have no feature storage of their own. The reference number is kept as a lookup identifier only when it fits the identifier bound: a joined proceeding's reference number that lists every joined file is left out rather than cut, and the file number stays the decision's identity; identifiers have no separate feature storage. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change. Identifier values keep the file and reference numbers as the office prints them (the pipeline keys them for lookup), and a stored row whose file number an earlier release spelled as its lowercased lookup key is re-read as the same publisher document; identifiers and the case number have no separate feature storage. A page footer that counts its pages (`Úřad pro ochranu hospodářské soutěže 2/13`) is read as one running line across pages and leaves the body, so paragraphs broken by a page join again; the AST has no separate feature storage."} },

  [ADAPTER_KEYS.CZ_US]: { version: PARSER_VERSIONS[ADAPTER_KEYS.CZ_US], scope: {"type":"all","reason":"Recompute procedural review links from the stored opening and holding text; parsed document output is otherwise unchanged."} },

  [ADAPTER_KEYS.EU_ECJ]: { version: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ], scope: {"type":"all","reason":"The sentence introducing the ruling (On those grounds, THE COURT hereby rules:) loses the holding role where the Court sets it on several lines: the General Court's unmarked opening row and the oldest layout's bare paragraphs. Derive the case number from every case-law CELEX document form by its court letter, so a Civil Service Tribunal order (62013FO0060) reads F-60/13 instead of the raw CELEX; the case number has no separate feature storage. A bare number after a dash in the keyword chain closes a range inside the keyword before it instead of standing as a keyword of its own; keywords have no separate feature storage. Retain the publisher's excluded notice fields in the stored notice instead of naming them as exclusions. Block text folds letter-spaced emphasis through the one shared reading, which also reads a short spaced word beside a spaced word and treats a no-break space as a word gap; only whitespace in block text changes and it has no feature storage of its own. Re-read stored CJEU documents: a title set over several lines (an opinion's author and delivery line, a judgment's chamber and date) is one decision-title heading, and each footnote-list entry is a footnote note keyed by its anchor; headings and notes have no separate feature storage. Read the converter's table of contents after the signatures (coj-NTOCn entries) as publisher notes instead of continuing the operative part; roles have no separate feature storage. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.HU_BHGY]: { version: PARSER_VERSIONS[ADAPTER_KEYS.HU_BHGY], scope: {"type":"all","reason":"Reclassify closing certification, principle-summary and applied-legislation sections from stored Hungarian documents; AST roles have no separate feature storage. Read a partial or interim judgment's operative introduction and the kind printed below a header table as opening the operative part; a header label needs its colon; paragraph roles and the decision type have no separate feature storage. Type the reasons printed after the ruling as argumentation, not as the document's tail, in the sections derived from the AST. Read the publisher citation restriction from retained raw records into decision metadata; null or absent restrictions remain absent. Block text folds letter-spaced emphasis through the one shared reading, which also reads a short spaced word beside a spaced word and treats a no-break space as a word gap; only whitespace in block text changes and it has no feature storage of its own. Re-mark anonymisation placeholders from stored Hungarian documents: a placeholder's number and field word end the token, so amounts, years and longer words beside a party label stay text; inline anonymisation marks have no separate feature storage. Read the titles a court prints inside its reasons (short, capitalised, unnumbered lines with no closing punctuation under Indokolás that head the court's next numbered paragraph or the closing place and date, on a line of their own or before a soft break) as level-2 headings instead of argumentation paragraphs; after a paragraph without closing punctuation only a title set in bold qualifies. AST roles and the outline have no separate feature storage. Read a character an RTF writes in a double-byte font as one lead and trail byte (\"§\" in a Japanese font), a byte the code page leaves undefined as U+FFFD with a reader warning rather than a C1 control character, and the Latin-1 stand-ins \"õ\" and \"û\" as the Hungarian \"ő\" and \"ű\", in block and full text; characters have no separate feature storage. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change. Read the decision type from a title-block possessive in either vowel harmony (\"határozata\", \"állásfoglalása\" as well as \"ítélete\", \"végzése\"), so a Kúria self-government panel's ruling is typed; the decision type has no separate feature storage."} },

  [ADAPTER_KEYS.PL_COURTS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_COURTS], scope: {"type":"all","reason":"Recount a court's printed paragraph numbers with the shared reading: a run that counts up through the whole reasoning is numbered even where many unnumbered paragraphs sit between its numbers; only paragraph numbering in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.PL_KIO]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_KIO], scope: {"type":"all","reason":"Recount a court's printed paragraph numbers with the shared reading: a run that counts up through the whole reasoning is numbered even where many unnumbered paragraphs sit between its numbers; only paragraph numbering in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.PL_KIS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_KIS], scope: {"type":"all","reason":"Retain the publisher's excluded fields in the stored record instead of naming them as exclusions. Read a parliamentary answer's question (TRESC_INTERP_ZAPYT) before its text, and a newsletter's own text (TRESC_NEWS), into the document. Drop lines that only link back within the document, and join a footnote's line its sentence runs across. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.PL_NCOURT]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_NCOURT], scope: {"type":"all","reason":"Retain the publisher's excluded fields in the stored record instead of naming them as exclusions. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.PL_NSA]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_NSA], scope: {"type":"all","reason":"Classify the thesis heading as publisher head matter when rebuilding the stored dataset sections; AST roles have no separate feature storage. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.PL_SN]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_SN], scope: {"type":"all","reason":"Recount a court's printed paragraph numbers with the shared reading: a run that counts up through the whole reasoning is numbered even where many unnumbered paragraphs sit between its numbers; only paragraph numbering in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.PL_TK]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_TK], scope: {"type":"all","reason":"Recompute canonical paragraph text and inline projections from captured source material, preserving numeric superscript indices with caret delimiters. Read inline style declarations with CSS cascade semantics. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.PL_UODO]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_UODO], scope: {"type":"all","reason":"Retain the publisher's excluded fields in the stored record instead of naming them as exclusions. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.PL_UOKIK]: { version: PARSER_VERSIONS[ADAPTER_KEYS.PL_UOKIK], scope: {"type":"all","reason":"Retain the publisher's excluded fields in the stored record instead of naming them as exclusions. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.SK_COURTS]: { version: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS], scope: {"type":"all","reason":"Replay reads the stored source envelope and document objects through the ingestion parser, verifying each recorded digest and length; parser output is unchanged and the parsed decision has no feature storage of its own. Revalidate deferred stored PDF payloads through the shared typed corpus-validation result; invalid textless structure is a classified no-document outcome, while readable source text and AST retain the same parser. Preserve PDF paragraph gaps, lettered items and the bounded first-page metadata table when rebuilding document text and block boundaries from captured PDF bytes. Rows without captured PDF bytes yield a metadata-only replay outcome and retain their applied parser version; populated historical rows require an explicit PDF capture refresh. Metadata-derived titles require extracted document blocks. Paragraph-gap thresholds derive from font metrics rather than the frequency of observed gaps. Recompute printed paragraph labels from stored raw: local duplicate or OCR markers preserve surrounding labels, and Czech and Slovak separate opinions have independent numbering scopes; AST roles and labels have no separate feature storage. Re-read legacy, suffixed and Unicode Adobe Glyph List names from stored PDF bytes; extraction has no separate feature storage. Read words the court sets letter-spaced as words, keeping the wider gap between two of them as the word boundary; paragraph text has no separate feature storage. Paragraph text and block boundaries are recomputed from stored PDFs through the shared hard-wrap reader, preserving first-line and hanging indentation, line pitch and short final lines; multiline titles and all block anchors are rebuilt with document-unique identities; none has feature storage of its own. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. The formula a court decides under (V MENE SLOVENSKEJ REPUBLIKY), set in the title's type, is read apart from the title as an opening paragraph from the stored PDF bytes; the AST has no separate feature storage. Every row of the portal's metadata box printed above the decision is front matter. Printed paragraph labels are read by one grammar: a label opens a paragraph except inside a date wrapped after its day or after a word its number belongs to, sub-paragraphs (`5.5.`) open their own and count as items beside the court's numbering, and positioned-line paragraphs are read by the one line-join owner; block text, boundaries and numbers are recomputed from stored raw and have no feature storage of their own. Court paragraph numbers are re-read from stored raw: a run that counts up by one from its start to within a closing line of the reasoning's end is numbered however much unnumbered text lies between its numbers, the lead-in before the first number is counted from the end of the operative part, and the one paragraph that opens the reasoning before a printed 2 is numbered 1; paragraph numbers have no feature storage of their own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.SK_US]: { version: PARSER_VERSIONS[ADAPTER_KEYS.SK_US], scope: {"type":"all","reason":"Recompute paragraph text and line breaks from stored markup: retain a line break when its newline survives whitespace trimming and drop it when the newline is removed; paragraph AST has no separate feature storage. Normalize repeated block identities and publisher head-matter order before reading stored decisions; AST identities and roles have no independent feature storage. Multiline preamble titles and document-unique block anchors are rebuilt from stored markup, alongside paragraph text, paragraph numbers and anonymization markers before whitespace trimming, including unpainted non-breaking-space redaction runs and uneven letter-spaced chunks witnessed by intact words; none has feature storage of its own. Recompute printed paragraph labels from stored raw: local duplicate or OCR markers preserve surrounding labels, and Czech and Slovak separate opinions have independent numbering scopes; AST roles and labels have no separate feature storage. Read files that set word gaps as no-break spaces at their text-layer seams: a plain space inside a word joins it, and one after a finished sentence before a numbered point restores the lost line break; paragraph AST has no separate feature storage. In files with plain word gaps too, the court's next numbered point or a part marker run onto a finished sentence opens its own line again, so ruling points and the reasoning are read apart; paragraph roles have no separate feature storage. A page that ends a part before a separate opinion opens a fresh page with the docket may be short, so the page numbers around it leave the text; paragraph text has no separate feature storage. Read letter-spaced emphasis through the one shared reading, once a paragraph's lines are joined: a short spaced word in a text that spaces words, a row of one-letter words no sentence writes, and uneven chunks the document prints nowhere else read as the words they spell; only whitespace in block text changes and it has no feature storage of its own. Printed paragraph labels are read by one grammar: a label opens a paragraph except inside a date wrapped after its day or after a word its number belongs to, sub-paragraphs (`5.5.`) open their own and count as items beside the court's numbering, and positioned-line paragraphs are read by the one line-join owner; block text, boundaries and numbers are recomputed from stored raw and have no feature storage of their own. A paragraph whose last parenthesis a page break leaves open goes on onto the next page; paragraph boundaries are recomputed from stored raw and have no feature storage of their own. Court paragraph numbers are re-read from stored raw: a run that counts up by one from its start to within a closing line of the reasoning's end is numbered however much unnumbered text lies between its numbers, the lead-in before the first number is counted from the end of the operative part, and the one paragraph that opens the reasoning before a printed 2 is numbered 1; paragraph numbers have no feature storage of their own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },

  [ADAPTER_KEYS.UK_FCL]: { version: PARSER_VERSIONS[ADAPTER_KEYS.UK_FCL], scope: {"type":"all","reason":"Revalidate publisher head-matter ordering across the complete document AST; roles have no separate feature storage. Date a tribunal decision by its decision date, so a document named a decision is read rather than refused. Block text folds letter-spaced emphasis through the one shared reading, which also reads a short spaced word beside a spaced word and treats a no-break space as a word gap; only whitespace in block text changes and it has no feature storage of its own. Re-derive stored citations with rule kinds, polarity evidence windows and cited parts; the canonical AST and publisher metadata do not change."} },
} as const satisfies ParserVersionScopes<typeof PARSER_VERSIONS>;
export type AdapterKey = (typeof ADAPTER_KEYS)[keyof typeof ADAPTER_KEYS];
export type ImportSourceKey = (typeof IMPORT_SOURCE_KEYS)[keyof typeof IMPORT_SOURCE_KEYS];
