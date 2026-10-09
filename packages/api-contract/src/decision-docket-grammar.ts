// parser-output-unchanged: A grammar's format spells a reader's docket family only; ingestion reads acceptance and the case-file key, both from the input.
import { panic } from "better-result";

import { normalizeUnicode, stripUnicodeMarks } from "@stll/text-normalize";

import type { CaseLawJurisdiction } from "./case-law-jurisdictions";

/** A normalized docket accepted by one jurisdiction's declared grammar. */
export type ParsedDecisionDocket<TJurisdiction extends string = string> = {
  readonly jurisdiction: TJurisdiction;
  readonly formatted: string;
  readonly canonical: string;
};

type DecisionDocketGrammarFor<TJurisdiction extends string> = {
  readonly jurisdiction: TJurisdiction;
  readonly parse: (raw: string) => ParsedDecisionDocket<TJurisdiction> | null;
};

/**
 * Every dash a publisher types where a docket means a hyphen, as a character
 * class body.
 *
 * The range is U+2010 HYPHEN through U+2015 HORIZONTAL BAR plus U+2212 MINUS
 * SIGN: a court's typesetter writes the sheet separator in `8 As 287/2020-33`
 * with the non-breaking U+2011 as readily as with an ASCII hyphen, and a
 * PDF-to-text pass leaves any of the others behind. Exported as a source
 * rather than a helper because the consumers are regular expressions as often
 * as they are string replacements, and a second hand-written class is the way
 * one spelling silently stops matching.
 *
 * The ASCII hyphen leads, where a character class reads it as a literal, so a
 * consumer can append its own members without minting a reversed range.
 */
export const DECISION_DASH_CLASS_SOURCE = String.raw`-‐-―−`;

const DECISION_DASH_RE = new RegExp(`[${DECISION_DASH_CLASS_SOURCE}]`, "gu");
const DECISION_SHEET_SUFFIX_RE = /-\d{1,4}$/u;

/**
 * Normalize compatibility characters, dash styles, and whitespace before a
 * jurisdiction grammar reads an identifier.
 */
export const foldDecisionIdentifierInput = (raw: string): string =>
  normalizeUnicode(raw, "NFKC")
    .replace(DECISION_DASH_RE, "-")
    .replace(/\s+/gu, " ")
    .trim();

export const canonicalDecisionIdentifierKey = (value: string): string =>
  stripUnicodeMarks(
    foldDecisionIdentifierInput(value).replace(DECISION_SHEET_SUFFIX_RE, ""),
    { form: "NFKD", markClass: "combining" },
  )
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, "");

const canonicalDocketKey = canonicalDecisionIdentifierKey;

type CreateDecisionDocketGrammarOptions<TJurisdiction extends string> = {
  readonly jurisdiction: TJurisdiction;
  readonly patterns: readonly RegExp[];
  /** The case-file key of an accepted docket, as folded input. */
  readonly canonicalize: (folded: string) => string;
  /**
   * An accepted docket as its court writes it. A reader's family is keyed by
   * the function that keys a stored docket (`citation_key`), which reads the
   * court's spelling, so a lead word, a lower-case chamber numeral or a
   * glued registry the court never prints would key apart from the stored
   * row. Grammars whose every accepted spelling already keys alike keep the
   * input (`asWritten`).
   */
  readonly format: (folded: string) => string;
};

/** The format of a grammar whose accepted spellings all key alike. */
const asWritten = (folded: string): string => folded;

const createDecisionDocketGrammar = <const TJurisdiction extends string>({
  canonicalize,
  format,
  jurisdiction,
  patterns,
}: CreateDecisionDocketGrammarOptions<TJurisdiction>): DecisionDocketGrammarFor<TJurisdiction> => ({
  jurisdiction,
  parse: (raw) => {
    const folded = foldDecisionIdentifierInput(raw);
    if (!patterns.some((pattern) => pattern.test(folded))) {
      return null;
    }
    // The case-file key reads the input, not the court spelling, so the key
    // a stored docket was given cannot move when a format changes.
    return {
      jurisdiction,
      formatted: format(folded),
      canonical: canonicalize(folded),
    };
  },
});

/**
 * Docket grammar of the Polish administrative courts, as the NSA's internal
 * rules prescribe it (Zarządzenie nr 14 Prezesa NSA z 6 sierpnia 2015 r.,
 * §§ 69, 78, 79), plus the forms the NSA used before the 2004 reform. Shared
 * by the search grammar below and the citation extractor.
 *
 * - Regional courts (WSA): `<division> <register>/<seat> <number>/<yy>`,
 *   "I SA/Wa 123/20", "II SAB/Wa 11/04".
 * - Supreme Administrative Court (NSA): `<division> <chamber><register>
 *   <number>/<yy>`, "II FSK 1226/21", "I OZ 45/23", "II GPS 1/17".
 * - Before 2004 the NSA sat in Warsaw and in branch seats and wrote the same
 *   slash form, often without a division ("SA/Wr 1234/98"), a seatless one
 *   for Warsaw ("III SA 1234/01"), and bare resolution marks ("FPS 1/99").
 *
 * Registers and marks are matched in capitals only: a common court's
 * registers are title case ("XXIII Gz 12/20" is a regional commercial
 * court), and only the all-caps spelling is the administrative court's.
 */

const alternation = (items: readonly string[]): string =>
  `(?:${items.toSorted((a, b) => b.length - a.length).join("|")})`;

/**
 * Seats as the registers abbreviate them. `Ka` (Katowice) and `Ł` (Łódź)
 * are pre-2004 branch seats.
 */
const PL_ADMINISTRATIVE_SEATS = [
  "Bk",
  "Bd",
  "Gd",
  "Gl",
  "Go",
  "Ke",
  "Kr",
  "Lu",
  "Łd",
  "Ol",
  "Op",
  "Po",
  "Rz",
  "Sz",
  "Wa",
  "Wr",
  "Ka",
  "Ł",
] as const;

/** Each seat as written and in capitals ("SA/WR"), never lower case. */
const PL_ADMINISTRATIVE_SEAT_SPELLINGS = PL_ADMINISTRATIVE_SEATS.flatMap(
  (seat) => [seat, seat.toUpperCase()],
);

/** Regional-court registers that carry a seat (§ 69). */
const PL_WSA_REGISTERS = ["SA", "SAB", "SPP", "SO"] as const;

/** Regional courts have up to eight divisions (Warsaw); the NSA has three. */
const PL_WSA_DIVISIONS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
const PL_NSA_DIVISIONS = ["I", "II", "III"];

/**
 * Divisions that wrote the seatless Warsaw form: the NSA's three before
 * 2004, and the Warsaw regional court's first six through 2006.
 */
const PL_SEATLESS_DIVISIONS = ["I", "II", "III", "IV", "V", "VI"];

/** NSA chambers: financial, commercial, general-administrative. */
const PL_NSA_CHAMBERS = ["F", "G", "O"] as const;

/**
 * NSA registers, each written after the chamber letter (§ 78): `SK`
 * cassation appeals, `Z` interlocutory complaints, `W` applications, `PP`
 * complaints of delay, `NP` complaints that a final judgment is unlawful,
 * `OK` appeals against resolutions of the National Council of the
 * Judiciary ("II GOK 2/18"), `KW` complaints against decisions of the
 * State Electoral Commission ("II OKW 1/24"), and `PS` resolutions.
 */
const PL_NSA_REGISTERS = [
  "SK",
  "Z",
  "W",
  "PP",
  "NP",
  "OK",
  "KW",
  "PS",
] as const;

const PL_NSA_MARKS = PL_NSA_CHAMBERS.flatMap((chamber) =>
  PL_NSA_REGISTERS.map((register) => `${chamber}${register}`),
);

/** Pre-2004 resolution registers, cited with no division. */
const PL_PRE_REFORM_RESOLUTION_MARKS = ["FPS", "OPS", "FPK", "OPK"] as const;

/**
 * Chamber-prefixed `SA` marks the NSA wrote with no division around the
 * reform ("FSA 12/03"); its bare `SA` ("SA 123/98") is pre-2004 only.
 */
const PL_TRANSITIONAL_BARE_MARKS = ["OSA", "FSA"] as const;

/** Two-digit years before the 1 January 2004 reform. */
const PL_PRE_REFORM_YEAR = String.raw`(?:[89]\d|0[0-3])`;

/** The same, through the 2004-2006 transition. */
const PL_TRANSITIONAL_YEAR = String.raw`(?:[89]\d|0[0-6])`;

/** The first two years of the reformed NSA, when its marks carried no division. */
const PL_UNDIVIDED_NSA_YEAR = String.raw`0[45]`;

/** A number, or a joined range of numbers ("1234-1236"), before the year. */
const PL_ADMINISTRATIVE_ORDINAL = String.raw`\d{1,6}(?:[${DECISION_DASH_CLASS_SOURCE}]\d{1,6})?`;

const PL_ADMINISTRATIVE_NUMBER = String.raw`${PL_ADMINISTRATIVE_ORDINAL}\/\d{2}(?:\d{2})?`;

/**
 * The seated form, with or without a division, which may be glued to the
 * register: "III SA/Gl 1234/19", "SA/Wr 1234/98", "IISA/WR 12/01".
 */
export const PL_ADMINISTRATIVE_SEATED_DOCKET_SOURCE = String.raw`(?:${alternation(PL_WSA_DIVISIONS)}\s{0,3})?${alternation(PL_WSA_REGISTERS)}\s{0,3}\/\s{0,3}${alternation(PL_ADMINISTRATIVE_SEAT_SPELLINGS)}\s{1,3}${PL_ADMINISTRATIVE_NUMBER}`;

/**
 * The seatless Warsaw form before and through the transition: "III SA
 * 1234/01", "IV SA 123/04", "IV SAB 12/05", "I SA 1234-1236/98".
 */
export const PL_ADMINISTRATIVE_SEATLESS_DOCKET_SOURCE = String.raw`${alternation(PL_SEATLESS_DIVISIONS)}\s{0,3}SAB?\s{1,3}${PL_ADMINISTRATIVE_ORDINAL}\/${PL_TRANSITIONAL_YEAR}`;

/** The registers the NSA wrote with no division in 2004 and 2005. */
const PL_UNDIVIDED_NSA_MARKS = PL_NSA_CHAMBERS.flatMap((chamber) =>
  ["SK", "Z", "W", "PP", "PS"].map((register) => `${chamber}${register}`),
);

/**
 * NSA marks with no division, as written in 2004 and 2005: "FSK 123/04",
 * "OZ 12/05", "OPP 3/04", "FPS 1/04".
 */
const PL_UNDIVIDED_NSA_DOCKET_SOURCE = String.raw`${alternation(PL_UNDIVIDED_NSA_MARKS)}\s{1,3}${PL_ADMINISTRATIVE_ORDINAL}\/${PL_UNDIVIDED_NSA_YEAR}`;

/**
 * The bare pre-reform marks: "SA 123/98", "FSA 12/03". `SA` is also how a
 * company name ends ("Bank SA"), so the extractor reads these only after a
 * `sygn.` label; as a whole case number they are unambiguous.
 */
const PL_PRE_REFORM_BARE_DOCKET_SOURCE = String.raw`(?:SA\s{1,3}${PL_ADMINISTRATIVE_ORDINAL}\/${PL_PRE_REFORM_YEAR}|${alternation(PL_TRANSITIONAL_BARE_MARKS)}\s{1,3}${PL_ADMINISTRATIVE_ORDINAL}\/${PL_TRANSITIONAL_YEAR})`;

/**
 * A pre-2004 resolution cited bare: "FPS 1/99", "OPS 3/98", "OPK 12-14/98".
 * The year is held to the pre-reform range and each number to two digits,
 * which is what keeps
 * the same letters in ordinary prose from reading as a docket.
 */
export const PL_ADMINISTRATIVE_PRE_REFORM_RESOLUTION_SOURCE = String.raw`${alternation(PL_PRE_REFORM_RESOLUTION_MARKS)}\s{1,3}\d{1,2}(?:[${DECISION_DASH_CLASS_SOURCE}]\d{1,2})?\/${PL_PRE_REFORM_YEAR}`;

const PL_ADMINISTRATIVE_DOCKET_RES = [
  new RegExp(`^${PL_ADMINISTRATIVE_SEATED_DOCKET_SOURCE}$`, "u"),
  new RegExp(`^${PL_ADMINISTRATIVE_SEATLESS_DOCKET_SOURCE}$`, "u"),
  new RegExp(
    String.raw`^${alternation(PL_NSA_DIVISIONS)} ${alternation(PL_NSA_MARKS)} ${PL_ADMINISTRATIVE_NUMBER}$`,
    "u",
  ),
  new RegExp(`^${PL_ADMINISTRATIVE_PRE_REFORM_RESOLUTION_SOURCE}$`, "u"),
  new RegExp(`^${PL_UNDIVIDED_NSA_DOCKET_SOURCE}$`, "u"),
  new RegExp(`^${PL_PRE_REFORM_BARE_DOCKET_SOURCE}$`, "u"),
] as const;

/** A number and a slash some registers print ahead of the docket. */
const PL_ADMINISTRATIVE_LEAD_RE = /^\d{1,4} ?\/ ?(?=[IVX])/u;

/**
 * The Polish administrative-court docket a case number spells, with a
 * leading `N/` dropped ("12/II SA/Po 1234/99"), or null when it is not one.
 * The lead is dropped only when what follows is a whole docket.
 */
export const polishAdministrativeDocketOf = (
  caseNumber: string,
): string | null => {
  const folded = normalizeUnicode(caseNumber, "NFC")
    .replace(/\s+/gu, " ")
    .trim();
  for (const candidate of [
    folded,
    folded.replace(PL_ADMINISTRATIVE_LEAD_RE, ""),
  ]) {
    if (PL_ADMINISTRATIVE_DOCKET_RES.some((re) => re.test(candidate))) {
      return candidate;
    }
  }
  return null;
};

/**
 * Krajowa Izba Odwoławcza (public-procurement appeals) dockets: "KIO
 * 1234/24", the earlier "KIO/UZP 1188/08", and appeals decided together
 * ("KIO 2845/25, KIO 2846/25").
 */
const POL_KIO_SINGLE_DOCKET_SOURCE = String.raw`KIO(?:(?: ?\/ ?| )UZP)? \d{1,6}\/\d{2}`;

/** A KIO docket, joined ones included. Exported for the citation extractor. */
export const PL_KIO_DOCKET_SOURCE = String.raw`${POL_KIO_SINGLE_DOCKET_SOURCE}(?:, ?${POL_KIO_SINGLE_DOCKET_SOURCE})*`;

const POL_KIO_DOCKET_RE = new RegExp(`^${PL_KIO_DOCKET_SOURCE}$`, "iu");

/**
 * A KIO docket's comparison spelling, `KIO/UZP` and `KIO UZP` alike and the
 * joins spaced one way ("kio/uzp 1188/08", "kio 2845/25,kio 2846/25"), or
 * null when the text is not one.
 */
export const polishKioDocketKey = (caseNumber: string): string | null => {
  const folded = caseNumber.replace(/\s+/gu, " ").trim();
  return POL_KIO_DOCKET_RE.test(folded)
    ? folded
        .toLowerCase()
        .replace(/kio(?: ?\/ ?| )uzp/gu, "kio/uzp")
        .replace(/, ?/gu, ",")
    : null;
};

/**
 * A Polish authority's file number ("znak sprawy") in the form the data
 * protection authority (UODO) uses: an all-caps cell code, dot-separated
 * numeric groups, the year last ("DKN.5131.6.2024", "ZSOŚS.440.82.2019").
 * At least two groups before the year, and nothing but digits after the
 * code, which keeps out statute references ("Dz.U.2024.1061") and tax
 * rulings' signatures, whose code carries digits and dashes.
 */
export const PL_AUTHORITY_FILE_NUMBER_SOURCE = String.raw`\p{Lu}{2,6}(?:\.\d{1,6}){2,}\.(?:19|20)\d{2}`;

const PL_AUTHORITY_FILE_NUMBER_RE = new RegExp(
  `^${PL_AUTHORITY_FILE_NUMBER_SOURCE}$`,
  "u",
);

/**
 * A decision number of the competition and consumer protection authority
 * (Prezes UOKiK), as its register prints it: the issuing unit's all-caps
 * code, an optional division numeral or number, the decision's ordinal and
 * the four-digit year ("DOK-1/2020", "RŁO-7/2025", "DIH-II-34/2026",
 * "DNR-1-20/2026"). Spaces around a hyphen fold away, since a decision's
 * own header often prints "DKK - 212/2026". Capitals only and a four-digit
 * year, so a common court's docket ("II K 12/20") never reads as one.
 */
export const PL_UOKIK_DECISION_NUMBER_SOURCE = String.raw`\p{Lu}{3,5}(?: ?- ?(?:[IVX]{1,4}|\d{1,2}))? ?- ?\d{1,4}\/(?:19|20)\d{2}`;

const PL_UOKIK_DECISION_NUMBER_RE = new RegExp(
  `^${PL_UOKIK_DECISION_NUMBER_SOURCE}$`,
  "u",
);

/**
 * The same number as prose cites it: the register's hyphens, or a space where
 * the register prints the hyphen before the ordinal ("Nr RKR 51/2006",
 * "decyzja nr RPZ 30/2005"), any dash spelling, spaced or not. Wider than the
 * grammar, which reads the register's own spelling only: a space form is also
 * how ministries number their files ("MZDR 6206/2025"), so only a citation
 * read beside its own cue may use it.
 */
export const PL_UOKIK_CITED_DECISION_NUMBER_SOURCE = String.raw`\p{Lu}{3,5}(?:\s?[${DECISION_DASH_CLASS_SOURCE}]\s?(?:[IVX]{1,4}|\d{1,2}))?(?:\s?[${DECISION_DASH_CLASS_SOURCE}]\s?|\s)\d{1,4}\/(?:19|20)\d{2}`;

/**
 * Constitutional Tribunal (TK) case prefixes, as the Tribunal prints them:
 * "K 2/26", "SK 12/20", "Kpt 1/17", "Ts 123/19". There is no division, which
 * is what tells "K 12/20" from a common court's "II K 12/20".
 */
const PL_TK_PREFIXES = [
  "K",
  "SK",
  "P",
  "U",
  "W",
  "S",
  "Kp",
  "Pp",
  "Kpt",
  "Uw",
  "Kw",
  "Ts",
  "Tw",
  "T",
] as const;

/**
 * Prefixes distinctive enough to read without a cue. A lone capital, and
 * `Uw` or `Kw`, is also a common-court register or an ordinary abbreviation,
 * so the extractor reads those only near a Tribunal cue.
 */
const PL_TK_DISTINCTIVE_PREFIXES = ["SK", "Kp", "Pp", "Kpt", "Ts", "Tw"];

/** Each prefix as printed and in capitals ("KPT"), never lower case. */
const PL_TK_PREFIX_SPELLINGS = PL_TK_PREFIXES.flatMap((prefix) => [
  prefix,
  prefix.toUpperCase(),
]);

const PL_TK_NUMBER = String.raw`\.?\s{0,3}\d{1,4}\/\d{2}(?:\d{2})?`;

/** A TK docket under any prefix: "K 2/26", "U. 4/86". */
export const PL_TK_DOCKET_SOURCE = String.raw`${alternation(PL_TK_PREFIX_SPELLINGS)}${PL_TK_NUMBER}`;

/** A TK docket under a prefix that reads as one without a cue. */
export const PL_TK_DISTINCTIVE_DOCKET_SOURCE = String.raw`${alternation(PL_TK_DISTINCTIVE_PREFIXES)}${PL_TK_NUMBER}`;

const PL_TK_DOCKET_RE = new RegExp(`^${PL_TK_DOCKET_SOURCE}$`, "u");

/** Whether a bare case number is a TK docket, prefix as printed or in capitals. */
export const isPolishConstitutionalDocket = (caseNumber: string): boolean =>
  PL_TK_DOCKET_RE.test(caseNumber.trim());

const PL_TK_KEY_RE = new RegExp(
  String.raw`^(?<prefix>${alternation(PL_TK_PREFIXES)})\.?\s{0,3}(?<number>\d{1,4}\/\d{2}(?:\d{2})?)$`,
  "iu",
);

/**
 * A TK docket's comparison spelling, with the dot after the prefix and the
 * letter case ignored, as the Tribunal's own sources differ on both ("U. 4/86"
 * and "U 4/86"): `u 4/86`. Null for anything else.
 */
export const polishConstitutionalDocketKey = (
  caseNumber: string,
): string | null => {
  const groups = PL_TK_KEY_RE.exec(caseNumber.trim())?.groups;
  const prefix = groups?.["prefix"];
  const number = groups?.["number"];
  return prefix === undefined || number === undefined
    ? null
    : `${prefix} ${number}`.toLowerCase();
};

/**
 * A Czech docket introduced by a senate number or a chamber numeral: `21 Cdo
 * 1234/2020`, `29 NSČR 55/2013`, `IV. ÚS 23/05`. Case-insensitive, because the
 * registry mark is written all-caps (`NSČR`, `ÚS`) and title-case (`Cdo`,
 * `As`) by different courts and lowercase by a reader typing a query.
 */
const CZE_SENATE_DOCKET_RE =
  /^(?:(?:pl|i|ii|iii|iv)\.? ?|\d{1,3} ?)(?:\d{1,3} ?)?\p{L}{1,7}\.? \d{1,6}\/\d{2}(?:\d{2})?(?:-\d{1,4})?$/iu;

/**
 * A Czech docket whose registry mark stands alone, with no senate number in
 * front: `Nad 224/2014`, `Konf 4/2011`, `Nt 408/2023`, `A 9/2003`.
 *
 * Case-sensitive on purpose, and this is the one place in the grammars where
 * casing carries meaning. Court registry marks are title-case in this
 * position, while an agency file number under the same `č. j.` label is an
 * all-caps ministry acronym (`MZDR 6206/2025`). Nothing else in the shape
 * tells the two apart, so a case-insensitive pattern here accepts every
 * ministry reference as a court docket. The cost is that a reader typing such
 * a docket all-lowercase reaches full-text search instead of the exact-docket
 * branch.
 */
const CZE_LETTER_FIRST_DOCKET_RE =
  /^\p{Lu}\p{Ll}{0,6}\.? \d{1,6}\/\d{2}(?:\d{2})?(?:-\d{1,4})?$/u;

const CZE_DOCKET_PATTERNS = [
  CZE_SENATE_DOCKET_RE,
  CZE_LETTER_FIRST_DOCKET_RE,
] as const;

const CZE_CONSTITUTIONAL_DOCKET_RE =
  /^(?<senate>pl|iv|i{1,3})\.? ?[úu]s (?<docket>\d{1,6}\/\d{2}(?:\d{2})?)$/iu;

/**
 * A Czech docket as the courts write it. A Constitutional Court docket takes
 * the court's spelling (`IV. ÚS 23/05`, `Pl. ÚS 1/20`): the stored key reads
 * a senate numeral only in capitals once a part follows the docket, so
 * `iv. ús 23/05 - II.` keyed apart from the stored sibling. Every other
 * accepted spelling already keys as the stored docket.
 */
const formatCzechDocket = (folded: string): string => {
  const groups = CZE_CONSTITUTIONAL_DOCKET_RE.exec(folded)?.groups;
  const senate = groups?.["senate"];
  const docket = groups?.["docket"];
  if (senate === undefined || docket === undefined) {
    return folded;
  }
  const numeral = senate.toLowerCase() === "pl" ? "Pl" : senate.toUpperCase();
  return `${numeral}. ÚS ${docket}`;
};
const SVK_DOCKET_RE =
  /^(?<senate>\d{1,3}) ?(?<registry>\p{L}{1,7})(?: ?\/ ?| )(?<ordinal>\d{1,6})\/(?<year>\d{4})$/iu;
/**
 * A Slovak Constitutional Court docket: a Roman senate numeral or `PL.` for
 * the plenum, `ÚS`, the number and the year as the court wrote it (two digits
 * in older dockets, four in newer ones): `II. ÚS 55/98`, `PL. ÚS 3/2019`.
 * Readers drop the dot, the space or the accent (`IV. US 221/04`,
 * `II.ÚS 55/98`), so each is optional, save that the senate stays apart from
 * `ÚS` (`plus 5/98` is prose). The court's case lists join `ÚS` to the
 * number with a slash (`II.ÚS/251/04`), which ingestion keys alike. The year
 * keeps its width, because the stored key does.
 */
const SVK_CONSTITUTIONAL_DOCKET_RE =
  /^(?<senate>pl|iv|i{1,3})(?:\. ?| )[úu]s(?: ?\/ ?| ?)(?<ordinal>\d{1,5})\/(?<year>\d{2}|\d{4})$/iu;
/**
 * A Hungarian docket, as the court registry decrees (Büsz. and the OBH's
 * successor rules) prescribe it: an optional Arabic panel number, the registry
 * letters, an optional Roman panel numeral, the register number, the filing
 * year, and, above first instance, the document number.
 *
 * `Pfv.IV.20.123/2020/5` is the Kúria's review register, `Kfv.35.123/2021/8`
 * the same without a panel numeral, and `5.P.21.203/2004.` a first-instance
 * docket, whose panel number leads and whose trailing dot is part of how the
 * court writes it. The register number is typeset with a thousands dot
 * (`20.123`) by the courts and without it (`20123`) by several databases, so
 * both are accepted and the canonical key keeps the digits only.
 */
const HUN_DOCKET_RE =
  /^(?:(?<panel>\d{1,3})\.)?(?<registry>\p{L}{1,5})\.(?:(?<numeral>[ivxlc]{1,5})\.)?(?<register>\d{1,3}\.\d{3}|\d{1,6})\/(?<year>\d{4})(?:\/(?<document>\d{1,4}))?\.?$/iu;
const HUN_DOCKET_PATTERNS = [HUN_DOCKET_RE] as const;
const POL_DOCKET_RE =
  /^(?<chamber>[ivx]{1,5}) (?<division1>\p{L}{1,5})(?:[ /](?<division2>\p{L}{1,5}))? (?<ordinal>\d{1,6})\/(?<year>\d{2}(?:\d{2})?)$/iu;
/**
 * The signature the tax administration gives an interpretation or a ruling,
 * one entry per numbering scheme it has used. None of them contains a space,
 * and every court docket above does, so the two families cannot claim one
 * another's numbers.
 */
const POL_TAX_SIGNATURE_PATTERNS = [
  // An office of the National Revenue Administration, from 2017:
  // `0114-KDIP1-2.4012.123.2024.1.AB`, `1401-ICW.421.21.2023.13.WCH`,
  // `0114-KDIP3-1.4011.419.2018.1.KS1`, `0114-KDIP2-1.4011.257.2021.2.KW/PD`.
  /^\d{4}-\p{L}[\p{L}\d-]{1,11}(?=.*\.\d{4}\.)(?:\.[\p{L}\d]{1,8}){4,8}(?:\/\p{L}{1,4})?$/iu,
  // A department of the ministry: `DD4.8201.2.2026`,
  // `DOP3.8222.23.2026.EILK`, `PT8.8101.47.2015/WCH/179`.
  /^(?=.*\.\d{4}(?:[./]|$))\p{L}{2,4}\d{1,2}(?:\.[\p{L}\d]{1,8}){3,6}(?:\/[\p{L}\d]{1,6}){0,2}$/iu,
  // A tax chamber or the ministry before 2017, which numbered by hand:
  // `IPPB3/423-1234/08-2/JG`, `IP-PB3-423-655/08-3/MB`,
  // `ITPB1/423-39/a/07/AW`, `DD4/033/0892/KOI/07/PK-331`. An office code, then
  // segments joined by slashes and hyphens, at least one of each and one
  // number of three digits or more among them.
  /^(?=[^/]*\/)(?=[^-]*-)(?=.*\d{3})(?:\p{L}-)?\p{L}{2,6}(?:-\p{L}{1,4})?\d{0,2}(?:[/-][\p{L}\d]{1,10}){3,8}$/iu,
] as const;
const POL_DOCKET_PATTERNS = [
  POL_DOCKET_RE,
  // A reader types an administrative docket in any case.
  ...PL_ADMINISTRATIVE_DOCKET_RES.map((re) => new RegExp(re.source, "iu")),
  POL_KIO_DOCKET_RE,
  // As printed, never lower case: "k 2/26" is not a Tribunal docket.
  PL_TK_DOCKET_RE,
  PL_AUTHORITY_FILE_NUMBER_RE,
  ...POL_TAX_SIGNATURE_PATTERNS,
  PL_UOKIK_DECISION_NUMBER_RE,
] as const;
const EU_DOCKET_PATTERNS = [
  /^(?:(?:case|vec|věc|sprawa|affaire|rechtssache|causa|asunto) )?[ctf]-\d{1,4}\/\d{2}(?: p)?$/iu,
] as const;
const EU_DOCKET_LEAD_RE =
  /^(?:case|vec|věc|sprawa|affaire|rechtssache|causa|asunto) /iu;
const AUT_DOCKET_PATTERNS = [
  /^\d{1,3} ?[a-z]{1,4} ?\d{1,5}\/\d{2}[a-z]$/iu,
  /^r[aow] ?\d{4}\/\d{2}\/\d{4}$/iu,
  /^[a-z]{1,2} ?\d{1,4}\/\d{4}(?:-\d{1,3})?$/iu,
  /^[a-z]{1,3}\/\d{1,8}\/\d{4}$/iu,
] as const;

/**
 * A Polish court docket's chamber numeral, spaced from its division or glued
 * to an administrative register (`IISA/WR 12/01`). Only a chamber is
 * followed by either, so a tax signature or a Tribunal prefix never matches.
 */
const POL_CHAMBER_NUMERAL_RE = /^[ivx]{1,5}(?=\s|s(?:a|pp|o))/iu;

/**
 * A Polish docket with its chamber numeral in capitals, as every court
 * prints it: the stored key reads a chamber only in capitals, so
 * `ii csk 1/99` keyed apart from `II CSK 1/99`. The rest keeps the reader's
 * case, since a common court's registers are title case (`XXIII Gz`).
 */
const formatPolishDocket = (folded: string): string =>
  folded.replace(POL_CHAMBER_NUMERAL_RE, (chamber) => chamber.toUpperCase());

/** A case number as the Court of Justice prints it: no lead word, capitals. */
const formatEuDocket = (folded: string): string =>
  folded.replace(EU_DOCKET_LEAD_RE, "").toUpperCase();

/**
 * An Austrian docket spaced as RIS prints it (`1 Ob 1/26a`, `Ra
 * 2019/01/0001`, `W 998/2099`): one space wherever letters and digits meet
 * before the first slash, so a compact `5Ob200/20x` keys as the stored row.
 * The year's letter after the slash stays glued.
 */
const formatAustrianDocket = (folded: string): string => {
  const slash = folded.indexOf("/");
  return `${folded
    .slice(0, slash)
    .replace(
      /(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})/gu,
      " ",
    )}${folded.slice(slash)}`;
};

/**
 * A Constitutional Court docket in the court's spelling (`II. ÚS 55/98`) and
 * its stored `citation_key` (`iiús55/98`, `plús3/2019`): senate, `ús`, number
 * and year run together in lower case, the accent kept, as the ingestion
 * dedup key writes it. The identity lookup keys the formatted string the way
 * ingestion keys a case number, so every spelling a reader types has to leave
 * the grammar as the court's one.
 */
const slovakConstitutionalDocketOf = (
  folded: string,
): { formatted: string; canonical: string } | null => {
  const groups = SVK_CONSTITUTIONAL_DOCKET_RE.exec(folded)?.groups;
  const senate = groups?.["senate"];
  const ordinal = groups?.["ordinal"];
  const year = groups?.["year"];
  if (senate === undefined || ordinal === undefined || year === undefined) {
    return null;
  }
  return {
    formatted: `${senate.toUpperCase()}. ÚS ${ordinal}/${year}`,
    canonical: `${senate.toLowerCase()}ús${ordinal}/${year}`,
  };
};

const slovakDocketGrammar: DecisionDocketGrammarFor<"SVK"> = {
  jurisdiction: "SVK",
  parse: (raw) => {
    const folded = foldDecisionIdentifierInput(raw).replace(
      DECISION_SHEET_SUFFIX_RE,
      "",
    );
    const constitutional = slovakConstitutionalDocketOf(folded);
    if (constitutional !== null) {
      return { jurisdiction: "SVK", ...constitutional };
    }
    if (!SVK_DOCKET_RE.test(folded)) {
      return null;
    }
    return {
      jurisdiction: "SVK",
      // Glued, as the courts write it (`5Obo/998/2099`): a stored docket with
      // a part after it keys by its spelling, so a spaced family would miss it.
      formatted: folded.replace(
        SVK_DOCKET_RE,
        "$<senate>$<registry>/$<ordinal>/$<year>",
      ),
      canonical: canonicalSlovakDocketKey(folded),
    };
  },
};

/**
 * The docket numbers the Supreme Court of the United States assigns, each with
 * the key its form compares under.
 *
 * - `21-123`: the term year, then the case's number in that term's docket.
 * - `20A87`: an application, numbered per term.
 * - `22O141`: an original-jurisdiction case, in the electronic form.
 * - `No. 141, Orig.`: the same case, as the Court prints it. Original numbers
 *   run on across terms, so both forms key by the number alone.
 * - `No. 1`: a number with no term, as older dockets were written. The `No.`
 *   is required here, because a bare number is not a docket.
 *
 * A leading `No.` is optional on the other forms and never part of the key;
 * the formatted docket always carries it, as the Court prints it.
 * Every digit is: `21-123` and `21-456` are two cases, so the sheet-number
 * strip the other grammars apply to a trailing `-digits` never runs here.
 */
type UnitedStatesDocketParts = {
  /** The two-digit term year, or empty for a form that carries none. */
  readonly term: string;
  readonly number: string;
};

const originalDocketKey = (number: string): string =>
  `${Number.parseInt(number, 10)} orig`;

const USA_DOCKET_FORMS = [
  {
    pattern: /^(?:no\.? ?)?(?<term>\d{2})-(?<number>\d{1,5})$/iu,
    key: ({ number, term }: UnitedStatesDocketParts) => `${term}-${number}`,
    format: ({ number, term }: UnitedStatesDocketParts) =>
      `No. ${term}-${number}`,
  },
  {
    pattern: /^(?:no\.? ?)?(?<term>\d{2})a(?<number>\d{1,5})$/iu,
    key: ({ number, term }: UnitedStatesDocketParts) => `${term}a${number}`,
    format: ({ number, term }: UnitedStatesDocketParts) =>
      `No. ${term}A${number}`,
  },
  {
    pattern: /^(?:no\.? ?)?(?<term>\d{2})o(?<number>\d{1,4})$/iu,
    key: ({ number }: UnitedStatesDocketParts) => originalDocketKey(number),
    // Printed, as every original case is: an electronic family would key
    // apart from a printed member with a part after it.
    format: ({ number }: UnitedStatesDocketParts) =>
      `No. ${String(Number.parseInt(number, 10))}, Orig.`,
  },
  {
    pattern: /^(?:no\.? ?)?(?<number>\d{1,4}),? orig(?:inal|\.)?$/iu,
    key: ({ number }: UnitedStatesDocketParts) => originalDocketKey(number),
    format: ({ number }: UnitedStatesDocketParts) => `No. ${number}, Orig.`,
  },
  {
    pattern: /^no\.? ?(?<number>\d{1,5})$/iu,
    key: ({ number }: UnitedStatesDocketParts) => number,
    format: ({ number }: UnitedStatesDocketParts) => `No. ${number}`,
  },
] as const;

const USA_DOCKET_PATTERNS = USA_DOCKET_FORMS.map(({ pattern }) => pattern);

type UnitedStatesDocketForm = (typeof USA_DOCKET_FORMS)[number];

/** The declared form an accepted docket matches, and its parts. */
const unitedStatesDocketFormOf = (
  folded: string,
): { form: UnitedStatesDocketForm; parts: UnitedStatesDocketParts } => {
  for (const form of USA_DOCKET_FORMS) {
    const groups = form.pattern.exec(folded)?.groups;
    const number = groups?.["number"];
    if (number !== undefined) {
      return { form, parts: { number, term: groups?.["term"] ?? "" } };
    }
  }
  return panic("Accepted United States docket matches no declared form");
};

const canonicalUnitedStatesDocketKey = (folded: string): string => {
  const { form, parts } = unitedStatesDocketFormOf(folded);
  return form.key(parts).toLowerCase();
};

/**
 * A docket as the Court prints it, behind its `No.` (`No. 21-123`, `No.
 * 141, Orig.`), which is the spelling the stored docket carries.
 */
const formatUnitedStatesDocket = (folded: string): string => {
  const { form, parts } = unitedStatesDocketFormOf(folded);
  return form.format(parts);
};

const canonicalSlovakDocketKey = (formatted: string): string => {
  const groups = SVK_DOCKET_RE.exec(formatted)?.groups;
  const senate = groups?.["senate"];
  const registry = groups?.["registry"];
  const ordinal = groups?.["ordinal"];
  const year = groups?.["year"];
  if (
    senate === undefined ||
    registry === undefined ||
    ordinal === undefined ||
    year === undefined
  ) {
    return panic("Accepted Slovak docket is missing a canonical component");
  }
  return canonicalDocketKey(`${senate}${registry}/${ordinal}/${year}`);
};

const canonicalHungarianDocketKey = (formatted: string): string => {
  const groups = HUN_DOCKET_RE.exec(formatted)?.groups;
  const registry = groups?.["registry"];
  const register = groups?.["register"];
  const year = groups?.["year"];
  if (registry === undefined || register === undefined || year === undefined) {
    return panic("Accepted Hungarian docket is missing a canonical component");
  }
  const document = groups?.["document"];
  const sheet = document === undefined ? "" : `/${document}`;
  const panel = groups?.["panel"];
  const numeral = groups?.["numeral"];
  // Every component keeps the dot the court writes after it, including when
  // the next one is absent. Concatenated instead, a registry mark followed by
  // a panel numeral and a registry mark ending in those same letters produce
  // one key: `Xy.I.1/2020` and `Xyi.1/2020` are different dockets.
  const lead = panel === undefined ? "" : `${panel}.`;
  const chamber = numeral === undefined ? "" : `${numeral}.`;
  const digits = register.replace(".", "");
  return canonicalDocketKey(
    `${lead}${registry}.${chamber}${digits}/${year}${sheet}`,
  );
};

/**
 * One key for every accepted Polish form: division, register and seat run
 * together, so "III A/Ua 1/20" and "iii a ua 1/20" share one, "IISA/WR 12/01"
 * keys as "II SA/Wr 12/01" does, "KIO/UZP 1/08" as "KIO UZP 1/08", and
 * "U. 4/86" as "U 4/86". Only a Tribunal prefix's dot goes; an authority
 * file number keeps the dots that separate its groups ("DKN.5131.6.2024" is
 * not "DKN.513.16.2024").
 */
const canonicalPolishDocketKey = (formatted: string): string =>
  // A tax signature is compared whole: its trailing numbers name the
  // document, not a sheet of it, so the generic key's sheet strip does not
  // apply.
  POL_TAX_SIGNATURE_PATTERNS.some((pattern) => pattern.test(formatted))
    ? formatted.toLocaleLowerCase("und").replace(/\s+/gu, "")
    : canonicalDocketKey(formatted)
        .replace(/\/(?=\p{L})/gu, "")
        .replace(/^(\p{L}{1,3})\.(?=\d{1,4}\/)/u, "$1");

export const DECISION_DOCKET_GRAMMARS = {
  AUT: createDecisionDocketGrammar({
    canonicalize: canonicalDocketKey,
    format: formatAustrianDocket,
    jurisdiction: "AUT",
    patterns: AUT_DOCKET_PATTERNS,
  }),
  CZE: createDecisionDocketGrammar({
    canonicalize: (folded) => canonicalDocketKey(folded.replaceAll(".", "")),
    format: formatCzechDocket,
    jurisdiction: "CZE",
    patterns: CZE_DOCKET_PATTERNS,
  }),
  EU: createDecisionDocketGrammar({
    canonicalize: (folded) =>
      canonicalDocketKey(folded.replace(EU_DOCKET_LEAD_RE, "")),
    format: formatEuDocket,
    jurisdiction: "EU",
    patterns: EU_DOCKET_PATTERNS,
  }),
  HUN: createDecisionDocketGrammar({
    canonicalize: canonicalHungarianDocketKey,
    format: asWritten,
    jurisdiction: "HUN",
    patterns: HUN_DOCKET_PATTERNS,
  }),
  POL: createDecisionDocketGrammar({
    canonicalize: canonicalPolishDocketKey,
    format: formatPolishDocket,
    jurisdiction: "POL",
    patterns: POL_DOCKET_PATTERNS,
  }),
  SVK: slovakDocketGrammar,
  USA: createDecisionDocketGrammar({
    canonicalize: canonicalUnitedStatesDocketKey,
    format: formatUnitedStatesDocket,
    jurisdiction: "USA",
    patterns: USA_DOCKET_PATTERNS,
  }),
} as const satisfies {
  readonly [
    TJurisdiction in CaseLawJurisdiction
  ]: DecisionDocketGrammarFor<TJurisdiction>;
};

export type DecisionDocketJurisdiction = keyof typeof DECISION_DOCKET_GRAMMARS;
export type DecisionDocketGrammar =
  (typeof DECISION_DOCKET_GRAMMARS)[DecisionDocketJurisdiction];

const DECISION_DOCKET_GRAMMAR_LIST: readonly DecisionDocketGrammar[] =
  Object.values(DECISION_DOCKET_GRAMMARS);

/**
 * Jurisdictions whose grammar is read only under their own scope. Their forms
 * are short digit runs (`10-12`, `No. 5`) that also occur in text that is not
 * a docket, so an entry is read as one only where the scope says which
 * jurisdiction it comes from; an unscoped entry never reaches them.
 */
const SCOPED_ONLY_DOCKET_JURISDICTIONS: ReadonlySet<DecisionDocketJurisdiction> =
  new Set<DecisionDocketJurisdiction>(["USA"]);

const UNSCOPED_DECISION_DOCKET_GRAMMARS: readonly DecisionDocketGrammar[] =
  DECISION_DOCKET_GRAMMAR_LIST.filter(
    (grammar) => !SCOPED_ONLY_DOCKET_JURISDICTIONS.has(grammar.jurisdiction),
  );

/** Resolve a declared grammar without treating an unknown scope as unscoped. */
export const decisionDocketGrammarForJurisdiction = (
  jurisdiction: string,
): DecisionDocketGrammar | null => {
  const normalized = jurisdiction.toUpperCase();
  return (
    DECISION_DOCKET_GRAMMAR_LIST.find(
      (grammar) => grammar.jurisdiction === normalized,
    ) ?? null
  );
};

type ParseDecisionDocketOptions = {
  readonly grammar?: DecisionDocketGrammar | null | undefined;
};

/**
 * Parse against one jurisdiction, or, when unscoped, every declared grammar
 * that is not read only under its own scope.
 */
export const parseDecisionDocket = (
  raw: string,
  { grammar }: ParseDecisionDocketOptions = {},
): ParsedDecisionDocket<DecisionDocketJurisdiction> | null => {
  if (grammar === null) {
    return null;
  }
  if (grammar !== undefined) {
    return grammar.parse(raw);
  }
  for (const candidate of UNSCOPED_DECISION_DOCKET_GRAMMARS) {
    const docket = candidate.parse(raw);
    if (docket !== null) {
      return docket;
    }
  }
  return null;
};

/** Stable normalized display form produced by the accepting grammar. */
export const formatDecisionDocket = (docket: ParsedDecisionDocket): string =>
  docket.formatted;

/** Stable comparison form shared by all declared docket grammars. */
export const canonicalDecisionDocket = (docket: ParsedDecisionDocket): string =>
  docket.canonical;

/**
 * A Roman numeral from one to thirty-nine, the range publishers number a
 * ruling's parts or a docket's sibling documents in. Spelled out rather than
 * `[ivxl]+`, which would read a word made of those letters as a numeral.
 */
const ROMAN_PART_NUMERAL_SOURCE = String.raw`(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})`;

/**
 * What a publisher can leave glued to the end of a docket without changing
 * which case it names: punctuation, dashes, symbols and whitespace, with at
 * most standalone Roman part numerals between them (`- II.`, `.`, ` -`).
 * It opens on a separator, so a cut never lands inside a token, and it
 * carries no digit and no other letter, so a sheet number (`-33`) or a word
 * is never stripped.
 */
const DOCKET_JUNK_TAIL_RE = new RegExp(
  String.raw`^[\s\p{P}\p{S}](?:[\s\p{P}\p{S}]|(?<![\p{L}\p{N}])${ROMAN_PART_NUMERAL_SOURCE}(?![\p{L}\p{N}]))*$`,
  "iu",
);

/** How a stored docket reads under its jurisdiction's grammar. */
export type StoredDecisionDocket =
  /** The docket parses as written. */
  | { readonly type: "canonical"; readonly caseNumber: string }
  /**
   * The docket parses once a tail the grammar has no place for is removed.
   * `caseNumber` is the docket without it; `removed` is what was cut.
   */
  | {
      readonly type: "trimmed";
      readonly caseNumber: string;
      readonly removed: string;
    }
  /** Neither the docket nor any docket inside it parses. */
  | { readonly type: "unparsed" }
  /** The jurisdiction declares no docket grammar to read it by. */
  | { readonly type: "ungoverned" };

/**
 * Read a stored docket against its jurisdiction's grammar, cutting a trailing
 * tail the grammar has no place for when that is what keeps it from parsing.
 *
 * A docket that parses as written is returned unchanged, so a grammar that
 * accepts a trailing mark (a Hungarian docket's closing dot) keeps it. The
 * cut is the shortest one that leaves a docket the grammar accepts, and only
 * a tail of separators and Roman part numerals is ever cut
 * (`DOCKET_JUNK_TAIL_RE`). Language-blind: nothing here reads a word.
 */
export const storedDecisionDocketOf = (
  raw: string,
  jurisdiction: string,
): StoredDecisionDocket => {
  const grammar = decisionDocketGrammarForJurisdiction(jurisdiction);
  if (grammar === null) {
    return { type: "ungoverned" };
  }
  if (grammar.parse(raw) !== null) {
    return { type: "canonical", caseNumber: raw };
  }
  const folded = foldDecisionIdentifierInput(raw);
  for (let cut = folded.length - 1; cut > 0; cut -= 1) {
    const tail = folded.slice(cut);
    if (!DOCKET_JUNK_TAIL_RE.test(tail)) {
      continue;
    }
    const caseNumber = folded.slice(0, cut).trim();
    if (caseNumber.length > 0 && grammar.parse(caseNumber) !== null) {
      return {
        type: "trimmed",
        caseNumber,
        removed: folded.slice(caseNumber.length),
      };
    }
  }
  return { type: "unparsed" };
};
