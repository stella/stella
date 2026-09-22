import type { TranslationKey } from "@/i18n/types";
import type { api } from "@/lib/api";

type CitationsGet = ReturnType<typeof api.case.decisions>["citations"]["get"];
type SummaryGet = ReturnType<
  typeof api.case.decisions
>["citations"]["summary"]["get"];

type CitationPageResponse = Extract<
  NonNullable<Awaited<ReturnType<CitationsGet>>["data"]>,
  { items: unknown[] }
>;

/** One citation as the graph read returns it. */
export type DecisionCitation = CitationPageResponse["items"][number];

/** The decision at the far end of a resolved citation. */
type CitedDecision = NonNullable<DecisionCitation["decision"]>;

/**
 * The same decision as a link needs it, without the ranking the citation
 * query read for it. The decision a reader is on is addressed the same way
 * but is no citation's target, so it has no `citationAuthority` to give and
 * must not be asked to invent one.
 */
export type CitedDecisionAddress = Omit<CitedDecision, "citationAuthority">;

export type DecisionCitationSummary = Extract<
  NonNullable<Awaited<ReturnType<SummaryGet>>["data"]>,
  { incoming: unknown }
>;

export type CitationTreatmentCounts = DecisionCitationSummary["incoming"];

export type CitationYearCounts =
  DecisionCitationSummary["incomingByYear"][number];

/** How the citing text treats the cited decision, as the API names it. */
export type CitationTreatment = DecisionCitation["treatment"];

/**
 * Display order: the treatment a reader must not miss comes first, and the
 * absence of a reading comes last. `mixed` follows `negative` because it
 * carries a departure of its own, though not a plain one. Total over the
 * API's union, so a new treatment fails typecheck here rather than rendering
 * unlabelled.
 */
export const CITATION_TREATMENT_ORDER = [
  "negative",
  "mixed",
  "neutral",
  "positive",
  "supportive",
  "unclassified",
] as const satisfies readonly CitationTreatment[];

/**
 * A treatment the API names but the order above omits. Empty when the order
 * is total; otherwise the label map below is asked for an impossible entry,
 * which is the typecheck failure that points here.
 */
type MissingFromOrder = Exclude<
  CitationTreatment,
  (typeof CITATION_TREATMENT_ORDER)[number]
>;

export const CITATION_TREATMENT_LABEL = {
  negative: "caseLaw.citation.treatment.negative",
  mixed: "caseLaw.citation.treatment.mixed",
  neutral: "caseLaw.citation.treatment.neutral",
  positive: "caseLaw.citation.treatment.positive",
  supportive: "caseLaw.citation.treatment.supportive",
  unclassified: "caseLaw.citation.treatment.unclassified",
} as const satisfies Record<CitationTreatment, TranslationKey> &
  Record<MissingFromOrder, never>;

/**
 * Colour per treatment, as an SVG fill class: the year strip and the timeline
 * chart draw from this one map, so a year cannot read one way at a glance and
 * another way when the reader opens it.
 *
 * Status tokens, not a categorical palette, because the series *are* a
 * status: whether the citing court stood by this decision or went against
 * it. So the two positive grades take one hue at two weights (endorsed is
 * the stronger), negative takes `destructive`, and what carries no reading
 * recedes into the neutrals. `--primary` is a neutral in this brand, which is
 * what made every treatment read as the same grey before.
 *
 * Red against green is the colour-blind reader's hard pair, so both graphics
 * hatch negative on top of the colour (`CitationNegativeHatch`) and every
 * count carries its label: colour is never the only thing that says it. It is
 * also why `mixed` takes `warning`, where a third green or a second red would
 * read as one more grade of the neighbour it is not.
 */
export const CITATION_TREATMENT_FILL = {
  negative: "fill-destructive",
  mixed: "fill-warning",
  neutral: "fill-foreground-muted",
  positive: "fill-success",
  supportive: "fill-success/60",
  unclassified: "fill-foreground-disabled",
} as const satisfies Record<CitationTreatment, string>;

export const CITATION_TREATMENT_DOT = {
  negative: "bg-destructive",
  mixed: "bg-warning",
  neutral: "bg-foreground-muted",
  positive: "bg-success",
  supportive: "bg-success/60",
  unclassified: "bg-foreground-disabled",
} as const satisfies Record<CitationTreatment, string>;

/**
 * The wash a decision reference carries inside the judgment's own text, so a
 * reader scanning a page can see where this court leaned on other decisions.
 *
 * Deliberately faint: under a tenth of the token, no border, and the text
 * keeps its own colour and its underline, which is what still marks the
 * reference for a reader who cannot see the tint or is reading it on paper.
 * The vocabulary is the strip's and the chart's: what went against the cited
 * decision is destructive, what stood by it is success, and what did both is
 * warning.
 */
const DECISION_REFERENCE_UNKNOWN_TINT =
  "bg-foreground/6 hover:bg-foreground/10";

const CITATION_TREATMENT_TINT = {
  negative: "bg-destructive/8 hover:bg-destructive/14",
  mixed: "bg-warning/8 hover:bg-warning/14",
  neutral: DECISION_REFERENCE_UNKNOWN_TINT,
  positive: "bg-success/10 hover:bg-success/16",
  supportive: "bg-success/8 hover:bg-success/14",
  unclassified: DECISION_REFERENCE_UNKNOWN_TINT,
} as const satisfies Record<CitationTreatment, string>;

/**
 * `box-decoration-clone` so a citation broken across two lines keeps its
 * rounded ends on both, and no tint at all on paper, where a grey wash only
 * costs toner.
 */
const DECISION_REFERENCE_TINT_SHAPE =
  "box-decoration-clone rounded-sm px-0.5 print:bg-transparent";

/**
 * The tint for one reference: its treatment's, where the citator classified
 * the citation, and the neutral wash where it did not (an unresolved or
 * external reference is still a reference).
 */
export const decisionReferenceTintClassName = (
  treatment?: CitationTreatment,
): string =>
  `${DECISION_REFERENCE_TINT_SHAPE} ${treatment === undefined ? DECISION_REFERENCE_UNKNOWN_TINT : CITATION_TREATMENT_TINT[treatment]}`;

export const totalCitations = (counts: CitationTreatmentCounts): number =>
  CITATION_TREATMENT_ORDER.reduce(
    (total, treatment) => total + counts[treatment],
    0,
  );
