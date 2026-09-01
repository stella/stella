import type { CaseLawResearchDisposition } from "@stll/api-contract";

export type ResearchDecisionDisposition = {
  decisionId: string;
  disposition: CaseLawResearchDisposition;
  position: number;
};

export type ResearchRow<TDecision> = {
  decision: TDecision;
  /** Null for a row the saved query alone put here. */
  disposition: CaseLawResearchDisposition | null;
};

type MergeResearchRowsOptions<TDecision> = {
  /** What the saved query returns, in its order; may be several pages. */
  queryRows: readonly TDecision[];
  /** Row facts of pinned decisions, whether or not the query returns them. */
  pinnedDecisions: readonly TDecision[];
  dispositions: readonly ResearchDecisionDisposition[];
  /** Keep excluded rows visible (marked) instead of dropping them. */
  showExcluded: boolean;
};

/**
 * The rows of a research table: pinned decisions first, in pin order, then
 * what the saved query returns minus what was excluded, each decision once.
 * A pinned decision the corpus no longer offers (redacted, or its source
 * turned restricted) has no facts to show and is simply absent.
 */
export const mergeResearchRows = <TDecision extends { id: string }>({
  dispositions,
  pinnedDecisions,
  queryRows,
  showExcluded,
}: MergeResearchRowsOptions<TDecision>): ResearchRow<TDecision>[] => {
  const dispositionById = new Map(
    dispositions.map((entry) => [entry.decisionId, entry]),
  );
  const pinnedById = new Map(
    pinnedDecisions.map((decision) => [decision.id, decision]),
  );
  const rows: ResearchRow<TDecision>[] = [];
  const seen = new Set<string>();

  const pinned = dispositions
    .filter((entry) => entry.disposition === "pinned")
    .toSorted(
      (a, b) =>
        a.position - b.position || a.decisionId.localeCompare(b.decisionId),
    );
  for (const entry of pinned) {
    const decision = pinnedById.get(entry.decisionId);
    if (decision === undefined || seen.has(decision.id)) {
      continue;
    }
    seen.add(decision.id);
    rows.push({ decision, disposition: "pinned" });
  }

  for (const decision of queryRows) {
    if (seen.has(decision.id)) {
      continue;
    }
    const disposition = dispositionById.get(decision.id)?.disposition ?? null;
    if (disposition === "excluded" && !showExcluded) {
      continue;
    }
    seen.add(decision.id);
    rows.push({ decision, disposition });
  }

  return rows;
};
