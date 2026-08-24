import { panic } from "better-result";

import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
  isDecisionIdentifier,
  normalizeStructuredDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import type {
  DecisionIdentifier,
  DecisionIdentifiers,
  DecisionIdentifierType,
} from "@stll/legal-ast/decision-identifier";

import {
  type CitationDecisionTypeHint,
  detectCitationDecisionTypeHint,
} from "@/api/handlers/case-law/citation-decision-type-hint";

/**
 * Extracted citation reference found in decision text.
 */
type ExtractedCitation = {
  /** The raw citation text as found in the source. */
  citationText: string;
  /** Section index where the citation was found. */
  sectionIndex: number | null;
  /**
   * The decision-type word the text introduced the number with, when one
   * binds to it; see `citation-decision-type-hint.ts`. Null is "the text did
   * not say", never "unknown type".
   */
  citedDecisionTypeHint: CitationDecisionTypeHint | null;
  identifierType: DecisionIdentifierType;
};

/**
 * Patterns for recognizing case law citations in Czech, Slovak, Polish,
 * and CJEU decision texts. Covers common reference formats used in
 * judicial practice.
 *
 * Based on analysis of 770K citation instances in the CzCDC corpus
 * (Harasta, Masaryk University), cross-checked against the SAOS public
 * API for Polish case law.
 *
 * Deliberately out of scope (precision trade-offs, revisit with evidence):
 *  - Slovak "Spr"/"Spr." court-administration agenda numbers: these are
 *    docket numbers for the court's own administration, not adjudication,
 *    so they are not case law citations.
 *  - "NNNEX" bailiff/exekútor numbers without a court-registry token:
 *    executor files, not court decisions.
 *  - Bare single-letter Polish Constitutional Tribunal symbols (K, P, U)
 *    with no "sygn." anchor anywhere nearby: too collision-prone against
 *    ordinary prose and ordinary district-court registries; SAOS-quantified.
 *  - Bare, unanchored pre-1989 CJEU numbers (no trailing ECLI suffix):
 *    collide with directive numbers ("65/65/EEC") and report numbers
 *    ("1/96").
 *  - CJEU numbers with no hyphen at all ("C679/18"): collide with the
 *    Czech civil "C" registry ("21 C 1234/2020"). The hyphen may be
 *    spaced ("C- 303/20", "C -679/18") but must be present.
 *  - Slovak "R NN/YYYY" reporter citations: needs proximity anchoring to
 *    the citing court to avoid collisions; future work.
 */

// Shared body for Czech/Slovak numeric-first case numbers: chamber
// number, registry letters (diacritics included, e.g. Slovak "Sžf"),
// then docket number and year. Real filings mix separator conventions
// inconsistently -- attached ("5Cdo/260/2008"), fully spaced
// ("21 Cdo 1234/2020", "33 Cb/209/2010"), or attached-then-spaced
// ("10C 84/97", two-digit year) all name the same kind of case number.
// Each gap is a bounded whitespace/slash run (not a single optional
// character), so a double space or a CRLF line-wrap ("21\r\nCdo") still
// matches; the bound keeps the pattern resolving in one pass with no
// repeated alternation to backtrack through. `canonicalizeDedupKey`
// collapses the resulting spelling variance to one dedup key.
const CASE_NUMBER_BODY = String.raw`(?<caseNumber>\d{1,3}\s{0,3}\p{L}{1,6}[\s/]{1,3}\d{1,6}\/\d{2,4})(?!\d)`;

// Same shape, but the docket number may join a second consolidated
// docket that shares the trailing year: courts consolidating appeals
// into one ruling cite both numbers together under a single registry,
// e.g. "č. j. 27 Co 116, 119/2007-94" (appeals 116 and 119, both /2007),
// "36 Co 52,53/2023" (no space after the comma), or "36 Co 52/53/2023"
// (slash instead of comma). `canonicalizeDedupKey` folds every join
// spelling to one canonical key.
const CASE_NUMBER_BODY_COMMA = String.raw`(?<caseNumber>\d{1,3}\s{0,3}\p{L}{1,6}[\s/]{1,3}\d{1,6}(?:[,/]\s{0,3}\d{1,6})?\/\d{2,4})(?!\d)`;

// Shared "sygn." lead-in, covering every registrar spelling seen in the
// corpus: title-case "Sygn." at the start of a document header vs.
// lowercase "sygn." in body prose; an optional colon directly after the
// period ("sygn.: P. 12/98"); and "akt" itself optionally punctuated with
// a dot ("akt.") or a colon ("akt:"), or omitted entirely ("sygn. II CSK
// 123/20"). Every gap is a bounded whitespace run (not unbounded `\s*`),
// so an OCR whitespace run after "sygn." fails to match rather than
// being swallowed into a phantom Tribunal citation.
const PL_SYGN_PREFIX = String.raw`[Ss]ygn\.\s{0,3}(?::\s{0,3})?(?:[Aa]kt\.?:?\s{0,3})?`;

// Polish prefixed pattern: "sygn. akt II CSK 123/20". The chamber roman
// numeral and division code are frequently glued with no space ("IC
// 171/12", "XP 3615/05", division count up to "XVIII"), and the division
// code itself is sometimes a second, space- or slash-joined token
// ("III A Ua 2389/02" labor-appellate panels, "VI SA/Wa" handled by the
// dedicated NSA/WSA pattern instead), with a bounded whitespace/slash run
// (not a single character) between the two division tokens so a double
// space or a line-wrap still matches ("sygn. akt III  A Ua 2389/02"). The
// gap between the roman numeral and the division code is likewise a
// bounded run (0-3 characters, not unbounded `\s*`): it must match
// PL_TK_PATTERN/PL_TK_BARE_PATTERN's phantom-duplicate lookbehind exactly,
// or a whitespace run this pattern still combines into one citation but
// the lookbehind no longer recognizes lets the Tribunal symbol at the
// tail phantom-duplicate as a second, separate citation. Group
// `caseNumber` captures the bare case number to deduplicate against the
// unprefixed pattern below.
const PL_PREFIXED_PATTERN = new RegExp(
  String.raw`${PL_SYGN_PREFIX}(?<caseNumber>[IVX]{1,6}\s{0,3}[A-Za-z]{1,5}(?:[\s/]{1,3}[A-Za-z]{1,5})?\s*\d{1,6}\/\d{2,4})`,
  "gu",
);

// Polish division + proceeding-type case number: "sygn. akt V GNc upr
// 936/13" (Gospodarczy Nakazowo-upominawczy: commercial writ-of-payment
// proceedings). The lowercase proceeding-type word is a third,
// space-separated token after the ordinary chamber code, which
// PL_PREFIXED_PATTERN's single optional second token cannot capture.
const PL_THREE_TOKEN_PATTERN =
  /[Ss]ygn\.\s*[Aa]kt\.?:?\s*(?<caseNumber>[IVX]{1,4}\s+[A-Za-z]{1,5}\s+[a-z]{1,5}\s+\d{1,6}\/\d{2,4})(?!\d)/gu;

// Polish Constitutional Tribunal (Trybunał Konstytucyjny) and disciplinary
// chambers cite by a short case-type symbol with no Roman-numeral chamber:
// "K" (abstract review), "Kp"/"Kpt" (presidential preventive review /
// competence dispute), "SK" (constitutional complaint), "P" (legal
// question), "U" (competence dispute), "Tw" (citizens' petition), "Pp",
// "Ts" (preliminary examination). Symbols may carry a trailing dot ("K.
// 23/98"), separated from the docket by a bounded whitespace run (0-3
// characters, not unbounded `\s*`) so an OCR whitespace run is rejected
// rather than preserved verbatim in the stored citation text. Longer
// symbols are listed first in the alternation so "Kp"/"Kpt"/"SK"/"Ts" are
// never shadowed by the bare "K". Multi- and single-letter symbols alike
// are cited fully bare in running prose, with no "sygn." anywhere nearby,
// so the "sygn." anchor is optional; the negative lookbehind (unbounded
// roman run, bounded 1-3 whitespace run) stops a single-letter symbol
// from phantom-duplicating the tail of an ordinary Roman-numeral-prefixed
// citation immediately before it ("sygn. akt II K 796/13" is one citation,
// not also a bare "K 796/13"), including after a double space ("II  SK
// 12/20"). The lookbehind's 1-3 bound (not 0-3: an unanchored 0-width
// option here trips scslre's superlinear-suffix-matching check) still
// closes the gap with PL_PREFIXED_PATTERN and the bare Polish pattern,
// both themselves bounded to reject a four-or-more-space roman-to-symbol
// gap as one ambient citation -- a gap too wide for either matcher to
// combine never reaches this guard as an ambient citation to
// phantom-duplicate in the first place, and the roman-numeral-glued case
// this guard need not cover at zero spacing never satisfies the leading
// `\b` on the symbol capture below anyway.
// Single-letter symbols (K, P, U) require the "sygn." anchor: bare they
// collide with ordinary prose and district-court registries (an
// SAOS-quantified precision trade-off). Multi-letter symbols are
// distinctive enough to match bare, still guarded against
// phantom-duplicating a Roman-numeral-prefixed citation's tail.
const PL_TK_PATTERN = new RegExp(
  String.raw`${PL_SYGN_PREFIX}(?<!\b[IVX]+\s{1,3})\b(?<caseNumber>(?:Kpt|Kp|Ts|SK|Tw|Pp|K|P|U)\.?\s{0,3}\d{1,4}\/\d{2,4})(?!\d)`,
  "gu",
);

const PL_TK_BARE_PATTERN =
  /(?<!\b[IVX]+\s{1,3})\b(?<caseNumber>(?:Kpt|Kp|Ts|SK|Tw|Pp)\.?\s{0,3}\d{1,4}\/\d{2,4})(?!\d)/gu;

// Polish bare-symbol pattern: other tribunals and disciplinary registries
// cite by a 1-3 letter symbol with no Roman-numeral chamber at all --
// "sygn. T. 20/97", "sygn. SNO 45/06" (Sąd Najwyższy disciplinary
// chamber), separated from the docket by the same bounded whitespace run
// as PL_TK_PATTERN. Anchored on the "sygn." (optionally "akt") prefix,
// unlike PL_TK_PATTERN, since these symbols are not on the closed
// Tribunal list and would otherwise be too collision-prone to match bare.
const PL_BARE_SYMBOL_PATTERN = new RegExp(
  String.raw`${PL_SYGN_PREFIX}(?<caseNumber>[A-Z]{1,3}\.?\s{0,3}\d{1,4}\/\d{2,4})(?!\d)`,
  "gu",
);

// Polish administrative courts (NSA/WSA): the registry carries the
// court's location joined by a slash, e.g. "II SA/Wa 2016/05" (WSA
// Warszawa), "VI SA/Wa 1161/06", "II SA/Łd 123/20" (WSA Łódź, a
// non-ASCII location letter), or the older undivided registry from
// before the 2004 court reform, "SA/Po 4584/01" (no Roman division at
// all). The registry can't just add "/" to the generic alternation above
// without also swallowing the case number's own slash, so this is a
// dedicated pattern anchored on the literal SA/ or SAB/ token.
const PL_NSA_WSA_PATTERN = new RegExp(
  String.raw`(?:${PL_SYGN_PREFIX})?\b(?<caseNumber>(?:[IVX]{1,4}\s+)?(?:SAB|SA)\/\p{L}{2,4}\s+\d{1,6}\/\d{2,4})(?!\d)`,
  "gu",
);

const CITATION_PATTERNS: RegExp[] = [
  // Czech/Slovak case number: "sp. zn. 21 Cdo 1234/2020", "sp. zn.
  // 33 Cb/209/2010", "sp.zn.: 38Csp/281/2025", "sp. zn 5Obdo/23/2016" (no
  // period after "zn"). Two-digit years ("2 Cdon 808/97", "8Co/431/97")
  // are the standard form for pre-2000 decisions; the resolver owns
  // century mapping.
  new RegExp(String.raw`sp\.\s*zn\.?:?\s*${CASE_NUMBER_BODY}`, "gu"),

  // Slovak Supreme Court extraordinary-review / grand-chamber panel: "sp.
  // zn. 4 M Cdo 15/2010", "sp. zn. 2 M Obdo 1/2008", where "M"
  // (mimoriadne dovolanie / veľký senát) sits between the chamber digit
  // and the ordinary registry as its own word -- one word more than
  // CASE_NUMBER_BODY allows. The period after "zn" is optional, matching
  // the general sp. zn. pattern above ("sp. zn 4 M Cdo 15/2010").
  /sp\.\s*zn\.?:?\s*(?<caseNumber>\d{1,3}\s+M\s+\p{L}{1,6}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Slovak Special Court (Špeciálny súd v Pezinku, 2004-2009) case numbers
  // carry a "PK" panel prefix before the ordinary senate/registry/number
  // shape: "sp. zn. PK 1 Tš 24/2006". The period after "zn" is optional,
  // matching the general sp. zn. pattern above.
  /sp\.\s*zn\.?:?\s*(?<caseNumber>PK\s+\d{1,3}\s+\p{L}{1,6}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Slovak Najvyšší súd hyphenated administrative registry code: "sp. zn.
  // 5 Sž-o-KS 94/2005" (appellate senates chain short letter groups with
  // hyphens; the plain-letter registry in CASE_NUMBER_BODY excludes them).
  // The period after "zn" is optional, matching the general sp. zn.
  // pattern above.
  /sp\.\s*zn\.?:?\s*(?<caseNumber>\d{1,3}\s+\p{L}{1,4}(?:-\p{L}{1,4}){1,3}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Slovak courthouse workplace-code prefix (post-2023 court reform): "sp.
  // zn. B4-14Cb/13/2021", "sp. zn. K2-17P/72/2022" (Mestský súd) -- a
  // branch letter+digits, hyphen, then the ordinary joined chamber+
  // registry/case/year shape. The period after "zn" is optional, matching
  // the general sp. zn. pattern above.
  /sp\.\s*zn\.?:?\s*(?<caseNumber>[A-Z]\d{1,2}-\d{1,3}\p{L}{1,5}\/\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Czech senate file number: "sen. zn. 29 NSČR 55/2013" (grand panel,
  // insolvency). Same shape as sp. zn. under a different prefix.
  new RegExp(String.raw`sen\.\s*zn\.:?\s*${CASE_NUMBER_BODY}`, "gu"),

  // Czech letter-first registries without a senate number: "sp. zn. Nt
  // 408/2023" (criminal auxiliary), "sp. zn. A 9/2003" (pre-2003
  // administrative). The registry run is short with an optional trailing
  // dot, then a space and digits, which keeps agency file numbers
  // ("MSP-725/2022") out; "Spr"/"Spr." is the court-administration
  // agenda, not adjudication, and stays excluded regardless of casing
  // ("SPR.", "spr.").
  /sp\.\s*zn\.:?\s*(?![Ss][Pp][Rr]\.?\s)(?<caseNumber>\p{L}{1,4}\.?\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Czech Supreme Court plenary/collegium opinions ("stanoviska"), civil
  // (Cpjn) and criminal (Tpjn), are routinely cited bare after the first
  // mention, without a "sp. zn." prefix: "stanovisko ... Cpjn 203/2010,
  // uveřejněné pod č. 50/2011". Narrowly scoped to these two registries so
  // it does not turn into a generic bare-citation matcher.
  /\b(?<caseNumber>[CT]pjn\s+\d{1,4}\/\d{4})(?!\d)/gu,

  // Constitutional Courts: "IV. ÚS 23/05", "Pl. ÚS 12/94" (Czech, with a
  // dot after the senate numeral), "III ÚS 154/2011" (Slovak, without
  // one), "II.ÚS/251/04" (Slovak case-list shorthand with a slash instead
  // of a space), "III.US 364/2017" (diacritic dropped, likely an encoding
  // fallback), "PL ÚS 11/2016" (Slovak all-caps plenum spelling), and
  // "Pl. ÚS-st. 45/16" / "Pl. ÚS‑st. 45/16" (non-breaking hyphen) /
  // "Pl. ÚS – st. 59/23" (a binding plenary standpoint, not an ordinary
  // ruling, marked with a "-st." infix, dash spelling and spacing both
  // bounded and variable). The senate is a Roman numeral (or Pl./PL for
  // the plenum) directly before it, so ordinary prose about the United
  // States never has this shape; the digit-led pattern above never
  // matches these either way. The bare form also covers the "sp. zn.
  // IV. ÚS 23/05" spelling.
  /\b(?<caseNumber>(?:[IVX]{1,4}|Pl|PL)\.?\s*[ÚU]S(?:\s{0,3}[-‑–—]\s{0,3}st\.)?[\s/]+\d{1,5}\/\d{2,4})(?!\d)/gu,

  // CJEU: "C-283/81", "T-13/99", "F-100/09" (Court of Justice, General
  // Court, Civil Service Tribunal), including the non-breaking hyphen the
  // publications office uses ("C‑283/81"), the en/em dash normalizeDashes
  // already canonicalizes for the dedup key ("C–128/22"), the soft hyphen
  // (U+00AD) a PDF-to-text conversion leaves behind at a line-wrap
  // boundary ("C­472/11", invisible when rendered), and OCR/typo spacing
  // around the separator seen in prod text for the same case ("C- 679/18",
  // "C -679/18"), bounded to a few characters so a stray long whitespace
  // run does not leak into the stored citation text. The separator itself
  // is never dropped: a bare "C679/18" would collide with the Czech civil
  // "C" registry ("21 C 1234/2020"), so it is intentionally out of scope
  // (see the module-level exclusion list).
  /\b(?<caseNumber>[CTF]\s{0,3}[-‑–—­]\s{0,3}\d{1,4}\/\d{2})(?!\d)/gu,

  // ECLI: "ECLI:CZ:NS:2020:21.CDO.1234.2020.1"
  /ECLI:[A-Z]{2}:[A-Z]{1,8}:\d{4}:[\w.]+/gu,

  // CJEU judgments cite their own case-law with the ECLI suffix only,
  // dropping the "ECLI:" literal: "C‑156/21, EU:C:2022:97", "60/81,
  // EU:C:1981:264". This is the form the Court's own text actually uses
  // (the literal "ECLI:" prefix above appears in database identifiers,
  // not in judgment prose), so it is captured as its own citation
  // regardless of whether a case number precedes it. The CJEU's own ECLI
  // country code is "EU" ("ECLI:EU:C:2020:123"), so without the negative
  // lookbehind this would also match the tail of a full ECLI already
  // captured by the pattern above, producing two entries for one
  // identifier.
  /(?<!ECLI:)\bEU:[CTF]:\d{4}:\d+\b/gu,

  // Pre-1989 CJEU case numbers carry no C-/T- prefix (the Court introduced
  // it in 1989): "60/81", or joined as "169/83 e 136/84" / "15/76 and
  // 16/76". A bare number/year pair is too collision-prone on its own (it
  // also matches directive numbers like "65/65/EEC" and report numbers
  // like "1/96"), so it is only captured when the ECLI-suffix pattern
  // above follows immediately, which no directive or report number ever
  // has. The negative lookbehind stops this from also re-matching the
  // bare tail of an already-prefixed number ("T‑381/15" must not also
  // yield a phantom "381/15"), including every separator spelling the
  // CJEU C/T/F pattern above tolerates: spaced ("C- 679/18" must not also
  // yield a phantom "679/18"), en/em dash ("C–128/22" must not also yield
  // a phantom "128/22"), and soft hyphen ("C­128/22" must not also yield a
  // phantom "128/22").
  /(?<![CTF]\s{0,4}[-‑–—­]\s{0,4})\b(?<caseNumber>\d{1,4}\/\d{2})(?!\d)(?=[\s,]*(?:(?:and|e)\s+\d{1,4}\/\d{2}(?!\d)[\s,]*)?EU:[CTF]:\d{4}:\d+)/gu,

  // Czech collection: "č. 123/2020 Sb. rozh. tr." (Nejvyšší soud, civil or
  // criminal) or "č. 2018/2010 Sb. NSS" (Nejvyšší správní soud, a
  // different court's collection). "NSS" must be tried before "NS", or
  // the alternation matches the "NS" prefix and truncates the extracted
  // text to the wrong court's abbreviation.
  /[čc]\.\s*\d{1,5}\/\d{4}\s+Sb\.\s*(?:rozh\.\s*(?:tr|ob)\.?|NSS|NS)/gu,

  // Generic: "rozsudek č.j. 5 As 123/2020"; registrars also write "č. j.:
  // 137 Ex 1850/23", administrative senates glue the digit straight to
  // the registry letter ("6A 242/2016", "9Afs 44/2011", "2T 190/2017"),
  // and consolidated proceedings join two case numbers with a comma
  // before the shared year ("36 Co 52,53/2023", "27 Co 116, 119/2007").
  new RegExp(String.raw`[čc]\.\s*j\.:?\s*${CASE_NUMBER_BODY_COMMA}`, "gu"),

  // Czech letter-first registries under č.j. without a senate number:
  // "č.j. Nad 224/2014" (delegation/jurisdiction disputes), "č.j. Konf
  // 4/2011-12" (jurisdiction-conflict panel). Mirrors the sp. zn.
  // letter-first fallback above.
  /[čc]\.\s*j\.:?\s*(?<caseNumber>\p{L}{1,6}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Insolvency filings cite another court's case with that court's own
  // registry code before the docket: "č. j. KSCB 26 INS 8270/2018"
  // (Krajský soud v Českých Budějovicích), "č. j. KSHK 33 INS
  // 21809/2019" (Krajský soud v Hradci Králové). The code stays inside
  // the caseNumber capture rather than being a stripped label, because
  // insolvency docket numbers are unique only within the issuing court:
  // dropping the code would fold two different courts' cases into one
  // dedup key whenever they happen to share a senate/registry/docket/
  // year. The code is a bounded 2-5 letter uppercase run so it cannot
  // swallow ordinary prose before an unprefixed case number.
  /[čc]\.\s*j\.:?\s*(?<caseNumber>[A-Z]{2,5}\s{1,3}\d{1,3}\s{0,3}\p{L}{1,6}[\s/]{1,3}\d{1,6}(?:[,/]\s{0,3}\d{1,6})?\/\d{2,4})(?!\d)/gu,

  // Slovak file number: "č. k. 4 Obo 48/02" (číslo konania), the Slovak
  // counterpart to the Czech č. j. above. Lower-court Slovak decisions are
  // sometimes cited only by this file number, with no accompanying sp.
  // zn. form, so without this pattern the citation is dropped entirely.
  new RegExp(String.raw`[čc]\.\s*k\.:?\s*${CASE_NUMBER_BODY}`, "gu"),

  PL_PREFIXED_PATTERN,
  PL_THREE_TOKEN_PATTERN,
  PL_TK_PATTERN,
  PL_TK_BARE_PATTERN,
  PL_BARE_SYMBOL_PATTERN,
  PL_NSA_WSA_PATTERN,

  // Polish case number without prefix: "II CSK 123/20", "II ACa 45/20",
  // "I CSK 379/08" (Supreme Court chambers I-VII are frequently a single
  // Roman digit, and such bare citations -- no "sygn. akt" -- are the
  // normal way one decision cites another in its reasoning), "IIIU
  // 1113/13" (labor/social-insurance division glued to the roman numeral
  // with no space, only ever a single uppercase letter in that glued
  // shape). The spaced division code is an uppercase chamber code (CSK,
  // KK, CSKP) or an uppercase code with an appellate suffix (ACa, ACz,
  // AKa); requiring that shape (and requiring a space before a
  // multi-purpose single letter) stops ordinary mixed-case prose like
  // "Article XV See 12/20" from being captured as a phantom citation. The
  // gap before a multi-letter division is bounded (1-3 characters, not
  // unbounded `\s+`), matching PL_TK_PATTERN/PL_TK_BARE_PATTERN's
  // phantom-duplicate lookbehind exactly: this bare (no "sygn.") form
  // combines a Tribunal-symbol-shaped division ("II SK 12/20") into one
  // citation the same way the prefixed pattern does, so it must stop
  // combining beyond the same gap the lookbehind can still recognize, or
  // the symbol at the tail phantom-duplicates as a second citation.
  /\b[IVX]{1,4}(?:\s{1,3}(?:[A-Z]{2,5}|[A-Z]{1,4}[az])|[A-Z])\s+\d{1,6}\/\d{2,4}\b/gu,

  // Neutral citations: bracketed year, one to three court/division tokens,
  // then the decision number (for example "[2024] Example Court 12"). The
  // bracketed year and final number keep this narrower than an ordinary
  // title or parenthetical date.
  /\[\d{4}\]\s+[A-Z][A-Za-z]{1,9}(?:\s+[A-Z][A-Za-z]{1,9}){0,2}\s+\d{1,6}\b/gu,
];

/**
 * The publications office typesets CJEU numbers with U+2011 or an em/en
 * dash; the corpus stores the ASCII form. Comparisons and dedup keys must
 * not treat the different spellings as different citations.
 */
const normalizeDashes = (text: string): string => text.replace(/[‑–—]/gu, "-");

/**
 * Matches a Czech/Slovak numeric-first case number after whitespace and
 * dot normalization, splitting it into its three components so the dedup
 * key can rebuild them with one canonical separator.
 */
const SEPARATOR_NORMALIZE_RE =
  /^(?<number>\d{1,3})\s?(?<registry>\p{L}{1,6})[\s/](?<docket>\d{1,6}\/\d{2,4})$/u;

/**
 * Matches a Czech/Slovak numeric-first case number whose docket joins a
 * second consolidated docket, comma- or slash-separated, sharing the
 * trailing year ("52,53/2023" or "52/53/2023"), after whitespace/comma
 * normalization. The dedup key always rebuilds the join with a comma,
 * regardless of the source separator, so "36 Co 52,53/2023" and
 * "36 Co 52/53/2023" resolve to one key.
 */
const CONSOLIDATED_DOCKET_NORMALIZE_RE =
  /^(?<number>\d{1,3})\s?(?<registry>\p{L}{1,6})[\s/](?<docket1>\d{1,6})[,/](?<docket2>\d{1,6})\/(?<year>\d{2,4})$/u;

/**
 * Matches a court-code-prefixed Czech numeric-first case number (the
 * insolvency "KSCB 26 INS 8270/2018" shape) after whitespace and dot
 * normalization, splitting off the issuing court's registry code so the
 * dedup key can rebuild the numeric body with one canonical separator
 * while keeping the code itself: it is what makes the docket unique to
 * begin with (rule 17), not a label to strip. "KSCB 26 INS 8270/2018"
 * and "KSCB 26INS/8270/2018" must resolve to the same key. Case-
 * insensitive: this normalizer also runs on a decision's own stored
 * `caseNumber` (via `isSelfCitation`), which is publisher text, not
 * extractor output, so it is never guaranteed to carry the extractor's
 * all-uppercase code spelling ("Msph" vs "MSPH"). The final
 * `.toLowerCase()` on the assembled key already folds the casing, so
 * matching case-insensitively here is enough -- no need to normalize
 * the captured code itself. The registry-to-docket gap accepts a 1-3
 * character run of the extraction pattern's own `[\s/]{1,3}` class, not
 * a single character: the generic whitespace-around-a-slash cleanup
 * above strips space adjacent to each slash but never merges adjacent
 * slashes themselves, so a repeated-slash OCR artifact ("INS//8270")
 * survives as literal "//" into this regex.
 */
const COURT_CODE_NORMALIZE_RE =
  /^(?<code>[A-Z]{2,5})\s(?<number>\d{1,3})\s?(?<registry>\p{L}{1,6})[\s/]{1,3}(?<docket>\d{1,6}\/\d{2,4})$/iu;

/**
 * Matches a court-code-prefixed case number whose docket joins a second
 * consolidated docket, comma- or slash-separated, sharing the trailing
 * year -- the same join the court-code-prefixed extraction pattern
 * accepts (mirroring CASE_NUMBER_BODY_COMMA), now with the issuing
 * court's registry code in front: "KSCB 26 INS 8270,8271/2018" and
 * "KSCB 26 INS 8270/8271/2018" resolve to one key. Same 1-3 character
 * registry-to-docket gap as `COURT_CODE_NORMALIZE_RE`, for the same
 * repeated-slash reason.
 */
const COURT_CODE_CONSOLIDATED_NORMALIZE_RE =
  /^(?<code>[A-Z]{2,5})\s(?<number>\d{1,3})\s?(?<registry>\p{L}{1,6})[\s/]{1,3}(?<docket1>\d{1,6})[,/](?<docket2>\d{1,6})\/(?<year>\d{2,4})$/iu;

/**
 * Matches a Czech/Slovak Constitutional Court case number (chamber,
 * "ÚS" or the diacritic-dropped "US", optional plenary "-st." infix,
 * then the docket) after whitespace/dot normalization, so the dedup key
 * can rebuild it with one canonical (glued, diacritic-restored) spelling:
 * "II.ÚS/251/04", "II.ÚS 251/04", and "II. ÚS 251/04" (the dot before
 * a space is already stripped upstream) all resolve to the same key, and
 * the diacritic-dropped "III.US 364/2017" folds to the same key as
 * "III. ÚS 364/2017". Stored citationText is never touched by this --
 * only the dedup key folds the diacritic.
 *
 * The infix's own trailing dot is optional ("-st\.?", not "-st\."): the
 * upstream trailing-dot-strip step (below) also fires on "t." when it is
 * itself followed by whitespace or a slash (as it always is here, right
 * before the docket), so the dot is already gone by the time this regex
 * runs for most spellings. Requiring it literally would make the infix
 * fail to match and silently fall through to the plain (non-standpoint)
 * reconstruction, colliding a plenary standpoint with an ordinary nález
 * sharing the same digits.
 */
const US_CASE_RE =
  /^(?<chamber>[IVX]{1,4}|Pl|PL)\.?\s?[ÚU]S(?<infix>-st\.?)?[\s/](?<docket>\d{1,5}\/\d{2,4})$/u;

/**
 * Matches a Polish roman-numeral-chamber case number after whitespace
 * normalization, splitting off the chamber from the division code so the
 * dedup key can rebuild the boundary with one canonical (glued) spelling:
 * "IC 1523/96" (glued) and "I C 1523/96" (spaced) must share one key. The
 * space before the division's own docket is likewise optional, so a
 * division glued directly to the docket ("IV P648/03") still matches,
 * alongside the spaced form ("IV P 648/03").
 */
const POLISH_ROMAN_DIVISION_RE =
  /^(?<roman>[IVX]{1,6})\s?(?<division>[A-Za-z]{1,5}\s?.*)$/u;

/**
 * Some Polish division codes are themselves two tokens separated by a
 * space or a slash (an appellate/labor qualifier plus the base code, e.g.
 * "A Ua" or "A/Ua"), which courts also glue together ("AUa"). Applied to
 * the `division` group of `POLISH_ROMAN_DIVISION_RE`, this collapses the
 * first two-token gap to the same glued spelling so "III A Ua 2389/02",
 * "III A/Ua 2389/02", and "III AUa 2389/02" all resolve to one dedup key.
 * The second token is a letter run, never digits, so this never matches
 * an ordinary single-token division directly followed by the docket
 * number ("CSK 123/20").
 */
const POLISH_TWO_WORD_DIVISION_RE =
  /^(?<div1>[A-Za-z]{1,4})[\s/](?<div2>[A-Za-z]{1,5})(?<rest>\s\d.*)$/u;

/**
 * Matches a single-token Polish division code directly followed by the
 * docket, glued or separated by a space ("P648/03" vs "P 648/03"),
 * within the `division` group of `POLISH_ROMAN_DIVISION_RE`. Only tried
 * once the two-token check above has failed. Reconstructs with one space
 * regardless of the source spacing, so "sygn. akt: IV P648/03" and
 * "sygn. akt IV P 648/03" resolve to one dedup key.
 */
const POLISH_LETTERS_DOCKET_RE =
  /^(?<letters>[A-Za-z]{1,5})\s?(?<docket>\d.*)$/u;

/**
 * Collapse spelling variants that would otherwise fracture one real
 * citation into several dedup keys:
 *  - soft hyphens (U+00AD) and NBSP (U+00A0), both seen in the corpus
 *    from PDF text extraction, never load-bearing;
 *  - whitespace runs, including a line-wrap newline landing inside a
 *    matched span ("21\nCdo 1234/2020" vs "21 Cdo 1234/2020");
 *  - whitespace around a hyphen ("C - 679/18", "C- 679/18" -> "C-679/18",
 *    "ÚS – st." -> "ÚS-st.");
 *  - whitespace around a slash ("U 1 /86" -> "U 1/86");
 *  - whitespace after a comma in a consolidated docket ("52, 53/2023" ->
 *    "52,53/2023");
 *  - a trailing dot on a registry abbreviation ("Spr." vs "Spr", "K." vs
 *    "K");
 *  - letter-case differences between an all-caps header and body text;
 *  - the separator between a case's registry code and its docket number,
 *    which filings write as a space or a slash interchangeably ("5 Cdo
 *    260/2008" vs "5Cdo/260/2008", "10C 84/97" vs "10C/84/97", "6CoE
 *    14/2007" vs "6 CoE 14/2007" vs "6CoE/14/2007"), including when a
 *    court registry code leads the number ("KSCB 26 INS 8270/2018" vs
 *    "KSCB 26INS/8270/2018"), including a court-code-prefixed
 *    consolidated docket join ("KSCB 26 INS 8270,8271/2018" vs "KSCB 26
 *    INS 8270/8271/2018");
 *  - the boundary between a Polish roman-numeral chamber and its division
 *    code, glued or spaced ("IC 1523/96" vs "I C 1523/96"), including a
 *    two-token division code ("III A Ua 2389/02" vs "III AUa 2389/02") and
 *    the division-to-docket join ("IV P648/03" vs "IV P 648/03");
 *  - the dot/space/slash boundary and diacritic in a Constitutional Court
 *    citation ("II.ÚS/251/04", "II.ÚS 251/04", "II. ÚS 251/04", and the
 *    diacritic-dropped "III.US 364/2017" all fold to one key);
 *  - the join between two consolidated docket numbers, comma- or
 *    slash-separated ("36 Co 52,53/2023" vs "36 Co 52/53/2023").
 */
const canonicalizeDedupKey = (text: string): string => {
  const cleaned = normalizeDashes(text)
    .replace(/­/gu, "") // soft hyphen: invisible, never load-bearing
    .replace(/\u00A0/gu, " ") // NBSP -> space
    .replace(/\s+/gu, " ") // collapse line-wraps and repeated spaces
    .replace(/\s{0,4}-\s{0,4}/gu, "-") // collapse whitespace around a hyphen
    .replace(/\s{0,4}\/\s{0,4}/gu, "/") // collapse whitespace around a slash
    .replace(/,\s{0,3}/gu, ",") // "52, 53/2023" -> "52,53/2023"
    .replace(/(\p{L})\.(?=[\s/]|$)/gu, "$1") // "Spr." / "K." -> "Spr" / "K"
    .trim();

  const numeric = SEPARATOR_NORMALIZE_RE.exec(cleaned);
  if (numeric?.groups) {
    const canonical = `${numeric.groups["number"]}${numeric.groups["registry"]}/${numeric.groups["docket"]}`;
    return canonical.toLowerCase();
  }

  const consolidated = CONSOLIDATED_DOCKET_NORMALIZE_RE.exec(cleaned);
  if (consolidated?.groups) {
    const canonical = `${consolidated.groups["number"]}${consolidated.groups["registry"]}/${consolidated.groups["docket1"]},${consolidated.groups["docket2"]}/${consolidated.groups["year"]}`;
    return canonical.toLowerCase();
  }

  const courtCode = COURT_CODE_NORMALIZE_RE.exec(cleaned);
  if (courtCode?.groups) {
    const canonical = `${courtCode.groups["code"]} ${courtCode.groups["number"]}${courtCode.groups["registry"]}/${courtCode.groups["docket"]}`;
    return canonical.toLowerCase();
  }

  const courtCodeConsolidated =
    COURT_CODE_CONSOLIDATED_NORMALIZE_RE.exec(cleaned);
  if (courtCodeConsolidated?.groups) {
    const canonical = `${courtCodeConsolidated.groups["code"]} ${courtCodeConsolidated.groups["number"]}${courtCodeConsolidated.groups["registry"]}/${courtCodeConsolidated.groups["docket1"]},${courtCodeConsolidated.groups["docket2"]}/${courtCodeConsolidated.groups["year"]}`;
    return canonical.toLowerCase();
  }

  const usCase = US_CASE_RE.exec(cleaned);
  if (usCase?.groups) {
    const canonical = `${usCase.groups["chamber"]}ÚS${usCase.groups["infix"] ?? ""}${usCase.groups["docket"]}`;
    return canonical.toLowerCase();
  }

  const romanDivision = POLISH_ROMAN_DIVISION_RE.exec(cleaned);
  const roman = romanDivision?.groups?.["roman"];
  const divisionRaw = romanDivision?.groups?.["division"];
  if (roman !== undefined && divisionRaw !== undefined) {
    const twoWord = POLISH_TWO_WORD_DIVISION_RE.exec(divisionRaw)?.groups;
    if (
      twoWord?.["div1"] !== undefined &&
      twoWord["div2"] !== undefined &&
      twoWord["rest"] !== undefined
    ) {
      const division = `${twoWord["div1"]}${twoWord["div2"]}${twoWord["rest"]}`;
      return `${roman}${division}`.toLowerCase();
    }

    const lettersDocket = POLISH_LETTERS_DOCKET_RE.exec(divisionRaw)?.groups;
    const division =
      lettersDocket?.["letters"] !== undefined &&
      lettersDocket["docket"] !== undefined
        ? `${lettersDocket["letters"]} ${lettersDocket["docket"]}`
        : divisionRaw;
    return `${roman}${division}`.toLowerCase();
  }

  const canonical = cleaned;

  return canonical.toLowerCase();
};

/**
 * Strip known prefixes to get the bare case number. `citationText` is
 * stored verbatim, including an embedded line-wrap newline the extraction
 * patterns above deliberately match through (a CRLF landing in a `\s`
 * gap); every capture below needs the dotAll flag or `.+` stops at that
 * newline and truncates the case number instead of spanning it, silently
 * dropping everything after the line break from the persisted key.
 */
const stripPrefix = (text: string): string => {
  const trimmed = text.trim();

  // Czech/Slovak: "sp. zn. 21 Cdo 1234/2020", "sp.zn.: 38Csp/281/2025"
  const spZn = /^sp\.\s*zn\.?:?\s*(?<caseNumber>.+)/isu.exec(trimmed);
  if (spZn?.groups?.["caseNumber"]) {
    return spZn.groups["caseNumber"].trim();
  }

  // Czech: "č. j. 5 As 123/2020", "č.j. 5 As 123/2020", "č. j.: 5 As 123/2020"
  const cj = /^[čc]\.\s*j\.:?\s*(?<caseNumber>.+)/isu.exec(trimmed);
  if (cj?.groups?.["caseNumber"]) {
    return cj.groups["caseNumber"].trim();
  }

  // Slovak: "č. k. 4 Obo 48/02", "č.k. 4 Obo 48/02" (číslo konania)
  const ck = /^[čc]\.\s*k\.:?\s*(?<caseNumber>.+)/isu.exec(trimmed);
  if (ck?.groups?.["caseNumber"]) {
    return ck.groups["caseNumber"].trim();
  }

  // Czech senate file number: "sen. zn. 29 NSČR 55/2013"
  const senZn = /^sen\.\s*zn\.:?\s*(?<caseNumber>.+)/isu.exec(trimmed);
  if (senZn?.groups?.["caseNumber"]) {
    return senZn.groups["caseNumber"].trim();
  }

  // Polish: "sygn. akt II CSK 123/20", "sygn. akt. I CK 363/02", "sygn.
  // akt: I FSK 1261/07" (already case-insensitive via the /i flag,
  // covering the title-case "Sygn. akt" document-header spelling too)
  const sygn = /^sygn\.\s*(?::\s*)?(?:akt\.?:?\s*)?(?<caseNumber>.+)/isu.exec(
    trimmed,
  );
  if (sygn?.groups?.["caseNumber"]) {
    return sygn.groups["caseNumber"].trim();
  }

  return trimmed;
};

type DecisionMetadata = {
  caseNumber: string;
  ecli?: string | null;
  identifiers?: DecisionIdentifiers | undefined;
};

type StoredDecisionMetadata = {
  caseNumber: string;
  ecli: string | null;
  metadata: Record<string, unknown>;
};

const PUBLISHER_CASE_NUMBER_ALIASES_METADATA_KEY = "additionalCaseNumbers";

export const decisionIdentifiersFromMetadata = ({
  caseNumber,
  ecli,
  identifiers,
}: DecisionMetadata): DecisionIdentifiers => {
  const caseNumberIdentifier = {
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value: caseNumber,
  } as const;

  const candidates: DecisionIdentifier[] = [
    caseNumberIdentifier,
    ...(ecli
      ? [{ type: DECISION_IDENTIFIER_TYPES.ECLI, value: ecli } as const]
      : []),
  ];
  if (identifiers !== undefined) {
    candidates.push(...identifiers);
  }
  const normalizedCaseNumber =
    normalizeDecisionIdentifier(caseNumberIdentifier);
  if (!normalizedCaseNumber) {
    throw new TypeError("Decision case number has no searchable content");
  }
  const seen = new Set([
    `${caseNumberIdentifier.type}:${normalizedCaseNumber}`,
  ]);
  const additional = candidates.slice(1).filter((identifier) => {
    const normalized = normalizeDecisionIdentifier(identifier);
    if (!normalized) {
      return false;
    }
    const key = `${identifier.type}:${normalized}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (additional.length >= DECISION_IDENTIFIER_MAX_COUNT) {
    throw new TypeError("Decision has too many identifiers");
  }
  return [caseNumberIdentifier, ...additional];
};

export const decisionIdentifiersFromStoredMetadata = ({
  caseNumber,
  ecli,
  metadata,
}: StoredDecisionMetadata): DecisionIdentifiers => {
  const storedAliasesValue =
    metadata[PUBLISHER_CASE_NUMBER_ALIASES_METADATA_KEY];
  if (!Array.isArray(storedAliasesValue)) {
    return decisionIdentifiersFromMetadata({ caseNumber, ecli });
  }
  // Array.isArray narrows to any[]; keep publisher-owned JSON unknown until
  // each candidate passes the shared identifier schema.
  const storedAliases: unknown[] = storedAliasesValue;

  const capacity = DECISION_IDENTIFIER_MAX_COUNT - (ecli ? 2 : 1);
  const seen = new Set([
    normalizeDecisionIdentifier({
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: caseNumber,
    }),
  ]);
  const aliases: DecisionIdentifier[] = [];
  for (const value of storedAliases) {
    const candidate = {
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value,
    };
    if (!isDecisionIdentifier(candidate)) {
      continue;
    }
    const normalized = normalizeDecisionIdentifier(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    aliases.push(candidate);
    if (aliases.length === capacity) {
      break;
    }
  }
  const [firstAlias, ...otherAliases] = aliases;
  return decisionIdentifiersFromMetadata({
    caseNumber,
    ecli,
    identifiers:
      firstAlias === undefined ? undefined : [firstAlias, ...otherAliases],
  });
};

/**
 * Canonical comparison key for a citation or case number: prefix
 * stripped, then run through `canonicalizeDedupKey`. Exported so callers
 * needing the bare case number for display or comparison share the exact
 * same normalization as the extractor's own dedup key.
 */
export const bareCitationKey = (text: string): string =>
  canonicalizeDedupKey(stripPrefix(text));

/**
 * The value that goes in a `citation_key` column, for every writer of one.
 *
 * Null, never the empty string, when the text does not canonicalize. The two
 * spellings are not interchangeable: null keeps a row out of the resolver's
 * equality join, while '' matches every other row that also failed to
 * canonicalize, drawing edges between unrelated cases. Two writers once
 * disagreed about which to use, so the choice lives here rather than at each
 * call site, and the database refuses the loser (`citation_key <> ''`).
 */
export const citationKeyOf = (text: string): string | null =>
  bareCitationKey(text) || null;

export const normalizeDecisionIdentifier = (
  identifier: DecisionIdentifier,
): string => {
  switch (identifier.type) {
    case DECISION_IDENTIFIER_TYPES.CASE_NUMBER:
      return bareCitationKey(identifier.value);
    case DECISION_IDENTIFIER_TYPES.ECLI:
    case DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION:
    case DECISION_IDENTIFIER_TYPES.REPORTER_CITATION:
      return normalizeStructuredDecisionIdentifier(identifier);
    default: {
      const unhandled: never = identifier;
      return panic(`Unhandled decision identifier: ${String(unhandled)}`);
    }
  }
};

export const normalizeDecisionIdentifierValue = (
  type: DecisionIdentifierType,
  value: string,
): string => {
  switch (type) {
    case DECISION_IDENTIFIER_TYPES.CASE_NUMBER:
      return normalizeDecisionIdentifier({ type, value });
    case DECISION_IDENTIFIER_TYPES.ECLI:
      return normalizeDecisionIdentifier({ type, value });
    case DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION:
      return normalizeDecisionIdentifier({ type, value });
    case DECISION_IDENTIFIER_TYPES.REPORTER_CITATION:
      return normalizeDecisionIdentifier({ type, value });
    default: {
      const exhaustive: never = type;
      return panic(`Unhandled decision identifier type: ${String(exhaustive)}`);
    }
  }
};

/**
 * Check whether a citation text refers to the same decision that
 * contains it (self-citation).
 */
export const isSelfCitation = (
  citationText: string,
  identifiers: DecisionIdentifiers,
): boolean =>
  identifiers.some(
    (identifier) =>
      normalizeDecisionIdentifierValue(identifier.type, citationText) ===
      normalizeDecisionIdentifier(identifier),
  );

export const decisionIdentifierTypeOfCitation = (
  citationText: string,
): DecisionIdentifierType => {
  if (/^(?:ECLI:|EU:[CTF]:)/u.test(citationText)) {
    return DECISION_IDENTIFIER_TYPES.ECLI;
  }
  if (/^\[\d{4}\]/u.test(citationText)) {
    return DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION;
  }
  if (/\bSb\.\s*(?:rozh\.|NSS|NS)/iu.test(citationText)) {
    return DECISION_IDENTIFIER_TYPES.REPORTER_CITATION;
  }
  return DECISION_IDENTIFIER_TYPES.CASE_NUMBER;
};

/**
 * Extract citation references from decision text.
 *
 * Scans each section of the decision for patterns matching known
 * citation formats. Returns deduplicated citations with their source
 * section index.
 */
export const extractCitations = (
  sections: { index: number; text: string }[],
): ExtractedCitation[] => {
  const byKey = new Map<string, ExtractedCitation>();
  // Keys whose occurrences named two different types. One text calling the
  // same docket both a nález and an usnesení is naming two documents, and a
  // single hint would pick one of them by occurrence order.
  const conflictingHints = new Set<string>();

  for (const section of sections) {
    for (const pattern of CITATION_PATTERNS) {
      pattern.lastIndex = 0;

      for (
        let match = pattern.exec(section.text);
        match !== null;
        match = pattern.exec(section.text)
      ) {
        // citationText is stored verbatim (only edge-trimmed), never
        // whitespace-normalized: exact-passage anchoring must be able to
        // find this exact string in the source document, including an
        // embedded line-wrap newline. Only the dedup key below is
        // canonicalized.
        const citationText = match[0].trim();
        const identifierType = decisionIdentifierTypeOfCitation(citationText);
        // For patterns with a capture group (e.g. the Polish prefixed
        // pattern), use the bare case number as the canonical dedup key
        // so both "sygn. akt II CSK 123/20" and "II CSK 123/20" resolve
        // to the same key regardless of which fires first.
        // canonicalizeDedupKey further folds whitespace/separator/case
        // spelling variance so the same real case number never fractures
        // into two keys.
        const dedupValue = match.groups?.["caseNumber"]?.trim() ?? citationText;
        const dedupKey = `${identifierType}:${normalizeDecisionIdentifierValue(identifierType, dedupValue)}`;

        const citedDecisionTypeHint = detectCitationDecisionTypeHint(
          section.text,
          match.index,
        );

        const existing = byKey.get(dedupKey);
        if (!existing) {
          byKey.set(dedupKey, {
            citationText,
            sectionIndex: section.index,
            citedDecisionTypeHint,
            identifierType,
          });
          continue;
        }
        // Prefer a later occurrence over an earlier one: a case is often
        // listed bare in the header (low section index) and then discussed
        // in the reasoning. The discussion carries the polarity signal, so
        // record the later section's context, not the header's. The type
        // hint is the exception: any occurrence that names the type is
        // better than one that does not, so a hint, once seen, stays;
        // unless a later occurrence names a different type, which leaves
        // the key without a hint for the resolver to treat as ambiguous.
        if (
          existing.sectionIndex === null ||
          section.index > existing.sectionIndex
        ) {
          existing.citationText = citationText;
          existing.sectionIndex = section.index;
        }
        if (citedDecisionTypeHint === null || conflictingHints.has(dedupKey)) {
          continue;
        }
        if (
          existing.citedDecisionTypeHint !== null &&
          existing.citedDecisionTypeHint !== citedDecisionTypeHint
        ) {
          conflictingHints.add(dedupKey);
          existing.citedDecisionTypeHint = null;
          continue;
        }
        existing.citedDecisionTypeHint = citedDecisionTypeHint;
      }
    }
  }

  return [...byKey.values()];
};
