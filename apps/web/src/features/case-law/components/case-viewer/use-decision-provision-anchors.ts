import { useQueries, useQuery } from "@tanstack/react-query";

import { isCaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { Block } from "@stll/legal-ast/document-ast";
import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";
import { PROVISION_CITATION_GRAMMARS } from "@stll/legal-atlas/provision-citation-grammars";
import type { SupportedProvisionCitationGrammar } from "@stll/legal-atlas/provision-citation-grammars";

import type { CitedProvisionTarget } from "@/components/legal-reader/cited-provision-link";
import { locateAbbreviatedProvisionCitations } from "@/features/case-law/fallback-legal-anchors";
import type { ProvisionAnchorSource } from "@/features/case-law/provision-anchors";
import { formatProvisionReference } from "@/features/case-law/provision-label";
import {
  decisionProvisionsForLinkingOptions,
  statuteByEliOptions,
  statuteVersionsOptions,
} from "@/features/case-law/queries/provisions";
import {
  pickVersionAt,
  referencesOutsideVersion,
  versionCoversDate,
} from "@/features/case-law/statute-version";
import { useProvisionPartRenderer } from "@/features/case-law/use-provision-part-renderer";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";
import { optionalArray } from "@/lib/arrays";
import { decisionDateToIso } from "@/lib/decision-date";
import { ClientTelemetryError } from "@/lib/errors/telemetry";
import type { SafeId } from "@/lib/safe-id";

/**
 * Works whose act is resolved for inline linking. Each distinct work costs one
 * read; past this many the references still read as text, as in the panel.
 */
const LINKED_WORKS_LIMIT = 12;

export type DecisionProvisionAnchor =
  ProvisionAnchorSource<CitedProvisionTarget>;

type UseDecisionProvisionAnchorsOptions = {
  blocks: readonly Block[];
  /** The citing court's jurisdiction; null while the decision is loading. */
  country: string | null;
  decisionDate: Date | string | null;
  decisionId: SafeId<"caseLawDecision">;
};

/**
 * The grammar of the citing court, or null where its citations read as text.
 * A decision row is history and may carry a code no jurisdiction declares;
 * such a code is reported when it is first seen rather than parsed by
 * another country's grammar.
 */
const useCitingProvisionCitationGrammar = (
  country: string | null,
): SupportedProvisionCitationGrammar | null => {
  const declared =
    country !== null && isCaseLawJurisdiction(country) ? country : null;
  const undeclared = declared === null ? country : null;
  useExternalSyncEffect(() => {
    if (undeclared === null) {
      return;
    }
    getAnalytics().captureError(
      new ClientTelemetryError({
        area: "case-law-provision-grammar",
        message: `[Case-law provision grammar] Undeclared jurisdiction ${undeclared}`,
      }),
    );
  }, [undeclared]);
  if (declared === null) {
    return null;
  }
  const grammar = PROVISION_CITATION_GRAMMARS[declared];
  return grammar.status === "supported" ? grammar : null;
};

type WorkKey = { asOf: string; eli: string; jurisdiction: string };

/**
 * A work to resolve, carrying the references that named it. The array is the
 * one the grouping accumulates into, so references seen after the work was
 * collected are in it too.
 */
type LinkedWork = WorkKey & { rows: { versionValidFrom: string | null }[] };

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
export const useDecisionProvisionAnchors = ({
  blocks,
  country,
  decisionDate,
  decisionId,
}: UseDecisionProvisionAnchorsOptions): DecisionProvisionAnchor[] => {
  const renderPart = useProvisionPartRenderer();
  const { data } = useQuery(decisionProvisionsForLinkingOptions(decisionId));
  const rows = optionalArray(data?.items);
  // The list carries the wording of the provisions it could read, keyed by
  // the server that resolved them; a row it could not read hovers to its own
  // preview request.
  const previewByKey = new Map(
    optionalArray(data?.previews).map(
      (preview) => [preview.key, preview] as const,
    ),
  );

  const grammar = useCitingProvisionCitationGrammar(country);
  const fallbackReferences =
    grammar === null
      ? []
      : locateAbbreviatedProvisionCitations(blocks, grammar);
  const works: LinkedWork[] = [];
  const seen = new Set<string>();
  const rowsByWork = new Map<string, (typeof rows)[number][]>();
  const decisionAsOf = decisionDateToIso(decisionDate);
  for (const row of rows) {
    if (row.workEli === null) {
      continue;
    }
    const key = workKeyOf({ eli: row.workEli, jurisdiction: row.jurisdiction });
    let workRows = rowsByWork.get(key);
    if (workRows === undefined) {
      workRows = [];
      rowsByWork.set(key, workRows);
    }
    workRows.push(row);
    const asOf = row.versionValidFrom ?? decisionAsOf;
    if (asOf === null) {
      continue;
    }
    if (seen.has(key) || works.length >= LINKED_WORKS_LIMIT) {
      continue;
    }
    seen.add(key);
    works.push({
      asOf,
      eli: row.workEli,
      jurisdiction: row.jurisdiction,
      rows: workRows,
    });
  }
  for (const reference of fallbackReferences) {
    if (decisionAsOf === null) {
      continue;
    }
    const key = workKeyOf({
      eli: reference.abbreviation.eli,
      jurisdiction: reference.jurisdiction,
    });
    const existing = works.find((work) => workKeyOf(work) === key);
    if (existing !== undefined) {
      existing.rows.push({ versionValidFrom: decisionAsOf });
      continue;
    }
    if (works.length >= LINKED_WORKS_LIMIT) {
      continue;
    }
    seen.add(key);
    works.push({
      asOf: decisionAsOf,
      eli: reference.abbreviation.eli,
      jurisdiction: reference.jurisdiction,
      rows: [{ versionValidFrom: decisionAsOf }],
    });
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

  // Only a work some reference reaches past reads its version list; the
  // consolidation already resolved answers every reference it covers.
  const versionedWorks: { key: string; statuteId: string }[] = [];
  for (const work of works) {
    const key = workKeyOf(work);
    const statute = statuteByWork.get(key);
    if (
      statute === undefined ||
      !referencesOutsideVersion(statute, work.rows)
    ) {
      continue;
    }
    versionedWorks.push({ key, statuteId: statute.id });
  }
  const versions = useQueries({
    queries: versionedWorks.map(({ statuteId }) =>
      statuteVersionsOptions(statuteId),
    ),
  });
  const versionsByWork = new Map<
    string,
    NonNullable<(typeof versions)[number]["data"]>
  >();
  for (const [index, { key }] of versionedWorks.entries()) {
    const list = versions[index]?.data;
    if (list !== undefined) {
      versionsByWork.set(key, list);
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
    // A seed only: one when this reader never had reason to read the list.
    // The provision view reads it itself and counts from there.
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
        document: {
          country: document.country,
          eli: document.eli,
          id: document.id,
          slug: document.slug,
          versionValidFrom: document.versionValidFrom,
        },
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

  for (const reference of fallbackReferences) {
    if (decisionAsOf === null) {
      continue;
    }
    const { eli } = reference.abbreviation;
    const key = workKeyOf({ eli, jurisdiction: reference.jurisdiction });
    const statute = statuteByWork.get(key);
    if (statute === undefined) {
      continue;
    }
    const document = versionCoversDate(statute, decisionAsOf)
      ? statute
      : pickVersionAt(optionalArray(versionsByWork.get(key)), decisionAsOf);
    if (document === null) {
      continue;
    }
    anchors.push({
      exactSpan: {
        blockId: reference.blockId,
        end: reference.end,
        start: reference.start,
      },
      id: reference.id,
      reference: reference.reference,
      sentenceText: reference.sentenceText,
      spanStart: reference.spanStart,
      target: {
        document: {
          country: document.country,
          eli: document.eli,
          id: document.id,
          slug: document.slug,
          versionValidFrom: document.versionValidFrom,
        },
        payload: {
          anchorId: provisionHeadingAnchor(reference.anchor),
          highlightAnchorId: reference.anchor,
          documentId: document.id,
          eli,
          jurisdiction: reference.jurisdiction,
          provisionLabel: formatProvisionReference(
            reference.reference,
            renderPart,
          ),
          statuteTitle: document.title,
          versionCount: versionsByWork.get(key)?.length ?? 1,
          versionValidFrom: document.versionValidFrom,
        },
        preview: null,
      },
    });
  }

  return anchors;
};
