/**
 * The delta vocabulary the presentation components render, derived from the
 * finding the run persisted rather than restated here. A shape change on the
 * engine fails to compile in the component that draws it.
 */

import type { ReviewFinding } from "@/components/ai-suggestions/document-review-queries";

/** What differs between the document and the standard, typed by the shape of
 *  the difference. */
export type ReviewDelta = ReviewFinding["delta"];
export type ReviewDeltaKind = ReviewDelta["kind"];

/** One side of a parameter difference: the term as the block reads it, plus
 *  its parsed form when the model could resolve one. */
export type DeltaValue = NonNullable<
  Extract<ReviewDelta, { kind: "parameter" }>["target"]
>;

/** One quoted block, by id and text. */
export type DeltaCitation = DeltaValue["citation"];

/** Which way a difference cuts for the side the run was judged for. */
export type ReviewImpact = NonNullable<ReviewFinding["impact"]>;

/** How consistently the standard's own passages agreed. */
export type ReviewConsensus = NonNullable<ReviewFinding["consensus"]>;
