import type { CitationPage } from "./parse";

type CitationTreatment = CitationPage["citations"][number]["polarity"];

/** Every treatment the citations contract allows, in its declared order. */
export const CITATION_TREATMENTS = [
  "negative",
  "neutral",
  "positive",
  "supportive",
  "mixed",
  "unclassified",
] as const satisfies readonly CitationTreatment[];

// A treatment added to the contract must be listed here as well.
true satisfies [
  Exclude<CitationTreatment, (typeof CITATION_TREATMENTS)[number]>,
] extends [never]
  ? true
  : false;
