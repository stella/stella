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
export type CitedDecision = NonNullable<DecisionCitation["decision"]>;

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
 * absence of a reading comes last. Total over the API's union, so a new
 * treatment fails typecheck here rather than rendering unlabelled.
 */
export const CITATION_TREATMENT_ORDER = [
  "negative",
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
  neutral: "caseLaw.citation.treatment.neutral",
  positive: "caseLaw.citation.treatment.positive",
  supportive: "caseLaw.citation.treatment.supportive",
  unclassified: "caseLaw.citation.treatment.unclassified",
} as const satisfies Record<CitationTreatment, TranslationKey> &
  Record<MissingFromOrder, never>;

/**
 * Colour per treatment, as a CSS class on the element that shows it. Theme
 * tokens only: the strip and the chip must agree across every theme.
 */
export const CITATION_TREATMENT_FILL = {
  negative: "fill-destructive",
  neutral: "fill-primary/40",
  positive: "fill-primary",
  supportive: "fill-primary/70",
  unclassified: "fill-muted-foreground/35",
} as const satisfies Record<CitationTreatment, string>;

export const CITATION_TREATMENT_DOT = {
  negative: "bg-destructive",
  neutral: "bg-primary/40",
  positive: "bg-primary",
  supportive: "bg-primary/70",
  unclassified: "bg-muted-foreground/35",
} as const satisfies Record<CitationTreatment, string>;

export const totalCitations = (counts: CitationTreatmentCounts): number =>
  CITATION_TREATMENT_ORDER.reduce(
    (total, treatment) => total + counts[treatment],
    0,
  );
