import type { WebApiRoutes } from "@/lib/api";

type ListRoutes = WebApiRoutes["lists"][":workspaceId"][":listId"];

export type GenerationCandidatePage =
  ListRoutes["generations"][":runId"]["candidates"]["get"]["response"][200];
export type GenerationCandidate = GenerationCandidatePage["items"][number];
export type GenerationCandidateSource = GenerationCandidate["sources"][number];

/** A candidate still waiting for a person: undecided, or being accepted. */
export const isReviewableCandidate = (
  candidate: Pick<GenerationCandidate, "status">,
): boolean =>
  candidate.status === "pending" || candidate.status === "accepting";

export const reviewableCandidates = <
  T extends Pick<GenerationCandidate, "status">,
>(
  candidates: readonly T[],
): T[] => candidates.filter(isReviewableCandidate);

/** The candidates "Accept all" sends, in proposal order: only undecided ones. */
export const acceptAllTargets = (
  candidates: readonly Pick<GenerationCandidate, "id" | "status">[],
): string[] =>
  candidates
    .filter((candidate) => candidate.status === "pending")
    .map((candidate) => candidate.id);
