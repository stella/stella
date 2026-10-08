import { panic } from "better-result";

import {
  DECISION_TYPE_KIND_OTHER,
  isDecisionTypeKind,
  type DecisionTypeKind,
} from "@stll/api-contract/case-law-decision-types";

import inventory from "@/api/lib/case-law/decision-type-inventory.json" with { type: "json" };
import {
  decisionTypeKey,
  isDocketShapedDecisionType,
} from "@/api/lib/case-law/decision-type-key";

/**
 * Every decision type the corpus stores, by comparison key, and the canonical
 * kind it states. The stored value is never rewritten: this is the one place a
 * stated type is read as a kind, for the type facet, its filter and both
 * search providers. Keys are folded (`decisionTypeKey`), so `Uznesenie` and
 * `uznesenie` are one entry.
 *
 * Total over `decision-type-inventory.json`, the census of what each
 * jurisdiction stores: `decision-type-census.test.ts` fails on a stored type
 * missing here. An entry mapped to `other` is a decision, with its reason.
 */
export const STATED_DECISION_TYPE_KINDS = {
  // Czech. The Nejvyšší soud abbreviates in its type field (`usn.`, `rozs.`,
  // `rozs.část.` for částečný rozsudek, `tr.příkaz`).
  rozsudek: "judgment",
  "rozs.": "judgment",
  "rozs.část.": "judgment",
  usnesení: "order",
  "usn.": "order",
  nález: "finding",
  rozhodnutí: "decision",
  stanovisko: "opinion",
  "stanovisko pléna": "opinion",
  "trestní příkaz": "penal_order",
  "tr.příkaz": "penal_order",
  opatření: "court_direction",
  "rozhodnutí ministerstva spravedlnosti": "ministry_of_justice_decision",
  "příkaz ministerstva spravedlnosti": "ministry_of_justice_decision",
  "usnesení ministerstva spravedlnosti": "ministry_of_justice_decision",
  // cz-regional stored enum members its map did not know, lowercased, in both
  // of the publisher's spellings. Read as the instrument they name.
  ministery_of_justice_decision: "ministry_of_justice_decision",
  ministery_of_justice_order: "ministry_of_justice_decision",
  ministry_of_justice_decision: "ministry_of_justice_decision",
  ministry_of_justice_resolution: "ministry_of_justice_decision",
  order_t: "penal_order",
  // Not a type: the publisher's own "not stated" member, lowercased.
  none: DECISION_TYPE_KIND_OTHER,
  // Not a type: "otherwise", the publisher's catch-all.
  jinak: DECISION_TYPE_KIND_OTHER,
  // Not a type: two types run together, which one is meant is not stated.
  "rozs.uzn": DECISION_TYPE_KIND_OTHER,
  // Not decisions: a court's letter and its analytical materials.
  přípis: DECISION_TYPE_KIND_OTHER,
  "průzkum, rozbor a jiné materiály": DECISION_TYPE_KIND_OTHER,

  // Slovak.
  rozsudok: "judgment",
  "rozsudok bez odôvodnenia": "judgment",
  "rozsudok pre uznanie": "judgment",
  "rozsudok pre vzdanie": "judgment",
  "rozsudok pre zmeškanie": "judgment",
  "čiastočný rozsudok": "judgment",
  "medzitýmny rozsudok": "judgment",
  "dopĺňací rozsudok": "judgment",
  uznesenie: "order",
  "uznesenie bez odôvodnenia": "order",
  "opravné uznesenie": "order",
  "dopĺňacie uznesenie": "order",
  príkaz: "order",
  rozhodnutie: "decision",
  "platobný rozkaz": "payment_order",
  "európsky platobný rozkaz": "payment_order",
  "zmenkový platobný rozkaz": "payment_order",
  "šekový platobný rozkaz": "payment_order",
  "rozkaz na plnenie": "payment_order",
  "trestný rozkaz": "penal_order",
  opatrenie: "court_direction",
  "opatrenie bez poučenia": "court_direction",
  // Not decisions: a certificate, an authorisation and a summons.
  osvedčenie: DECISION_TYPE_KIND_OTHER,
  poverenie: DECISION_TYPE_KIND_OTHER,
  výzva: DECISION_TYPE_KIND_OTHER,

  // Austrian (RIS `Entscheidungsart`, Findok `Dokumenttyp`).
  beschluss: "order",
  erkenntnis: "finding",
  "bescheidbeschwerde - einzel - erkenntnis": "finding",
  bescheid: "administrative_decision",
  "ordentliche erledigung (sachentscheidung)": "merits_decision",
  "zurückweisung mangels erheblicher rechtsfrage": "leave_refused",

  // Hungarian.
  ítélet: "judgment",
  végzés: "order",
  határozat: "decision",
  "jogegységi határozat": "uniformity_decision",
  "elvi határozat": "principle_decision",
  "kollégiumi állásfoglalás": "opinion",
  "kollégiumi vélemény": "opinion",

  // Polish courts and authorities.
  wyrok: "judgment",
  postanowienie: "order",
  uchwała: "resolution",
  orzeczenie: "decision",
  rozstrzygnięcie: "decision",
  decyzja: "administrative_decision",
  zarządzenie: "court_direction",
  opinia: "opinion",
  uzasadnienie: "statement_of_reasons",
  "uzasadnienie bez sentencji": "statement_of_reasons",
  "wyciąg z protokołu": "minutes_extract",
  sygnalizacja: "signalling_decision",

  // Polish tax information (KIS).
  "interpretacja indywidualna": "individual_tax_ruling",
  "zmiana interpretacji indywidualnej": "individual_tax_ruling",
  "interpretacja ogólna": "general_tax_ruling",
  "zmiana interpretacji ogólnej": "general_tax_ruling",
  "objaśnienia podatkowe": "tax_explanations",
  "wiążąca informacja stawkowa": "binding_rate_information",
  "zmiana wiążącej informacji stawkowej": "binding_rate_information",
  "odmowa wydania wiążącej informacji stawkowej": "binding_rate_information",
  "uchylenie wiążącej informacji stawkowej": "binding_rate_information",
  "uchylenie odmowy wydania wiążącej informacji stawkowej":
    "binding_rate_information",
  "wiążąca informacja akcyzowa": "binding_excise_information",
  "zmiana wiążącej informacji akcyzowej": "binding_excise_information",
  "odmowa wydania wiążącej informacji akcyzowej": "binding_excise_information",
  "uchylenie wiążącej informacji akcyzowej": "binding_excise_information",
  "informacja o wydaniu opinii zabezpieczającej": "protective_opinion",
  "informacja o odmowie wydania opinii zabezpieczającej": "protective_opinion",
  "opinia w sprawie opodatkowania wyrównawczego": "top_up_tax_opinion",
  "postanowienie o odmowie wydania opinii w sprawie opodatkowania wyrównawczego":
    "top_up_tax_opinion",
  "postanowienie rozstrzygające spór o właściwość": "order",

  // EU (CDM resource types) and the United States (CourtListener).
  judgment: "judgment",
  order: "order",
  opinion: "opinion",
  decision: "decision",
  // Not a type: eu-ecj's marker for a CDM type it does not know.
  unknown: DECISION_TYPE_KIND_OTHER,
} as const satisfies Record<string, DecisionTypeKind>;

const KIND_BY_KEY: ReadonlyMap<string, DecisionTypeKind> = new Map(
  Object.entries(STATED_DECISION_TYPE_KINDS),
);

/** The separator a publisher joins several forms of one decision with. */
const JOINED_TYPES_SEPARATOR = ",";

/**
 * How a stored decision type is read, for the census to report and the kind
 * to follow from. A docket number and a joined list are defects of the
 * adapter that stored them; they are read safely here rather than shown raw,
 * and reported rather than accepted.
 */
export type DecisionTypeReading =
  | { type: "mapped"; kind: DecisionTypeKind }
  | { type: "docket" }
  | { type: "joined"; kind: DecisionTypeKind }
  | { type: "unmapped" };

/**
 * One stored type, read. A joined list (`nález,nález`, a publisher's several
 * forms of one decision) is split and deduplicated: one distinct kind is that
 * kind, several are `other`. A decision is counted under one kind only, so a
 * facet bucket's count stays the number of rows its filter returns, and a
 * decision stating two forms does not say which one it is.
 */
export const readDecisionType = (stated: string): DecisionTypeReading => {
  const key = decisionTypeKey(stated);
  if (key === undefined) {
    return { type: "unmapped" };
  }
  const whole = KIND_BY_KEY.get(key);
  if (whole !== undefined) {
    return { type: "mapped", kind: whole };
  }
  if (isDocketShapedDecisionType(key)) {
    return { type: "docket" };
  }
  if (!key.includes(JOINED_TYPES_SEPARATOR)) {
    return { type: "unmapped" };
  }
  const kinds = new Set(
    key
      .split(JOINED_TYPES_SEPARATOR)
      .flatMap((part) => {
        const partKey = decisionTypeKey(part);
        return partKey === undefined ? [] : [partKey];
      })
      .map((partKey) => KIND_BY_KEY.get(partKey) ?? DECISION_TYPE_KIND_OTHER),
  );
  const [only] = kinds;
  return {
    type: "joined",
    kind:
      kinds.size === 1 && only !== undefined ? only : DECISION_TYPE_KIND_OTHER,
  };
};

/** The canonical kind a stored decision type states; `other` when none. */
export const decisionTypeKind = (
  stated: string | null | undefined,
): DecisionTypeKind => {
  if (stated === null || stated === undefined) {
    return DECISION_TYPE_KIND_OTHER;
  }
  const reading = readDecisionType(stated);
  switch (reading.type) {
    case "mapped":
    case "joined":
      return reading.kind;
    case "docket":
    case "unmapped":
      return DECISION_TYPE_KIND_OTHER;
    default:
      reading satisfies never;
      return panic(`Unhandled decision type reading: ${String(reading)}`);
  }
};

/**
 * Every spelling a stored type is known in: the table's keys and the exact
 * values the inventory recorded (`Uznesenie` beside `uznesenie`, joined
 * lists). The corpus index matches its raw field exactly, so its filter can
 * name only spellings it is given; the census keeps this list current.
 */
const KNOWN_SPELLINGS: readonly string[] = [
  ...new Set([
    ...KIND_BY_KEY.keys(),
    ...Object.values(inventory.jurisdictions).flat(),
    ...Object.values(inventory.adapterVocabulary).flat(),
  ]),
];

/** Every known spelling of one kind, exactly as stored. */
export const statedDecisionTypesOf = (kind: DecisionTypeKind): string[] =>
  KNOWN_SPELLINGS.filter((spelling) => decisionTypeKind(spelling) === kind);

/** Every known spelling of a kind other than the catch-all. */
export const KINDED_DECISION_TYPES: readonly string[] = KNOWN_SPELLINGS.filter(
  (spelling) => decisionTypeKind(spelling) !== DECISION_TYPE_KIND_OTHER,
);

/**
 * The kind of every known spelling, by the key Postgres compares (`lower()`
 * of the stored value), leaving out those whose kind is the catch-all: the
 * SQL `CASE` falls through to it anyway.
 */
export const DECISION_TYPE_KIND_BY_KEY: ReadonlyMap<string, DecisionTypeKind> =
  new Map(
    KNOWN_SPELLINGS.flatMap((spelling) => {
      const key = decisionTypeKey(spelling);
      const kind = decisionTypeKind(spelling);
      return key === undefined || kind === DECISION_TYPE_KIND_OTHER
        ? []
        : [[key, kind] as const];
    }),
  );

/**
 * What a request's `decisionType` selects. A kind selects every spelling of
 * it; a stated spelling the table knows selects its whole kind, so a caller
 * passing the publisher's word (`usnesení`) and one passing the facet's value
 * (`order`) get the same rows. Anything else is matched as stated.
 */
type DecisionTypeFilter =
  | { type: "kind"; kind: DecisionTypeKind }
  | { type: "stated"; stated: string };

export const decisionTypeFilter = (requested: string): DecisionTypeFilter => {
  if (isDecisionTypeKind(requested)) {
    return { type: "kind", kind: requested };
  }
  const reading = readDecisionType(requested);
  return reading.type === "unmapped"
    ? { type: "stated", stated: requested }
    : { type: "kind", kind: decisionTypeKind(requested) };
};
