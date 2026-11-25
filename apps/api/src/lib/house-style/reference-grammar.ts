// The words Czech, English and German contracts cite provisions with, and the
// words that say whose provision it is. Patterns only: the reader that walks
// a chain of them lives in `reference-detector.ts`.

/** What a head word names. `section` is the section sign, which heads a
 *  statute's provisions in Czech and English texts and a contract's own in
 *  German ones. */
export type HeadLevel =
  "section" | "article" | "clause" | "letter" | "point" | "annex" | "recital";

const BLANK = String.raw`[ \u00A0\u202F]`;
const NOT_WORD = String.raw`(?![\p{L}\p{N}])`;
/** A head ends at its own period (`čl.5`) or at a word boundary. */
const HEAD_END = String.raw`(?:(?<=\.)|${NOT_WORD})`;

// Order matters where one head contains another: `sub-clause` is read before
// `clause`, so the clause group comes first.
const HEAD_SOURCES = [
  ["section", String.raw`§{1,2}`],
  [
    "clause",
    String.raw`(?:odst\.|odstav(?:cích|cům|cem|ců|ec|ce|ci)|sub-?(?:clauses?|sections?|paragraphs?)|paragraphs?|paras?\.?|abs\.|absatz(?:es)?|absätzen?)${HEAD_END}`,
  ],
  [
    "article",
    String.raw`(?:čl\.|člán(?:cích|kům|kem|ek|ku|ky|ků)|articles?|artikel[ns]?|artt?\.|sections?|sec\.|clauses?|ziff\.|ziffern?|klauseln?|abschnitt(?:e[ns]?|s)?)${HEAD_END}`,
  ],
  [
    "letter",
    String.raw`(?:písm\.|písmen(?:ech|em|e|o|a|u|y)?|lit\.|buchst\.|buchstaben?)${HEAD_END}`,
  ],
  [
    "point",
    String.raw`(?:bod(?:ech|em|ům|u|ě|y|ů)?|points?|items?|punkt(?:e[ns]?|s)?)${HEAD_END}`,
  ],
  [
    "annex",
    String.raw`(?:přílo(?:hami|hách|hám|hou|ha|hy|hu|ze|h)|annex(?:ure|es)?|schedules?|appendi(?:ces|x)|exhibits?|anlagen?|anhang(?:es|s)?|anhängen?)${HEAD_END}`,
  ],
  ["recital", String.raw`recitals?${HEAD_END}`],
] as const satisfies readonly (readonly [HeadLevel, string])[];

const HEAD_SOURCE = String.raw`(?<![\p{L}\p{N}])(?:${HEAD_SOURCES.map(([, source]) => `(${source})`).join("|")})`;

export const HEAD_LEVELS = HEAD_SOURCES.map(([level]) => level);

/** `č.` where `čl.` was meant (`dle č. IX této smlouvy`). Read only as the
 *  opening of a chain, and only as a question for the model. */
const LOOSE_ARTICLE_SOURCE = String.raw`(?<![\p{L}\p{N}])(č\.)`;

/** Finds the next head anywhere after `lastIndex`. The group after the
 *  levels' own is the loose article head. */
export const createHeadScanner = (): RegExp =>
  new RegExp(`${HEAD_SOURCE}|${LOOSE_ARTICLE_SOURCE}`, "giu");

/** Matches a head exactly at `lastIndex`. */
export const HEAD_AT = new RegExp(HEAD_SOURCE, "iuy");

/** Between a head and its designator: `Příloha č. 1`, `Annex No. 2`. */
export const BEFORE_DESIGNATOR = new RegExp(
  String.raw`${BLANK}{0,3}(?:(?:č\.|no\.|nr\.)${BLANK}{0,2})?`,
  "iuy",
);

/**
 * One designator. Groups: 1 decimal (`5`, `5.1.2`, `106a`), 2 upper roman,
 * 3 and 4 a bracketed letter or lower-case numeral (`a)`, `(ii)`, `(B)`), 5 a bracketed
 * number (`(2)`), 6 a bare letter.
 */
export const DESIGNATOR_AT = new RegExp(
  String.raw`(\d{1,4}[a-z]?(?:\.\d{1,3}[a-z]?){0,4})(?![\p{L}\p{N}]|/\d)|([IVXLCDM]{1,7})${NOT_WORD}|(\(?)([a-z]{1,5}|[A-Z])\)|\((\d{1,3})\)|([A-Za-z])${NOT_WORD}`,
  "uy",
);

/** A bracketed designator set directly against a number: the `(b)` of
 *  `2.3(b)`. Groups: 1 a number, 2 letters. */
export const ATTACHED_AT = /\((?:(\d{1,3})|([a-z]{1,5}|[A-Z]))\)/uy;

const LIST_WORD = String.raw`(?:a|i|nebo|anebo|či|and|or|und|oder|sowie|&)`;
const RANGE_WORD = String.raw`(?:až|to|through|bis)`;

/** Between two designators or two segments. Group 1 is a list connector,
 *  group 2 a range connector. A designator's own period may come first. */
export const CONNECTOR_AT = new RegExp(
  String.raw`\.?(?:(${BLANK}*,${BLANK}*(?:${LIST_WORD}${BLANK}+)?|${BLANK}+${LIST_WORD}${BLANK}+)|(${BLANK}*[–—-]${BLANK}*|${BLANK}+${RANGE_WORD}${BLANK}+))`,
  "iuy",
);

/** Between two segments that follow each other without a connector. */
export const ADJACENT_AT = new RegExp(
  String.raw`\.?${BLANK}*(?:,${BLANK}*)?`,
  "uy",
);

/** `paragraph (b) of Clause 5.1`, `Abs. 2 des § 5`: the wider provision
 *  follows the narrower one. */
export const OF_AT = new RegExp(
  String.raw`${BLANK}+(?:of|des|der|von)${BLANK}+(?:(?:the|this|dem)${BLANK}+)?`,
  "iuy",
);

/** Parts of a citation that name no linkable provision: a sentence, a
 *  half-sentence, an alternative, "and following". */
export const FILLER_AT = new RegExp(
  String.raw`\.?${BLANK}*,?${BLANK}*(?:(?:věta|věty|větě)${BLANK}+\p{L}+|a${BLANK}+násl\.?|et${BLANK}+seq\.?|ff?\.|(?:satz|s\.|hs\.|halbsatz|alt\.|var\.|nr\.|sentence)${BLANK}*\d+|in${BLANK}+fine)`,
  "iuy",
);

/** A number that counts something else: `čl. 5 a 10 dnů`, `odst. 2 a 3 %`,
 *  `odst. 1 a 2 000 Kč`. */
export const QUANTITY_AT = new RegExp(
  String.raw`(?:${BLANK}\d|${BLANK}*(?:[%‰€$]|,-|(?:kč|czk|eur|usd|gbp|dn(?:ech|em|í|ů|y)|měsíc\p{L}*|let|rok\p{L}*|hodin\p{L}*|kalendářní\p{L}*|pracovní\p{L}*|days?|months?|years?|hours?|business|working|calendar|tag(?:en|e)?|werktag\p{L}*|monat\p{L}*|jahr\p{L}*|stunden?)${NOT_WORD}))`,
  "iuy",
);

/** The blanks before whatever follows a chain; a designator's own period
 *  and a line break may come first. */
export const TAIL_START_AT = /\.?[ \u00A0\u202F\n]*/uy;

/** `tohoto článku`, `of this Clause`, `dieses Absatzes`: the chain is read
 *  from where it stands. Group 1 names an article-level unit, group 2 a
 *  clause-level one. */
export const RELATIVE_DEICTIC_AT = new RegExp(
  String.raw`(?:(?:tohoto|téhož)${BLANK}+(?:(článku|paragrafu)|(odstavce|bodu))|of${BLANK}+this${BLANK}+(?:(article|section|clause)|(paragraph|sub-?clause|sub-?section))|(?:dieses|dieser)${BLANK}+(?:(artikels|paragraphen|abschnitts|ziffer|klausel)|(absatzes)))${NOT_WORD}`,
  "iuy",
);

/** A demonstrative and the noun it points at: `této smlouvy`, `of this
 *  Agreement`, `dieses Vertrages`. Group 1, 2 or 3 is the noun. */
export const DEMONSTRATIVE_AT = new RegExp(
  String.raw`(?:(?:této|tohoto|těchto|tato|tento|tyto)${BLANK}+(\p{L}+)|(?:of|to|in|under)${BLANK}+this${BLANK}+(\p{L}+)|(?:dieses|dieser|diesem)${BLANK}+(\p{L}+))`,
  "iuy",
);

/** `hereof`, `výše`, `oben`: the document points at itself. */
export const SELF_ADVERB_AT = new RegExp(
  String.raw`(?:hereof|herein|hereto|hereunder|above|below|výše|níže|shora|oben|unten)${NOT_WORD}`,
  "iuy",
);

/** A noun a demonstrative can point at that is legislation, not a contract:
 *  `tohoto zákona`, `of this Act`, `dieses Gesetzes`. */
export const LEGISLATION_NOUN =
  /^(?:zákon\p{L}*|nařízení|vyhlášk\p{L}*|směrnic\p{L}*|act|regulations?|directive|code|law|\p{L}*gesetz(?:es|buch(?:e?s)?)?|\p{L}*verordnung|\p{L}*richtlinie)$/iu;

const CZECH_ADJECTIVE = String.raw`\p{Ll}+(?:ého|ího|ové|ých)`;

/** Czech legislation named after the chain: `občanského zákoníku`, `zákona
 *  č. 89/2012 Sb.`, `obecného nařízení`. */
export const CZECH_STATUTE_AT = new RegExp(
  [
    String.raw`(?:${CZECH_ADJECTIVE}${BLANK}+){0,2}(?:zákon\p{L}*|zák\.|vyhlášk\p{L}*|nařízení|směrnic\p{L}*|ústav(?:y|ního)|listiny|úmluv\p{L}*|řádu|sb\.)${NOT_WORD}`,
    String.raw`smlouvy${BLANK}+o${BLANK}+(?:fungování|evropské)${NOT_WORD}`,
  ].join("|"),
  "iuy",
);

/** English and German legislation is recognised by its capitalised name
 *  (`of the Companies Act 2006`, `des Bürgerlichen Gesetzbuchs`). Case
 *  decides, so this pattern is case-sensitive. */
export const NAMED_STATUTE_AT = new RegExp(
  [
    String.raw`(?:of${BLANK}+)?(?:the${BLANK}+)?(?:(?:\p{Lu}[\p{L}()]*|of|and|on|for)${BLANK}+){0,6}(?:Act|Code|Regulations?|Directive|Rules|Ordinance|Treaty|Convention|Constitution|Statute)${NOT_WORD}`,
    String.raw`(?:(?:des|der)${BLANK}+)?(?:\p{Lu}\p{L}*${BLANK}+){0,2}\p{L}*(?:[Gg]esetz(?:es)?|[Gg]esetzbuch(?:e?s)?|[Vv]erordnung|[Oo]rdnung|[Rr]ichtlinie)${NOT_WORD}`,
  ].join("|"),
  "uy",
);

/** An abbreviation after the chain: `ZDPH`, `BGB`, `GmbHG`, `GDPR`, and
 *  another document's short name (`VOP`, `SHA`). Group 1 is the token. */
export const ABBREVIATION_AT = new RegExp(
  String.raw`(?:(?:des|der|of${BLANK}+the|the)${BLANK}+)?(\p{Lu}[\p{L}-]{1,8})${NOT_WORD}`,
  "uy",
);

/** A named document after the chain. Group 1: an English `of the Lease
 *  Agreement`; group 2: a German `des Gesellschaftsvertrages`. A Czech
 *  qualified noun (`Rámcové smlouvy`, `kupní smlouvy`) has no group. */
export const NAMED_DOCUMENT_AT = new RegExp(
  [
    String.raw`of${BLANK}+the${BLANK}+(\p{Lu}\p{L}*(?:${BLANK}+\p{Lu}\p{L}*)*)`,
    String.raw`(?:des|der)${BLANK}+(\p{Lu}\p{L}*(?:${BLANK}+\p{Lu}\p{L}*)?)`,
    String.raw`(?:[Ss]tanov|(?:\p{Lu}\p{Ll}+|\p{Ll}+(?:ní|né|ové|cí|ské|ních|ných))${BLANK}+(?:smlouvy|dohody|dokumentace|podmínek))${NOT_WORD}`,
  ].join("|"),
  "uy",
);

/** The nouns a contract calls itself by, so `of the Agreement` and `des
 *  Vertrages` point home. */
export const OWN_DOCUMENT_NOUN =
  /^(?:agreement|contract|deed|lease|vertrag(?:e?s)?|vereinbarung)$/iu;

/** `čl. 5 Smlouvy`: the bare genitive Czech contracts cite themselves by. */
export const OWN_NOUN_AT = new RegExp(
  String.raw`(?:smlouvy|dohody)${NOT_WORD}`,
  "iuy",
);
