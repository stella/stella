import type { api } from "@/lib/api";

// All playbook position types are inferred from the Eden API surface so the
// editor's working state and save payload stay in lockstep with the backend
// `playbookPositionsSchema`. Never hand-redefine the Position shape here.

type PlaybookDetailResponse = Awaited<
  ReturnType<ReturnType<typeof api.playbooks>["get"]>
>;

type PlaybookDetailData = Exclude<
  NonNullable<Extract<PlaybookDetailResponse, { data: unknown }>["data"]>,
  Response
>;

export type PlaybookPositionsValue = PlaybookDetailData["positions"];
export type Position = PlaybookPositionsValue["items"][number];
export type PositionStandard = Position["standard"];
export type PositionRule = Position["rule"];
export type PositionAskContent = Position["ask"]["content"];
export type PositionSeverity = Position["severity"];

export type PlaybookListResponse = Awaited<
  ReturnType<typeof api.playbooks.get>
>;

type PlaybookListData = Exclude<
  NonNullable<Extract<PlaybookListResponse, { data: unknown }>["data"]>,
  Response
>;

export type PlaybookListItem = PlaybookListData["items"][number];

type InlineFallback = NonNullable<
  Extract<PositionStandard, { source: "inline" }>["fallbacks"]
>[number];

// Re-rank a fallback to its new index, preserving the optional `label`. A named
// helper (not an inline `.map` arrow) so the spread does not trip oxc/no-map-spread,
// and spreading keeps `label` optional under exactOptionalPropertyTypes.
export const withFallbackRank = (
  fallback: InlineFallback,
  index: number,
): InlineFallback => ({ ...fallback, rank: index });
