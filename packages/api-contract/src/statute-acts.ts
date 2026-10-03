/**
 * Acts known by a short name, stated once for every reader that names them:
 * the statute box (`statute-aliases`) and the court-citation readers
 * (`@stll/legal-atlas` jurisdiction profiles). Each act carries its identity
 * in the collection that published it and the name a reader recognises.
 */

/**
 * A collection's canonical citation spelling. `Zb.` is the Czechoslovak
 * collection a Slovak act of the federal era keeps forever; `Z. z.` is the
 * Slovak one from 1993. The spelling is part of the identity.
 */
type StatuteActCollection = "Sb." | "Zb." | "Z. z.";

/**
 * The collection segment of the publisher's ELI. Slov-Lex files both Slovak
 * collections under `zz`.
 */
export const ELI_COLLECTION_BY_STATUTE_ACT_COLLECTION = {
  "Sb.": "sb",
  "Zb.": "zz",
  "Z. z.": "zz",
} as const satisfies Record<StatuteActCollection, string>;

/** An act's identity in a national collection. */
type StatuteActWork = {
  number: number;
  year: number;
  collection: StatuteActCollection;
};

export type StatuteAct = {
  work: StatuteActWork;
  label: string;
};

const act = (
  number: number,
  year: number,
  collection: StatuteActCollection,
  label: string,
): StatuteAct => ({ work: { number, year, collection }, label });

/**
 * Keyed by the statute box's country code. Every entry was checked against
 * the corpus: the number opens the act the label names.
 */
export const STATUTE_ACTS = {
  cze: {
    civilCode: act(89, 2012, "Sb.", "Občanský zákoník"),
    corporations: act(90, 2012, "Sb.", "Zákon o obchodních korporacích"),
    labourCode: act(262, 2006, "Sb.", "Zákoník práce"),
    criminalCode: act(40, 2009, "Sb.", "Trestní zákoník"),
    criminalProcedure: act(141, 1961, "Sb.", "Trestní řád"),
    civilProcedure: act(99, 1963, "Sb.", "Občanský soudní řád"),
    administrativeJustice: act(150, 2002, "Sb.", "Soudní řád správní"),
    administrativeProcedure: act(500, 2004, "Sb.", "Správní řád"),
    insolvency: act(182, 2006, "Sb.", "Insolvenční zákon"),
    incomeTax: act(586, 1992, "Sb.", "Zákon o daních z příjmů"),
    vat: act(235, 2004, "Sb.", "Zákon o dani z přidané hodnoty"),
    constitution: act(1, 1993, "Sb.", "Ústava České republiky"),
    charter: act(2, 1993, "Sb.", "Listina základních práv a svobod"),
    trades: act(455, 1991, "Sb.", "Živnostenský zákon"),
    specialProceedings: act(
      292,
      2013,
      "Sb.",
      "Zákon o zvláštních řízeních soudních",
    ),
    building: act(283, 2021, "Sb.", "Stavební zákon"),
  },
  svk: {
    civilCode: act(40, 1964, "Zb.", "Občiansky zákonník"),
    commercialCode: act(513, 1991, "Zb.", "Obchodný zákonník"),
    labourCode: act(311, 2001, "Z. z.", "Zákonník práce"),
    criminalCode: act(300, 2005, "Z. z.", "Trestný zákon"),
    civilDisputes: act(160, 2015, "Z. z.", "Civilný sporový poriadok"),
    administrativeProcedure: act(71, 1967, "Zb.", "Správny poriadok"),
  },
} as const satisfies Record<string, Record<string, StatuteAct>>;
