import { useQueries } from "@tanstack/react-query";

import type { Block } from "@stll/legal-ast/document-ast";

import type { CitedStatuteTarget } from "@/components/legal-reader/cited-statute-link";
import { locateCzechStatuteCitations } from "@/features/case-law/fallback-legal-anchors";
import { statuteByEliOptions } from "@/features/case-law/queries/provisions";
import { decisionDateToIso } from "@/lib/decision-date";

const LINKED_WORKS_LIMIT = 12;

export type DecisionStatuteCitationAnchor = ReturnType<
  typeof locateCzechStatuteCitations
>[number] & { target: CitedStatuteTarget };

/** Work-level citations resolve to the wording applicable on the decision date. */
export const useDecisionStatuteCitationAnchors = (
  blocks: readonly Block[],
  decisionDate: Date | string | null,
): DecisionStatuteCitationAnchor[] => {
  const references = locateCzechStatuteCitations(blocks);
  const asOf = decisionDateToIso(decisionDate);
  const works = [
    ...new Set(references.map((reference) => reference.eli)),
  ].slice(0, LINKED_WORKS_LIMIT);
  const statutes = useQueries({
    queries:
      asOf === null
        ? []
        : works.map((eli) =>
            statuteByEliOptions({ asOf, country: "CZE", eli }),
          ),
  });
  const statuteByEli = new Map<
    string,
    NonNullable<(typeof statutes)[number]["data"]>
  >();
  for (const [index, eli] of works.entries()) {
    const statute = statutes[index]?.data;
    if (statute !== undefined && statute !== null) {
      statuteByEli.set(eli, statute);
    }
  }

  return references.flatMap((reference) => {
    if (!works.includes(reference.eli)) {
      return [];
    }
    const statute = statuteByEli.get(reference.eli);
    if (statute === undefined) {
      return [];
    }
    const target: CitedStatuteTarget = {
      document: { country: statute.country, id: statute.id },
      statuteTitle: statute.title,
    };
    return [{ ...reference, target }];
  });
};
