import { useInfiniteQuery, useQueries } from "@tanstack/react-query";

import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";

import type { CitedProvisionTarget } from "@/components/legal-reader/cited-provision-link";
import type { ProvisionAnchorSource } from "@/features/case-law/provision-anchors";
import { formatProvisionReference } from "@/features/case-law/provision-label";
import {
  decisionProvisionsInfiniteOptions,
  statuteByEliOptions,
  statuteVersionsOptions,
} from "@/features/case-law/queries/provisions";
import {
  pickVersionAt,
  versionCoversDate,
} from "@/features/case-law/statute-version";
import { useProvisionPartRenderer } from "@/features/case-law/use-provision-part-renderer";
import { optionalArray } from "@/lib/arrays";
import { decisionDateToIso } from "@/lib/decision-date";
import type { SafeId } from "@/lib/safe-id";

/**
 * Works whose act is resolved for inline linking. Each distinct work costs one
 * read; past this many the references still read as text, as in the panel.
 */
const LINKED_WORKS_LIMIT = 12;

export type DecisionProvisionAnchor =
  ProvisionAnchorSource<CitedProvisionTarget>;

type WorkKey = { asOf: string; eli: string; jurisdiction: string };

const workKeyOf = ({
  eli,
  jurisdiction,
}: Pick<WorkKey, "eli" | "jurisdiction">): string => `${jurisdiction}/${eli}`;

/**
 * The provisions a decision applies, each resolved to the consolidation it
 * was made against, ready to be located in the text. A reference whose work
 * the corpus does not hold, or whose cited version is not yet known, is left
 * out: it reads as text until it can link somewhere it belongs.
 */
export const useDecisionProvisionAnchors = (
  decisionId: SafeId<"caseLawDecision">,
  decisionDate: Date | string | null,
): DecisionProvisionAnchor[] => {
  const renderPart = useProvisionPartRenderer();
  const { data } = useInfiniteQuery(
    decisionProvisionsInfiniteOptions(decisionId),
  );
  const pages = optionalArray(data?.pages);
  const rows = pages.flatMap((page) => page.items);
  // The list carries the wording of the provisions it could read, keyed by
  // the server that resolved them; a row it could not read hovers to its own
  // preview request.
  const previewByKey = new Map(
    pages.flatMap((page) =>
      page.previews.map((preview) => [preview.key, preview] as const),
    ),
  );

  const works: WorkKey[] = [];
  const seen = new Set<string>();
  const decisionAsOf = decisionDateToIso(decisionDate);
  for (const row of rows) {
    if (row.workEli === null) {
      continue;
    }
    const asOf = row.versionValidFrom ?? decisionAsOf;
    if (asOf === null) {
      continue;
    }
    const key = workKeyOf({ eli: row.workEli, jurisdiction: row.jurisdiction });
    if (seen.has(key) || works.length >= LINKED_WORKS_LIMIT) {
      continue;
    }
    seen.add(key);
    works.push({ asOf, eli: row.workEli, jurisdiction: row.jurisdiction });
  }

  const statutes = useQueries({
    queries: works.map((work) =>
      statuteByEliOptions({
        asOf: work.asOf,
        country: work.jurisdiction,
        eli: work.eli,
      }),
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

  // The inspector also needs the count when the current consolidation covers
  // the cited date, so every linked work reads its version list once.
  const versionedWorks = works.filter((work) =>
    statuteByWork.has(workKeyOf(work)),
  );
  const versions = useQueries({
    queries: versionedWorks.map((work) => {
      const statute = statuteByWork.get(workKeyOf(work));
      return statuteVersionsOptions(statute?.id ?? "");
    }),
  });
  const versionsByWork = new Map<
    string,
    NonNullable<(typeof versions)[number]["data"]>
  >();
  for (const [index, work] of versionedWorks.entries()) {
    const list = versions[index]?.data;
    if (list !== undefined) {
      versionsByWork.set(workKeyOf(work), list);
    }
  }

  const anchors: DecisionProvisionAnchor[] = [];
  for (const row of rows) {
    if (row.workEli === null) {
      continue;
    }
    const key = workKeyOf({ eli: row.workEli, jurisdiction: row.jurisdiction });
    const statute = statuteByWork.get(key);
    if (statute === undefined) {
      continue;
    }
    const document =
      row.versionValidFrom === null ||
      versionCoversDate(statute, row.versionValidFrom)
        ? statute
        : pickVersionAt(
            optionalArray(versionsByWork.get(key)),
            row.versionValidFrom,
          );
    if (document === null) {
      continue;
    }
    const versionCount = versionsByWork.get(key)?.length ?? 1;
    // The card quotes the consolidation the link opens, so a preview read
    // from another one is dropped rather than shown beside the wrong link.
    const preview =
      row.previewKey === null ? undefined : previewByKey.get(row.previewKey);
    anchors.push({
      id: `${row.anchor}-${String(row.spanStart)}`,
      reference: row,
      sentenceText: row.sentenceText,
      spanStart: row.spanStart,
      target: {
        document: { country: document.country, id: document.id },
        preview: preview?.documentId === document.id ? preview : null,
        payload: {
          anchorId: provisionHeadingAnchor(row.anchor),
          highlightAnchorId: row.anchor,
          documentId: document.id,
          eli: row.workEli,
          jurisdiction: row.jurisdiction,
          provisionLabel: formatProvisionReference(row, renderPart),
          statuteTitle: document.title,
          versionCount,
          versionValidFrom: document.versionValidFrom,
        },
      },
    });
  }

  return anchors;
};
