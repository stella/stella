import { queryOptions } from "@tanstack/react-query";

import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import { fetchWithTimeout } from "@stll/fetch";
import {
  type DecisionAnalysis,
  type PersistedDecisionAnalysis,
  parsePersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { apiUrl } from "@/lib/api-url";
import { STALE_TIME } from "@/lib/consts";
import { toAPIError } from "@/lib/errors/api";
import { parseProviderDiagnostic } from "@/lib/errors/provider-diagnostic";

type AnalysisResponse =
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "generating"; tree: DecisionAnalysis["tree"] }
  | { status: "error"; providerDiagnostic?: ProviderDiagnostic };

export type AnalysisQueryResult =
  | { kind: "done"; analysis: DecisionAnalysis }
  | { kind: "generating"; tree: DecisionAnalysis["tree"] }
  | { kind: "error"; providerDiagnostic?: ProviderDiagnostic };

const POLL_INTERVAL_MS = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const completeAnalysis = (
  analysis: PersistedDecisionAnalysis | null,
): DecisionAnalysis | null =>
  analysis !== null && !("status" in analysis) ? analysis : null;

export const parseAnalysisResponse = (
  value: unknown,
): AnalysisResponse | null => {
  if (!isRecord(value)) {
    return null;
  }

  const status = value["status"];

  if (status === "done") {
    const analysis = completeAnalysis(
      parsePersistedDecisionAnalysis(value["analysis"]),
    );
    return analysis === null ? null : { status: "done", analysis };
  }

  if (status === "generating") {
    // The run holds only a sentinel on the row; the tree arrives whole.
    return { status: "generating", tree: [] };
  }

  if (status === "error") {
    const diagnostic = value["providerDiagnostic"];
    return {
      status: "error",
      ...(diagnostic === undefined
        ? {}
        : { providerDiagnostic: parseProviderDiagnostic(diagnostic) }),
    };
  }

  return null;
};

const isTerminal = (result: AnalysisQueryResult | undefined): boolean =>
  result?.kind === "done" || result?.kind === "error";

/**
 * The AI analysis of one decision: the only place the reader holds it, as the
 * public decision read never carries it. The read is authenticated and asking
 * it starts a run when none is stored, so a caller enables it only once the
 * reader has taken the run up; a route loader must not prefetch it.
 *
 * Its own key root, apart from the public decision reads, so invalidating or
 * refetching those never touches a finished analysis. The key carries the
 * version of the decision the reader holds: a finished analysis is final for
 * that version only, since a re-parse renumbers the blocks its anchors name.
 * A decision read at a new version asks again; the server answers the stored
 * analysis while it still matches the document, and runs anew when not.
 */
export type DecisionAnalysisKey = {
  decisionId: string;
  /**
   * The decision's `updatedAt` as the public read answered it. Kept as given:
   * the public API supplies the ISO string used by the query key.
   */
  decisionUpdatedAt: PublicCaseLawDecision["updatedAt"];
};

export type DecisionAnalysisRequestKey = DecisionAnalysisKey & {
  organizationId: string;
};

export const decisionAnalysisOptions = ({
  decisionId,
  decisionUpdatedAt,
  organizationId,
}: DecisionAnalysisRequestKey) =>
  queryOptions({
    queryKey: [
      "case-law-decision-analysis",
      organizationId,
      decisionId,
      { decisionUpdatedAt },
    ],
    queryFn: async ({ signal }): Promise<AnalysisQueryResult> => {
      const response = await fetchWithTimeout(
        apiUrl(`/case/decisions/${decisionId}/analysis`),
        {
          credentials: "include",
          signal,
          timeoutMs: 15_000,
        },
      );

      const data: unknown = await response.json();
      if (!response.ok) {
        throw toAPIError({ status: response.status, value: data });
      }
      const parsed = parseAnalysisResponse(data);

      if (!parsed) {
        return { kind: "error" };
      }

      if (parsed.status === "done") {
        return { kind: "done", analysis: parsed.analysis };
      }
      if (parsed.status === "generating") {
        return { kind: "generating", tree: parsed.tree };
      }
      return {
        kind: "error",
        ...(parsed.providerDiagnostic === undefined
          ? {}
          : { providerDiagnostic: parsed.providerDiagnostic }),
      };
    },
    refetchInterval: ({ state }) =>
      isTerminal(state.data) ? false : POLL_INTERVAL_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A finished analysis changes only when regenerated, so it is never asked
    // again; a run in flight or a failed one is, on the next poll or retry.
    staleTime: ({ state }) =>
      state.data?.kind === "done" ? STALE_TIME.INFINITE : 0,
    // Held past the reader leaving the decision, so coming back to it draws
    // the analysis without asking again.
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
  });
