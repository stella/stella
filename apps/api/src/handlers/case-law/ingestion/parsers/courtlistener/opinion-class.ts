/**
 * What class of text an opinion's body is, from the row's type and the
 * publisher's own opinion element. Only an explicit dissent is `dissent`; a
 * concurrence, in part or whole, argues with the court's reasoning and is
 * never read as one.
 */

import type { ParagraphRole } from "@/api/handlers/case-law/document-ast";
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
 * The Harvard `<opinion type>` values that state a class. Any other value,
 * the generic `opinion` included, is a wrapper that proves none.
 */
const DOM_CLASS: Readonly<Record<string, ClassDeclaration>> = {
  majority: ARGUMENTATION,
  plurality: ARGUMENTATION,
  unanimous: ARGUMENTATION,
  "on-the-merits": ARGUMENTATION,
  concurrence: SEPARATE_ARGUMENTATION,
  "concurring-in-part-and-dissenting-in-part": SEPARATE_ARGUMENTATION,
  dissent: SEPARATE_DISSENT,
};

const domClass = (domType: string | null): ClassDeclaration | null =>
  domType !== null && Object.hasOwn(DOM_CLASS, domType)
    ? (DOM_CLASS[domType] ?? null)
    : null;

type UnitClass = {
  readonly body: BodyClass;
  readonly separate: boolean;
  /** The element states a class of its own. */
  readonly structural: boolean;
  /** Row and element state different classes; the body stays unknown. */
  readonly conflict: boolean;
};

/**
 * The class of one structural unit of a row. The element refines a row that
 * proves nothing (a combined row's `majority`); where both state a class and
 * they differ, neither is trusted.
 */
export const unitClass = (
  rowType: OpinionType,
  domType: string | null,
): UnitClass => {
  const row: ClassDeclaration = ROW_CLASS[rowType];
  const dom = domClass(domType);
  if (dom === null) {
    return { ...row, structural: false, conflict: false };
  }
  if (row.body === "unknown") {
    return { ...dom, structural: true, conflict: false };
  }
  const conflict = row.body !== dom.body || row.separate !== dom.separate;
  return conflict
    ? { body: "unknown", separate: row.separate, structural: true, conflict }
    : { ...dom, structural: true, conflict };
};

/**
 * A combined row whose element states no class has no proven opinion
 * boundary: its blocks are scoped one by one, so no short form resolves
 * across a boundary nobody established.
 */
export const hasUnprovenBoundaries = (
  rowType: OpinionType,
  domType: string | null,
): boolean => rowType === "010combined" && domClass(domType) === null;
