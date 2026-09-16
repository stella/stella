import { useQueries } from "@tanstack/react-query";

import type { Block } from "@stll/legal-ast/document-ast";

import type { CitedStatuteTarget } from "@/components/legal-reader/cited-statute-link";
import { locateStatuteCitations } from "@/features/case-law/fallback-legal-anchors";
import type { StatuteCitationAnchor } from "@/features/case-law/fallback-legal-anchors";
import { statuteByEliOptions } from "@/features/case-law/queries/provisions";
import { decisionDateToIso } from "@/lib/decision-date";

const LINKED_WORKS_LIMIT = 12;

export type DecisionStatuteCitationAnchor = StatuteCitationAnchor & {
  target: CitedStatuteTarget;
};

const workKeyOf = ({
  eli,
  jurisdiction,
}: Pick<StatuteCitationAnchor, "eli" | "jurisdiction">): string =>
  `${jurisdiction}/${eli}`;

/** Work-level citations resolve to the wording applicable on the decision date. */
export const useDecisionStatuteCitationAnchors = (
  blocks: readonly Block[],
  decisionDate: Date | string | null,
): DecisionStatuteCitationAnchor[] => {
  const references = locateStatuteCitations(blocks);
  const asOf = decisionDateToIso(decisionDate);
  const works: Pick<StatuteCitationAnchor, "eli" | "jurisdiction">[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const key = workKeyOf(reference);
    if (seen.has(key) || works.length >= LINKED_WORKS_LIMIT) {
      continue;
    }
    seen.add(key);
    works.push({ eli: reference.eli, jurisdiction: reference.jurisdiction });
  }
  const statutes = useQueries({
    queries:
      asOf === null
        ? []
        : works.map(({ eli, jurisdiction }) =>
            statuteByEliOptions({ asOf, country: jurisdiction, eli }),
          ),
  });
  const statuteByWork = new Map<
    string,
    NonNullable<(typeof statutes)[number]["data"]>
  >();
  for (const [index, work] of works.entries()) {
    const statute = statutes[index]?.data;
    if (statute !== undefined && statute !== null) {
      statuteByWork.set(workKeyOf(work), statute);
    }
  }

  return references.flatMap((reference) => {
    const statute = statuteByWork.get(workKeyOf(reference));
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
