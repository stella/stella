import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";

import { ANALYSIS_REQUEST_MODE } from "@stll/api-contract/case-law-analysis";
import type { AnalysisRequestMode } from "@stll/api-contract/case-law-analysis";
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
import type { APIError } from "@/lib/errors/api";
import { toAPIError } from "@/lib/errors/api";
import type { ClientOperationError } from "@/lib/errors/client";
import { parseProviderDiagnostic } from "@/lib/errors/provider-diagnostic";
import { readQueryResult } from "@/lib/errors/query-result";

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

/**
 * The analysis endpoint's answer, or null for one the reader cannot use. A
 * failure that carries a malformed provider diagnostic is an error of its
 * own: the guidance is validated, never shown as it came.
 */
export const parseAnalysisResponse = (
  value: unknown,
): Result<AnalysisResponse | null, ClientOperationError> => {
  if (!isRecord(value)) {
    return Result.ok(null);
  }

  const status = value["status"];

  if (status === "done") {
    const analysis = completeAnalysis(
      parsePersistedDecisionAnalysis(value["analysis"]),
    );
    return Result.ok(analysis === null ? null : { status: "done", analysis });
  }

  if (status === "generating") {
    // The run holds only a sentinel on the row; the tree arrives whole.
    return Result.ok({ status: "generating", tree: [] });
  }

  if (status === "error") {
    const diagnostic = value["providerDiagnostic"];
    if (diagnostic === undefined) {
      return Result.ok({ status: "error" });
    }
    return parseProviderDiagnostic(diagnostic).map(
      (providerDiagnostic): AnalysisResponse => ({
        status: "error",
        providerDiagnostic,
      }),
    );
  }

  return Result.ok(null);
};

const isTerminal = (result: AnalysisQueryResult | undefined): boolean =>
  result?.kind === "done" || result?.kind === "error";

type AnalysisPollState = {
  state: { data: AnalysisQueryResult | undefined; error: unknown };
};

/** Poll while a run is in flight; a settled run or a failed read stops it. */
export const analysisRefetchInterval = ({
  state,
}: AnalysisPollState): number | false =>
  state.error !== null || isTerminal(state.data) ? false : POLL_INTERVAL_MS;

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

/** Whether two requests are for the same organization, decision and version. */
export const isSameAnalysisRequest = (
  left: DecisionAnalysisRequestKey | undefined,
  right: DecisionAnalysisRequestKey,
): boolean =>
  left !== undefined &&
  left.organizationId === right.organizationId &&
  left.decisionId === right.decisionId &&
  left.decisionUpdatedAt === right.decisionUpdatedAt;

type DecisionAnalysisRequestOptions = {
  decisionId: DecisionAnalysisKey["decisionId"];
  mode: AnalysisRequestMode;
  signal: AbortSignal;
};

const analysisQueryResult = (
  parsed: AnalysisResponse | null,
): AnalysisQueryResult => {
  if (parsed === null) {
    return { kind: "error" };
  }
  switch (parsed.status) {
    case "done":
      return { kind: "done", analysis: parsed.analysis };
    case "generating":
      return { kind: "generating", tree: parsed.tree };
    case "error":
      return {
        kind: "error",
        ...(parsed.providerDiagnostic === undefined
          ? {}
          : { providerDiagnostic: parsed.providerDiagnostic }),
      };
    default:
      parsed satisfies never;
      return panic("Unhandled analysis response");
  }
};

/** Both background polling and an explicit retry use the same transport/parser. */
export const requestDecisionAnalysis = async ({
  decisionId,
  mode,
  signal,
}: DecisionAnalysisRequestOptions): Promise<
  Result<AnalysisQueryResult, APIError | ClientOperationError>
> => {
  const url = new URL(apiUrl(`/case/decisions/${decisionId}/analysis`));
  url.searchParams.set("mode", mode);
  const response = await fetchWithTimeout(url, {
    credentials: "include",
    signal,
    // The answer is small; a stalled response fails without capping a slow
    // but progressing one.
    timeout: { type: "idle", ms: 15_000 },
  });

  const data: unknown = await response.json();
  if (!response.ok) {
    return Result.err(toAPIError({ status: response.status, value: data }));
  }
  return parseAnalysisResponse(data).map(analysisQueryResult);
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
    queryFn: async ({ signal }) =>
      readQueryResult(
        await requestDecisionAnalysis({
          decisionId,
          mode: ANALYSIS_REQUEST_MODE.poll,
          signal,
        }),
      ),
    refetchInterval: analysisRefetchInterval,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A finished analysis changes only when regenerated, so it is never asked
    // again; an in-flight run is read on the next poll. A failed run
    // starts again only through the explicit retry request.
    staleTime: ({ state }) =>
      state.data?.kind === "done" ? STALE_TIME.INFINITE : 0,
    // Held past the reader leaving the decision, so coming back to it draws
    // the analysis without asking again.
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
  });

type WriteDecisionAnalysisOptions = {
  queryClient: QueryClient;
  /** The identity the answered request was made for, never the current render's. */
  requestKey: DecisionAnalysisRequestKey;
  result: AnalysisQueryResult;
};

/** The one cache write for an analysis answer, filed under its request's own key. */
export const writeDecisionAnalysis = ({
  queryClient,
  requestKey,
  result,
}: WriteDecisionAnalysisOptions): void => {
  queryClient.setQueryData(
    decisionAnalysisOptions(requestKey).queryKey,
    () => result,
  );
};
