import {
  DECISION_TYPE_KIND_OTHER,
  isDecisionTypeKind,
  type DecisionTypeKind,
} from "@stll/api-contract/case-law-decision-types";

/** A comparison key only; the publisher's spelling remains on the decision. */
export const decisionTypeKey = (stated: string | null | undefined) =>
  stated?.normalize("NFC").trim().toLowerCase() || undefined;

/**
 * Every decision type the corpus stores, exactly as stored, and the canonical
 * kind it states. The stored value is never rewritten: this is the one place a
 * spelling is read as a kind, for the type facet, its filter and both search
 * providers.
 *
 * Exact spellings rather than keys, because the corpus index holds the type in
 * a raw field and its filter can only name spellings it was given. Ingestion
 * lowercases every type (`ingestion-normalization.ts`), so the stored
 * spellings are lowercase; the lookup below still folds case and Unicode form.
 *
 * Total over `decision-type-inventory.json`, the census of what each
 * jurisdiction stores: `decision-type-census.test.ts` fails on a stored type
 * missing here. A spelling mapped to `other` is a decision, not an omission.
 */
export const STATED_DECISION_TYPE_KINDS = {
  // Czech. `usn.` is a publisher's abbreviation of usnesení, stated as the
  // type of a few decisions and kept as stated.
  rozsudek: "judgment",
  usnesení: "order",
  "usn.": "order",
  nález: "finding",
  stanovisko: "opinion",
  "stanovisko pléna": "opinion",
  "trestní příkaz": "penal_order",
  "rozhodnutí ministerstva spravedlnosti": "ministry_of_justice_decision",
  // cz-regional stored an enum member its map did not know, lowercased.
  // `order_t` is the publisher's criminal order before the map named it, and
  // `ministery_of_justice_decision` the publisher's member (its spelling) for
  // a Ministry of Justice decision before the map named that.
  order_t: "penal_order",
  ministery_of_justice_decision: "ministry_of_justice_decision",

  // Slovak.
  rozsudok: "judgment",
  uznesenie: "order",
  "uznesenie bez odôvodnenia": "order",
  "uznesenie o trovách": "order",
  rozhodnutie: "decision",
  "platobný rozkaz": "payment_order",
  "trestný rozkaz": "penal_order",

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
  // eu-ecj's own marker for a document whose CDM type it does not know.
  unknown: DECISION_TYPE_KIND_OTHER,
} as const satisfies Record<string, DecisionTypeKind>;

const STATED_ENTRIES = Object.entries(STATED_DECISION_TYPE_KINDS);

/** Every spelling the table names, for a clause that must exclude them all. */
export const STATED_DECISION_TYPES = STATED_ENTRIES.map(([stated]) => stated);

/**
 * The table by comparison key. Two spellings folding to one key must name one
 * kind (`decision-type-key.test.ts`), so the fold never decides between them
 * by table order.
 */
export const DECISION_TYPE_KIND_BY_KEY: ReadonlyMap<string, DecisionTypeKind> =
  new Map(
    STATED_ENTRIES.map(
      ([stated, kind]) => [decisionTypeKey(stated) ?? stated, kind] as const,
    ),
  );

/** The canonical kind a stored decision type states; `other` when none. */
export const decisionTypeKind = (
  stated: string | null | undefined,
): DecisionTypeKind => {
  const key = decisionTypeKey(stated);
  return (
    (key === undefined ? undefined : DECISION_TYPE_KIND_BY_KEY.get(key)) ??
    DECISION_TYPE_KIND_OTHER
  );
};

/** Every stored spelling of one kind, exactly as stored. */
export const statedDecisionTypesOf = (kind: DecisionTypeKind): string[] =>
  STATED_ENTRIES.flatMap(([stated, statedKind]) =>
    statedKind === kind ? [stated] : [],
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
  const key = decisionTypeKey(requested);
  const kind =
    key === undefined ? undefined : DECISION_TYPE_KIND_BY_KEY.get(key);
  return kind === undefined
    ? { type: "stated", stated: requested }
    : { type: "kind", kind };
};
