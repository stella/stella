import type { StatuteCountry } from "@/lib/statute-route";

/**
 * An act an alias names: its number in the collection that published it,
 * and the short name a reader recognises it by.
 */
export type StatuteAliasTarget = {
  collection: string;
  label: string;
  number: string;
  year: string;
};

const act = (
  number: string,
  year: string,
  collection: string,
  label: string,
): StatuteAliasTarget => ({ collection, label, number, year });

// Keys are already folded (lower-case, diacritics removed); the matcher folds
// the input the same way, so `OSŘ`, `osř` and `osr` are one key.
const CZE_ACTS = {
  civilCode: act("89", "2012", "sb", "Občanský zákoník"),
  corporations: act("90", "2012", "sb", "Zákon o obchodních korporacích"),
  labourCode: act("262", "2006", "sb", "Zákoník práce"),
  criminalCode: act("40", "2009", "sb", "Trestní zákoník"),
  criminalProcedure: act("141", "1961", "sb", "Trestní řád"),
  civilProcedure: act("99", "1963", "sb", "Občanský soudní řád"),
  administrativeJustice: act("150", "2002", "sb", "Soudní řád správní"),
  administrativeProcedure: act("500", "2004", "sb", "Správní řád"),
  insolvency: act("182", "2006", "sb", "Insolvenční zákon"),
  incomeTax: act("586", "1992", "sb", "Zákon o daních z příjmů"),
  vat: act("235", "2004", "sb", "Zákon o dani z přidané hodnoty"),
  constitution: act("1", "1993", "sb", "Ústava České republiky"),
  charter: act("2", "1993", "sb", "Listina základních práv a svobod"),
  trades: act("455", "1991", "sb", "Živnostenský zákon"),
  specialProceedings: act(
    "292",
    "2013",
    "sb",
    "Zákon o zvláštních řízeních soudních",
  ),
  building: act("283", "2021", "sb", "Stavební zákon"),
} as const;

const SVK_ACTS = {
  civilCode: act("40", "1964", "zz", "Občiansky zákonník"),
  commercialCode: act("513", "1991", "zz", "Obchodný zákonník"),
  labourCode: act("311", "2001", "zz", "Zákonník práce"),
  criminalCode: act("300", "2005", "zz", "Trestný zákon"),
  civilDisputes: act("160", "2015", "zz", "Civilný sporový poriadok"),
  administrativeProcedure: act("71", "1967", "zz", "Správny poriadok"),
} as const;

/**
 * What lawyers type instead of a number, per jurisdiction. Every target was
 * checked against the corpus: the number opens the act the label names.
 * `oz` is the civil code in both jurisdictions and a different act in each;
 * the jurisdiction the reader is in decides.
 */
export const STATUTE_ALIASES = {
  cze: {
    oz: CZE_ACTS.civilCode,
    noz: CZE_ACTS.civilCode,
    obcz: CZE_ACTS.civilCode,
    "obc. zak.": CZE_ACTS.civilCode,
    "obc zak": CZE_ACTS.civilCode,
    "obcansky zakonik": CZE_ACTS.civilCode,
    obcansky: CZE_ACTS.civilCode,
    obcan: CZE_ACTS.civilCode,
    zok: CZE_ACTS.corporations,
    "zakon o obchodnich korporacich": CZE_ACTS.corporations,
    zp: CZE_ACTS.labourCode,
    "zakonik prace": CZE_ACTS.labourCode,
    tz: CZE_ACTS.criminalCode,
    "trestni zakonik": CZE_ACTS.criminalCode,
    tr: CZE_ACTS.criminalProcedure,
    "trestni rad": CZE_ACTS.criminalProcedure,
    osr: CZE_ACTS.civilProcedure,
    "obcansky soudni rad": CZE_ACTS.civilProcedure,
    srs: CZE_ACTS.administrativeJustice,
    "soudni rad spravni": CZE_ACTS.administrativeJustice,
    sr: CZE_ACTS.administrativeProcedure,
    "spravni rad": CZE_ACTS.administrativeProcedure,
    insz: CZE_ACTS.insolvency,
    iz: CZE_ACTS.insolvency,
    "insolvencni zakon": CZE_ACTS.insolvency,
    zdp: CZE_ACTS.incomeTax,
    dph: CZE_ACTS.vat,
    ustava: CZE_ACTS.constitution,
    lzps: CZE_ACTS.charter,
    listina: CZE_ACTS.charter,
    "zivnostensky zakon": CZE_ACTS.trades,
    zrs: CZE_ACTS.specialProceedings,
    "stavebni zakon": CZE_ACTS.building,
  },
  svk: {
    oz: SVK_ACTS.civilCode,
    "obciansky zakonnik": SVK_ACTS.civilCode,
    obchz: SVK_ACTS.commercialCode,
    obz: SVK_ACTS.commercialCode,
    "obchodny zakonnik": SVK_ACTS.commercialCode,
    zp: SVK_ACTS.labourCode,
    "zakonnik prace": SVK_ACTS.labourCode,
    tz: SVK_ACTS.criminalCode,
    "trestny zakon": SVK_ACTS.criminalCode,
    csp: SVK_ACTS.civilDisputes,
    "civilny sporovy poriadok": SVK_ACTS.civilDisputes,
    "spravny poriadok": SVK_ACTS.administrativeProcedure,
  },
} as const satisfies Record<StatuteCountry, Record<string, StatuteAliasTarget>>;

export const resolveStatuteAlias = (
  country: StatuteCountry,
  foldedText: string,
): StatuteAliasTarget | null => {
  const aliases: Record<string, StatuteAliasTarget> = STATUTE_ALIASES[country];
  return aliases[foldedText] ?? null;
};
