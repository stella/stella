/**
 * The key under which a Constitutional Tribunal ruling stored by one Polish
 * source meets the same ruling stored by another.
 *
 * `pl-tk` (the Tribunal's own portal) and `pl-courts` (SAOS, which republished
 * the Tribunal until 2015-12-09) store the same rulings under their own ids.
 * Rows are related by what both state: the docket in the shared comparison
 * spelling (SAOS's `U. 4/86` is the portal's `U 4/86`), the decision date and
 * the kind of ruling. Both rows are kept.
 *
 * A candidate key, not an identity: the Tribunal issues several procedural
 * decisions in one case on one day often enough (costs orders beside a
 * judgment), so two rows sharing it are one ruling only when neither source
 * holds a second one under it.
 */

import { polishConstitutionalDocketKey } from "@stll/api-contract/decision-docket-grammar";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifier } from "@stll/legal-ast/decision-identifier";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { arrayOrEmpty } from "@/api/lib/array";

const CONSTITUTIONAL_TRIBUNAL = "trybunał konstytucyjny";

/**
 * What a ruling is, whichever source names it: a judgment on the merits
 * (`wyrok`, the pre-1997 `orzeczenie`, and the three 2016 judgments the
 * portal files as `rozstrzygnięcie`), a procedural decision (`postanowienie`,
 * a signalling decision among them), or a resolution (`uchwała`). SAOS names
 * the same three as SENTENCE, DECISION and RESOLUTION.
 */
export const PL_TK_RULING_FAMILY = {
  wyrok: "wyrok",
  orzeczenie: "wyrok",
  rozstrzygnięcie: "wyrok",
  postanowienie: "postanowienie",
  sygnalizacja: "postanowienie",
  uchwała: "uchwała",
} as const;

const FAMILIES: ReadonlyMap<string, string> = new Map(
  Object.entries(PL_TK_RULING_FAMILY),
);

/** The kind a key names: a type outside the table keys as itself. */
const familyOf = (decisionType: string): string => {
  const type = decisionType.toLocaleLowerCase("pl-PL");
  return FAMILIES.get(type) ?? type;
};

type ConstitutionalTribunalRulingKeyInput = Pick<
  IngestionResult,
  "caseNumber" | "court" | "decisionDate" | "decisionType"
> & {
  /** Every further identifier the row states; only its dockets count. */
  identifiers?: readonly DecisionIdentifier[] | undefined;
};

/**
 * One key per Tribunal docket the row states, or none: for a row of another
 * court, one missing its date or kind, or a docket the shared grammar does
 * not read as the Tribunal's.
 */
export const plConstitutionalTribunalRulingKeys = ({
  caseNumber,
  court,
  decisionDate,
  decisionType,
  identifiers,
}: ConstitutionalTribunalRulingKeyInput): string[] => {
  if (
    court.replace(/\s+/gu, " ").trim().toLocaleLowerCase("pl-PL") !==
      CONSTITUTIONAL_TRIBUNAL ||
    decisionDate === undefined ||
    decisionType === undefined
  ) {
    return [];
  }
  const family = familyOf(decisionType);
  const dockets = [
    caseNumber,
    ...arrayOrEmpty(identifiers)
      .filter(({ type }) => type === DECISION_IDENTIFIER_TYPES.CASE_NUMBER)
      .map(({ value }) => value),
  ];
  return [
    ...new Set(
      dockets.flatMap((docket) => {
        const key = polishConstitutionalDocketKey(docket);
        return key === null ? [] : [`tk|${key}|${decisionDate}|${family}`];
      }),
    ),
  ];
};
