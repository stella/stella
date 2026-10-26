import { useQuery } from "@tanstack/react-query";

import { locateStatuteCitations } from "@stll/decision-reader/fallback-legal-anchors";
import type { DecisionStatuteCitationAnchor } from "@stll/decision-reader/reader-types";
import type { Block } from "@stll/legal-ast/document-ast";

import {
  citedWorkAtDateKey,
  statuteByCitedWork,
  statutesResolveOptions,
} from "@/features/case-law/queries/provisions";
import { decisionDateToIso } from "@/lib/decision-date";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/** Work-level citations resolve to the wording applicable on the decision date. */
export const useDecisionStatuteCitationAnchors = (
  blocks: readonly Block[],
  decisionDate: string | null,
): DecisionStatuteCitationAnchor[] => {
  const references = locateStatuteCitations(blocks);
  const asOf = decisionDateToIso(decisionDate);
  // Every cited work resolves in one request, however many the text names;
  // the query deduplicates repeated citations of one act.
  const resolvedQuery = useQuery(
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
  const resolvedView = queryView(resolvedQuery);
  useQueryViewError(resolvedView, "useDecisionStatuteCitationAnchors:query");
  const resolved =
    resolvedView.type === "items" ? resolvedView.items : undefined;
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
    const target = {
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
