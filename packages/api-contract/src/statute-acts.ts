import { panic } from "better-result";

import { statuteGazetteEliCollection } from "./statute-gazette";
import type { StatuteQueryCountry } from "./statute-query-capability";

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

/** The collection segment of the publisher's ELI, read from the gazette table. */
export const statuteActEliCollection = (
  collection: StatuteActCollection,
): string =>
  statuteGazetteEliCollection(collection) ??
  panic(`No ELI collection prints as ${collection}`);

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

type ActOptions = StatuteActWork & { label: string };

const act = ({ number, year, collection, label }: ActOptions): StatuteAct => ({
  work: { number, year, collection },
  label,
});

/**
 * Keyed by the statute box's country code. Every entry was checked against
 * the corpus: the number opens the act the label names.
 */
export const STATUTE_ACTS = {
  cze: {
    civilCode: act({
      number: 89,
      year: 2012,
      collection: "Sb.",
      label: "Občanský zákoník",
    }),
    corporations: act({
      number: 90,
      year: 2012,
      collection: "Sb.",
      label: "Zákon o obchodních korporacích",
    }),
    labourCode: act({
      number: 262,
      year: 2006,
      collection: "Sb.",
      label: "Zákoník práce",
    }),
    criminalCode: act({
      number: 40,
      year: 2009,
      collection: "Sb.",
      label: "Trestní zákoník",
    }),
    criminalProcedure: act({
      number: 141,
      year: 1961,
      collection: "Sb.",
      label: "Trestní řád",
    }),
    civilProcedure: act({
      number: 99,
      year: 1963,
      collection: "Sb.",
      label: "Občanský soudní řád",
    }),
    administrativeJustice: act({
      number: 150,
      year: 2002,
      collection: "Sb.",
      label: "Soudní řád správní",
    }),
    administrativeProcedure: act({
      number: 500,
      year: 2004,
      collection: "Sb.",
      label: "Správní řád",
    }),
    insolvency: act({
      number: 182,
      year: 2006,
      collection: "Sb.",
      label: "Insolvenční zákon",
    }),
    incomeTax: act({
      number: 586,
      year: 1992,
      collection: "Sb.",
      label: "Zákon o daních z příjmů",
    }),
    vat: act({
      number: 235,
      year: 2004,
      collection: "Sb.",
      label: "Zákon o dani z přidané hodnoty",
    }),
    constitution: act({
      number: 1,
      year: 1993,
      collection: "Sb.",
      label: "Ústava České republiky",
    }),
    charter: act({
      number: 2,
      year: 1993,
      collection: "Sb.",
      label: "Listina základních práv a svobod",
    }),
    trades: act({
      number: 455,
      year: 1991,
      collection: "Sb.",
      label: "Živnostenský zákon",
    }),
    specialProceedings: act({
      number: 292,
      year: 2013,
      collection: "Sb.",
      label: "Zákon o zvláštních řízeních soudních",
    }),
    building: act({
      number: 283,
      year: 2021,
      collection: "Sb.",
      label: "Stavební zákon",
    }),
  },
  svk: {
    civilCode: act({
      number: 40,
      year: 1964,
      collection: "Zb.",
      label: "Občiansky zákonník",
    }),
    commercialCode: act({
      number: 513,
      year: 1991,
      collection: "Zb.",
      label: "Obchodný zákonník",
    }),
    labourCode: act({
      number: 311,
      year: 2001,
      collection: "Z. z.",
      label: "Zákonník práce",
    }),
    criminalCode: act({
      number: 300,
      year: 2005,
      collection: "Z. z.",
      label: "Trestný zákon",
    }),
    civilDisputes: act({
      number: 160,
      year: 2015,
      collection: "Z. z.",
      label: "Civilný sporový poriadok",
    }),
    administrativeProcedure: act({
      number: 71,
      year: 1967,
      collection: "Zb.",
      label: "Správny poriadok",
    }),
  },
} as const satisfies Record<StatuteQueryCountry, Record<string, StatuteAct>>;
