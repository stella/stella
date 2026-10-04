import {
  STATUTE_ACTS,
  statuteActEliCollection,
  type StatuteAct,
} from "./statute-acts";
import type { StatuteQueryCountry } from "./statute-query-capability";

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

const target = ({
  work: { collection, number, year },
  label,
}: StatuteAct): StatuteAliasTarget => ({
  collection: statuteActEliCollection(collection),
  label,
  number: String(number),
  year: String(year),
});

const CZE = STATUTE_ACTS.cze;
const SVK = STATUTE_ACTS.svk;

/**
 * What lawyers type instead of a number, per jurisdiction. Targets come from
 * `STATUTE_ACTS`, which the court-citation readers share.
 * `oz` is the civil code in both jurisdictions and a different act in each;
 * the jurisdiction the reader is in decides.
 *
 * Keys are already folded (lower-case, diacritics removed); the matcher folds
 * the input the same way, so `OSŘ`, `osř` and `osr` are one key.
 */
export const STATUTE_ALIASES = {
  cze: {
    oz: target(CZE.civilCode),
    noz: target(CZE.civilCode),
    obcz: target(CZE.civilCode),
    "obc. zak.": target(CZE.civilCode),
    "obc zak": target(CZE.civilCode),
    "obcansky zakonik": target(CZE.civilCode),
    obcansky: target(CZE.civilCode),
    obcan: target(CZE.civilCode),
    zok: target(CZE.corporations),
    "zakon o obchodnich korporacich": target(CZE.corporations),
    zp: target(CZE.labourCode),
    "zakonik prace": target(CZE.labourCode),
    tz: target(CZE.criminalCode),
    trz: target(CZE.criminalCode),
    "trestni zakonik": target(CZE.criminalCode),
    tr: target(CZE.criminalProcedure),
    "trestni rad": target(CZE.criminalProcedure),
    osr: target(CZE.civilProcedure),
    "obcansky soudni rad": target(CZE.civilProcedure),
    srs: target(CZE.administrativeJustice),
    "soudni rad spravni": target(CZE.administrativeJustice),
    sr: target(CZE.administrativeProcedure),
    "spravni rad": target(CZE.administrativeProcedure),
    insz: target(CZE.insolvency),
    iz: target(CZE.insolvency),
    "insolvencni zakon": target(CZE.insolvency),
    zdp: target(CZE.incomeTax),
    dph: target(CZE.vat),
    ustava: target(CZE.constitution),
    lzps: target(CZE.charter),
    listina: target(CZE.charter),
    "zivnostensky zakon": target(CZE.trades),
    zrs: target(CZE.specialProceedings),
    "stavebni zakon": target(CZE.building),
  },
  svk: {
    oz: target(SVK.civilCode),
    "obciansky zakonnik": target(SVK.civilCode),
    obchz: target(SVK.commercialCode),
    obz: target(SVK.commercialCode),
    "obchodny zakonnik": target(SVK.commercialCode),
    zp: target(SVK.labourCode),
    "zakonnik prace": target(SVK.labourCode),
    tz: target(SVK.criminalCode),
    "trestny zakon": target(SVK.criminalCode),
    csp: target(SVK.civilDisputes),
    "civilny sporovy poriadok": target(SVK.civilDisputes),
    "spravny poriadok": target(SVK.administrativeProcedure),
  },
} as const satisfies Record<
  StatuteQueryCountry,
  Record<string, StatuteAliasTarget>
>;

export const resolveStatuteAlias = (
  country: StatuteQueryCountry,
  foldedText: string,
): StatuteAliasTarget | null => {
  const aliases: Record<string, StatuteAliasTarget> = STATUTE_ALIASES[country];
  return aliases[foldedText] ?? null;
};
