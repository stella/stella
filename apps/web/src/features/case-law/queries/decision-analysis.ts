import { queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import {
  CASE_LAW_ANALYSIS_UNAVAILABLE_CODES,
  type CaseLawAnalysisUnavailableCode,
} from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";
import {
  ANALYSIS_FAILURE_CODES,
  type AnalysisFailureCode,
  type DecisionAnalysis,
  type PersistedDecisionAnalysis,
  parsePersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { apiUrl } from "@/lib/api-url";
import { STALE_TIME } from "@/lib/consts";

/** Whose AI key the failed run called the provider with. */
export type AnalysisFailureKey =
  | { source: "organization"; provider: string }
  | { source: "platform" };

/**
 * Why the reader has no analysis: the server will not make one, the last run
 * failed (and how, with whose key), or the answer itself could not be read.
 */
export type AnalysisError =
  | { kind: "unavailable"; code: CaseLawAnalysisUnavailableCode }
  | { kind: "failed"; code: AnalysisFailureCode; key: AnalysisFailureKey }
  | { kind: "unreadable" };

type AnalysisResponse =
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "generating"; tree: DecisionAnalysis["tree"] }
  | { status: "error"; error: AnalysisError };

export type AnalysisQueryResult =
  | { kind: "done"; analysis: DecisionAnalysis }
  | { kind: "generating"; tree: DecisionAnalysis["tree"] }
  | { kind: "error"; error: AnalysisError };

const POLL_INTERVAL_MS = 2000;

const UNREADABLE: AnalysisError = { kind: "unreadable" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isMember = <T extends string>(
  members: readonly T[],
  value: unknown,
): value is T => members.some((member) => member === value);

const completeAnalysis = (
  analysis: PersistedDecisionAnalysis | null,
): DecisionAnalysis | null =>
  analysis !== null && !("status" in analysis) ? analysis : null;

const parseFailureKey = (value: unknown): AnalysisFailureKey | null => {
  if (!isRecord(value)) {
    return null;
  }
  const source = value["source"];
  if (source === "platform") {
    return { source: "platform" };
  }
  const provider = value["provider"];
  return source === "organization" &&
    typeof provider === "string" &&
    provider.length > 0
    ? { source: "organization", provider }
    : null;
};

/**
 * The error a response names, read deliberately: an unknown code or a failure
 * without its key is unreadable, never a guess at one of the known messages.
 */
const parseAnalysisError = (value: Record<string, unknown>): AnalysisError => {
  const code = value["code"];
  if (isMember(CASE_LAW_ANALYSIS_UNAVAILABLE_CODES, code)) {
    return { kind: "unavailable", code };
  }
  if (isMember(ANALYSIS_FAILURE_CODES, code)) {
    const key = parseFailureKey(value["key"]);
    return key === null ? UNREADABLE : { kind: "failed", code, key };
  }
  return UNREADABLE;
};

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
    return { status: "error", error: parseAnalysisError(value) };
  }

  return null;
};

/** A settled result is final until the reader asks again; polling stops. */
export const isTerminalAnalysisResult = (
  result: AnalysisQueryResult | undefined,
): boolean => result?.kind === "done" || result?.kind === "error";

const queryResultOf = (
  parsed: AnalysisResponse | null,
): AnalysisQueryResult => {
  if (parsed === null) {
    return { kind: "error", error: UNREADABLE };
  }
  switch (parsed.status) {
    case "done":
      return { kind: "done", analysis: parsed.analysis };
    case "generating":
      return { kind: "generating", tree: parsed.tree };
    case "error":
      return { kind: "error", error: parsed.error };
    default:
      parsed satisfies never;
      return panic("Unhandled analysis response");
  }
};

const readAnalysis = async ({
  decisionId,
  retry,
  signal,
}: {
  decisionId: string;
  retry: boolean;
  signal?: AbortSignal | undefined;
}): Promise<AnalysisQueryResult> => {
  const path = `/case/decisions/${decisionId}/analysis`;
  const response = await fetchWithTimeout(
    apiUrl(retry ? `${path}?retry=true` : path),
    {
      credentials: "include",
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 15_000,
    },
  );
  const data: unknown = await response.json();
  return queryResultOf(parseAnalysisResponse(data));
};

/**
 * Asks for a new run after a failed one. A plain read keeps answering the
 * failure, so polling never restarts the run that just failed; this is the
 * reader's explicit request to try again. Its answer (normally `generating`)
 * replaces the cached failure, which resumes polling.
 */
export const retryDecisionAnalysis = async (
  decisionId: string,
): Promise<AnalysisQueryResult> =>
  await readAnalysis({ decisionId, retry: true });

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

export const decisionAnalysisOptions = ({
  decisionId,
  decisionUpdatedAt,
}: DecisionAnalysisKey) =>
  queryOptions({
    queryKey: ["case-law-decision-analysis", decisionId, { decisionUpdatedAt }],
    queryFn: async ({ signal }): Promise<AnalysisQueryResult> =>
      await readAnalysis({ decisionId, retry: false, signal }),
    refetchInterval: ({ state }) =>
      isTerminalAnalysisResult(state.data) ? false : POLL_INTERVAL_MS,
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
