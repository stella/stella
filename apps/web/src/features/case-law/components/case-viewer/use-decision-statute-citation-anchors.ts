import { useQuery } from "@tanstack/react-query";

import type { Block } from "@stll/legal-ast/document-ast";

import type { CitedStatuteTarget } from "@/components/legal-reader/cited-statute-link";
import { locateStatuteCitations } from "@/features/case-law/fallback-legal-anchors";
import type { StatuteCitationAnchor } from "@/features/case-law/fallback-legal-anchors";
import {
  citedWorkAtDateKey,
  statuteByCitedWork,
  statutesResolveOptions,
} from "@/features/case-law/queries/provisions";
import { decisionDateToIso } from "@/lib/decision-date";

export type DecisionStatuteCitationAnchor = StatuteCitationAnchor & {
  target: CitedStatuteTarget;
};

/** Work-level citations resolve to the wording applicable on the decision date. */
export const useDecisionStatuteCitationAnchors = (
  blocks: readonly Block[],
  decisionDate: Date | string | null,
): DecisionStatuteCitationAnchor[] => {
  const references = locateStatuteCitations(blocks);
  const asOf = decisionDateToIso(decisionDate);
  // Every cited work resolves in one request, however many the text names;
  // the query deduplicates repeated citations of one act.
  const { data: resolved } = useQuery(
    statutesResolveOptions(
      asOf === null
        ? []
        : references.map(({ eli, jurisdiction }) => ({
            asOf,
            country: jurisdiction,
            eli,
          })),
    ),
  );
  const statuteByWork = statuteByCitedWork(resolved);

  return references.flatMap((reference) => {
    const statute =
      asOf === null
        ? undefined
        : statuteByWork.get(
            citedWorkAtDateKey({
              asOf,
              country: reference.jurisdiction,
              eli: reference.eli,
            }),
          );
    if (statute === undefined) {
      return [];
    }
    const target: CitedStatuteTarget = {
      document: {
        country: statute.country,
        eli: statute.eli,
        id: statute.id,
        slug: statute.slug,
        versionValidFrom: statute.versionValidFrom,
      },
      statuteTitle: statute.title,
    };
    return [{ ...reference, target }];
  });
};
