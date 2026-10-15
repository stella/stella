/**
 * What class of text an opinion's body is, from the row's type and the
 * publisher's own opinion element. Only an explicit dissent is `dissent`; a
 * concurrence, in part or whole, argues with the court's reasoning and is
 * never read as one.
 */

// parser-output-unchanged: imports the document AST from its package owner
import type { ParagraphRole } from "@stll/legal-ast/document-ast";

import type { OpinionType } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";

type BodyClass = Extract<
  ParagraphRole,
  "argumentation" | "dissent" | "unknown"
>;

type ClassDeclaration = {
  /** `unknown` where the type proves no class. */
  readonly body: BodyClass;
  /** A separate opinion beside the court's, not the principal text. */
  readonly separate: boolean;
};

const ARGUMENTATION = { body: "argumentation", separate: false } as const;
const SEPARATE_ARGUMENTATION = {
  body: "argumentation",
  separate: true,
} as const;
const SEPARATE_DISSENT = { body: "dissent", separate: true } as const;
const UNPROVEN = { body: "unknown", separate: false } as const;

/** Total over the row types. `010combined` holds what the publisher could not split. */
const ROW_CLASS = {
  "010combined": UNPROVEN,
  "015unamimous": ARGUMENTATION,
  "020lead": ARGUMENTATION,
  "025plurality": ARGUMENTATION,
  "030concurrence": SEPARATE_ARGUMENTATION,
  "035concurrenceinpart": SEPARATE_ARGUMENTATION,
  "040dissent": SEPARATE_DISSENT,
  "050addendum": UNPROVEN,
  "060remittitur": UNPROVEN,
  "070rehearing": UNPROVEN,
  "080onthemerits": ARGUMENTATION,
  "090onmotiontostrike": UNPROVEN,
  "100trialcourt": UNPROVEN,
} as const satisfies Record<OpinionType, ClassDeclaration>;

/**
 * The opinion-element type values that state a class: Harvard's
 * `<opinion type>` and the anonymized HTML's `opiniontype`. The generic
 * `opinion` proves no class; an undeclared value is an explicit conflict.
 */
const DOM_OPINION_TYPES = [
  "majority",
  "plurality",
  "unanimous",
  "on-the-merits",
  "concur",
  "concurrence",
  "concurring-in-part-and-dissenting-in-part",
  "dissent",
  "opinion",
] as const;
type DomOpinionType = (typeof DOM_OPINION_TYPES)[number];
const isDomOpinionType = (value: string): value is DomOpinionType =>
  DOM_OPINION_TYPES.some((known) => known === value);

const DOM_CLASS = {
  majority: ARGUMENTATION,
  plurality: ARGUMENTATION,
  unanimous: ARGUMENTATION,
  "on-the-merits": ARGUMENTATION,
  concur: SEPARATE_ARGUMENTATION,
  concurrence: SEPARATE_ARGUMENTATION,
  "concurring-in-part-and-dissenting-in-part": SEPARATE_ARGUMENTATION,
  dissent: SEPARATE_DISSENT,
  opinion: UNPROVEN,
} as const satisfies Record<DomOpinionType, ClassDeclaration>;

export const unrecognizedOpinionType = (
  domType: string | null,
): string | null =>
  domType !== null && !isDomOpinionType(domType) ? domType : null;

const domClass = (domType: string | null): ClassDeclaration | null =>
  domType !== null && isDomOpinionType(domType) ? DOM_CLASS[domType] : null;

type UnitClass = {
  readonly body: BodyClass;
  /** Row and element state different classes; the body stays unknown. */
  readonly conflict: boolean;
  /** The unit may be read as the principal text, not a separate opinion. */
  readonly principal: boolean;
};

/** The row's first root, a nested opinion, or an additional HTML root wrapper. */
export type UnitPosition = "row" | "nested" | "sibling";

/**
 * The class of one structural unit of a row. The element refines a row that
 * proves nothing (a combined row's `majority`); where both state a class and
 * they differ, neither is trusted and the unit is not principal text. An
 * opinion nested inside another is its own container: its class is the
 * element's alone, and it is never the principal text.
 */
export const unitClass = (
  rowType: OpinionType,
  domType: string | null,
  position: UnitPosition,
): UnitClass => {
  const dom = domClass(domType);
  if (unrecognizedOpinionType(domType) !== null || position === "sibling") {
    return {
      body: "unknown",
      conflict: true,
      principal: false,
    };
  }
  if (position === "nested") {
    return {
      body: dom?.body ?? "unknown",
      conflict: false,
      principal: false,
    };
  }
  const row: ClassDeclaration = ROW_CLASS[rowType];
  if (dom === null) {
    return {
      body: row.body,
      conflict: false,
      principal: !row.separate,
    };
  }
  if (row.body === "unknown") {
    return {
      body: dom.body,
      conflict: false,
      principal: !dom.separate,
    };
  }
  const conflict = row.body !== dom.body || row.separate !== dom.separate;
  return {
    body: conflict ? "unknown" : dom.body,
    conflict,
    principal: !conflict && !dom.separate,
  };
};

/**
 * A combined row whose own element states no class has no proven opinion
 * boundary: its blocks are scoped one by one, so no short form resolves
 * across a boundary nobody established.
 */
export const hasUnprovenBoundaries = (
  rowType: OpinionType,
  domType: string | null,
  position: UnitPosition,
): boolean =>
  unrecognizedOpinionType(domType) !== null ||
  position === "sibling" ||
  (position === "row" &&
    rowType === "010combined" &&
    (domClass(domType) === null || domClass(domType)?.body === "unknown"));
