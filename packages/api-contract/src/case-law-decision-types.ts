/**
 * The canonical kinds a case-law decision type facet reports.
 *
 * Publishers state a decision's type in their own words and spellings
 * (`usnesení`, `usn.`, `uznesenie`, `postanowienie`, `Beschluss`), and those
 * stay stored as stated. A facet and its filter speak in these kinds instead,
 * so the API never hands a reader a raw spelling or an enum member, and the
 * web labels each kind in the reader's language. The API owns which stated
 * spelling is which kind; this list is the vocabulary both sides share.
 *
 * `other` is the catch-all for a stated type no kind claims yet. It is a
 * bucket a reader can see and filter by, never a stated spelling shown raw.
 */
export const DECISION_TYPE_KINDS = [
  "judgment",
  "order",
  "finding",
  "resolution",
  "opinion",
  "decision",
  "administrative_decision",
  "ministry_of_justice_decision",
  "penal_order",
  "payment_order",
  "uniformity_decision",
  "principle_decision",
  "merits_decision",
  "leave_refused",
  "court_direction",
  "statement_of_reasons",
  "minutes_extract",
  "signalling_decision",
  "individual_tax_ruling",
  "general_tax_ruling",
  "tax_explanations",
  "binding_rate_information",
  "binding_excise_information",
  "protective_opinion",
  "top_up_tax_opinion",
  "other",
] as const;

export type DecisionTypeKind = (typeof DECISION_TYPE_KINDS)[number];

export const DECISION_TYPE_KIND_OTHER = "other" satisfies DecisionTypeKind;

export const isDecisionTypeKind = (value: string): value is DecisionTypeKind =>
  DECISION_TYPE_KINDS.some((kind) => kind === value);
