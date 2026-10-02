import type {
  DataTag,
  DefaultError,
  FetchStatus,
  QueryClient,
  QueryKey,
  QueryState,
} from "@tanstack/react-query";
import { panic } from "better-result";

import { stableStringify } from "@stll/stable-stringify";

import { optionalArray } from "@/lib/arrays";
import {
  normalizePosition,
  type PlaybookPerspective,
  type PlaybookPositionSources,
  type PlaybookPositionsValue,
  type PlaybookTrigger,
  type Position,
} from "@/lib/knowledge/playbook-types";

type ResolvePlaybookScrollTopArgs = {
  containerScrollTop: number;
  containerTop: number;
  targetTop: number;
  topOffset: number;
};

export const resolvePlaybookScrollTop = ({
  containerScrollTop,
  containerTop,
  targetTop,
  topOffset,
}: ResolvePlaybookScrollTopArgs) =>
  Math.max(0, containerScrollTop + targetTop - containerTop - topOffset);

/** Everything the editor can put into a save. */
export type PlaybookDraft = {
  name: string;
  description: string;
  documentTypeKey: string | null;
  // Not editable in the form today, but part of the saved scope, so they
  // belong to the draft: a fingerprint that ignored them would miss a change
  // the save would still persist.
  perspective: PlaybookPerspective | null;
  trigger: PlaybookTrigger | null;
  positions: readonly Position[];
};

/**
 * The exact body the editor sends to `POST /playbooks` and
 * `PUT /playbooks/:playbookId`. Building it here rather than inline in the
 * component is what lets the dirty check fingerprint the real payload: a new
 * saveable field cannot be added without also entering dirty tracking.
 *
 * "When to run" is no longer a playbook setting (it belongs to a future
 * Workflows layer), so the editor never mutates the trigger; it carries the
 * stored value through the routing seam. The scope is omitted entirely in the
 * all-defaults case so the handler clears it, and whenever a scope is sent
 * `trigger` rides along explicitly (absent optional fields must not be left
 * to server defaults).
 */
export const buildPlaybookSavePayload = ({
  name,
  description,
  documentTypeKey,
  perspective,
  trigger,
  positions,
}: PlaybookDraft) => {
  const trimmedDescription = description.trim();
  const resolvedTrigger = trigger ?? "manual";
  const scope =
    documentTypeKey === null &&
    perspective === null &&
    resolvedTrigger === "manual"
      ? undefined
      : {
          ...(documentTypeKey !== null ? { documentTypeKey } : {}),
          ...(perspective !== null ? { perspective } : {}),
          trigger: resolvedTrigger,
        };
  const positionsPayload: PlaybookPositionsValue = {
    version: 3,
    items: positions.map(normalizePosition),
  };

  return {
    name: name.trim(),
    ...(trimmedDescription ? { description: trimmedDescription } : {}),
    ...(scope ? { scope } : {}),
    positions: positionsPayload,
  };
};

/**
 * Fingerprint of what a draft would actually persist. Key-order-insensitive
 * because the payload assembles optional fields through conditional spreads,
 * so an unchanged draft must not look different just because a key moved.
 */
export const playbookDraftFingerprint = (draft: PlaybookDraft): string =>
  stableStringify(buildPlaybookSavePayload(draft));

/**
 * The clean state a draft is compared against: the draft as last persisted
 * (or as first seeded, for a new playbook) plus its fingerprint, computed
 * once and carried together so the two can never disagree.
 */
export type PlaybookBaseline = {
  draft: PlaybookDraft;
  fingerprint: string;
};

export const createPlaybookBaseline = (
  draft: PlaybookDraft,
): PlaybookBaseline => ({
  draft,
  fingerprint: playbookDraftFingerprint(draft),
});

/**
 * Field-wise reference equality. Strings compare by value and `positions` by
 * array identity, which React state preserves until an edit actually
 * replaces it — so an untouched form settles the dirty check without
 * serializing anything.
 */
const isSameDraftReference = (a: PlaybookDraft, b: PlaybookDraft): boolean =>
  a.name === b.name &&
  a.description === b.description &&
  a.documentTypeKey === b.documentTypeKey &&
  a.perspective === b.perspective &&
  a.trigger === b.trigger &&
  a.positions === b.positions;

type HasPlaybookDraftChangesArgs = {
  baseline: PlaybookBaseline;
  current: PlaybookDraft;
};

export const hasPlaybookDraftChanges = ({
  baseline,
  current,
}: HasPlaybookDraftChangesArgs): boolean => {
  if (isSameDraftReference(baseline.draft, current)) {
    return false;
  }
  return playbookDraftFingerprint(current) !== baseline.fingerprint;
};

// ── Seeding from the cached detail ────────────────────

type CachedDetailState = Pick<QueryState, "isInvalidated" | "dataUpdatedAt">;

/**
 * What the form may seed from, decided when the editor mounts or reloads.
 * `awaiting` holds back the snapshot fetched at `supersededAt`: a write (this
 * editor's save or approve, a chat save, a restore, a rejected stale save)
 * invalidated it, and the form seeds once and saves a full replace, so seeding
 * from pre-write content would put back whatever the write changed. `stale`
 * is `awaiting` after the refetch could not be had: the form was seeded from
 * that snapshot and stays on it until the user reloads.
 */
export type DetailSeedGate =
  | { type: "open" }
  | { type: "awaiting"; supersededAt: number }
  | { type: "stale"; supersededAt: number };

export const detailSeedGate = (
  state: CachedDetailState | undefined,
): DetailSeedGate =>
  state?.isInvalidated === true
    ? { type: "awaiting", supersededAt: state.dataUpdatedAt }
    : { type: "open" };

/** Whether a detail newer than a stale-seeded form's snapshot is in hand. */
export type FresherDetail = "unavailable" | "loading" | "loaded";

export type DetailSeed =
  | { type: "wait" }
  | { type: "current" }
  | { type: "stale"; fresher: FresherDetail };

type ResolveDetailSeedArgs = {
  gate: DetailSeedGate;
  dataUpdatedAt: number;
  fetchStatus: FetchStatus;
};

/**
 * What the editor shows for the detail now in hand. A superseded snapshot is
 * held back only while its refetch is in flight; once that refetch has paused
 * (offline) or failed, the snapshot is all there is, and it is shown as stale
 * rather than hidden behind a spinner.
 */
export const resolveDetailSeed = ({
  gate,
  dataUpdatedAt,
  fetchStatus,
}: ResolveDetailSeedArgs): DetailSeed => {
  switch (gate.type) {
    case "open": {
      return { type: "current" };
    }
    case "awaiting": {
      if (dataUpdatedAt !== gate.supersededAt) {
        return { type: "current" };
      }
      return fetchStatus === "fetching"
        ? { type: "wait" }
        : { type: "stale", fresher: "unavailable" };
    }
    case "stale": {
      if (dataUpdatedAt !== gate.supersededAt) {
        return { type: "stale", fresher: "loaded" };
      }
      return {
        type: "stale",
        fresher: fetchStatus === "fetching" ? "loading" : "unavailable",
      };
    }
    default: {
      gate satisfies never;
      return panic(`Unhandled seed gate: ${String(gate)}`);
    }
  }
};

/**
 * The gate once a form has been seeded from the superseded snapshot; null
 * while there is nothing to latch. Latched so a later refetch cannot put the
 * editor back into waiting and unmount a form the user is typing in.
 */
export const latchedSeedGate = (
  gate: DetailSeedGate,
  seed: DetailSeed,
): DetailSeedGate | null =>
  gate.type === "awaiting" && seed.type === "stale"
    ? { type: "stale", supersededAt: gate.supersededAt }
    : null;

/**
 * Supersede the cached detail and refetch it. The cache is marked before the
 * request starts, so a reload issued while it is in flight waits for it
 * instead of seeding from the superseded snapshot. Resolves to the fresh
 * detail, or null when the refetch did not land.
 */
export const refetchSupersededDetail = async <TData>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, TData, DefaultError>,
): Promise<TData | null> => {
  await queryClient.invalidateQueries({ queryKey, exact: true });
  const state = queryClient.getQueryState(queryKey);
  if (state === undefined || state.isInvalidated) {
    return null;
  }
  return state.data ?? null;
};

// ── Position sources ──────────────────────────────────

export type ResolvedPositionSource = PlaybookPositionSources[number];

export type PositionSourceLookup = ReadonlyMap<string, ResolvedPositionSource>;

// One stored source: ids only. Names come from the per-reader overlay.
type PositionSource = NonNullable<Position["sources"]>[number];

const positionSourceKey = ({ workspaceId, entityId }: PositionSource) =>
  `${workspaceId}:${entityId}`;

export const toPositionSourceLookup = (
  resolved: PlaybookPositionSources,
): PositionSourceLookup =>
  new Map(resolved.map((source) => [positionSourceKey(source), source]));

/**
 * The sources of one position this reader can open, in stored order. A source
 * the reader cannot resolve is left out with no placeholder and no count:
 * that a position has one is not theirs to learn from the page.
 */
export const resolvePositionSources = (
  position: Position,
  lookup: PositionSourceLookup,
): ResolvedPositionSource[] => {
  const resolved: ResolvedPositionSource[] = [];
  for (const source of optionalArray(position.sources)) {
    const match = lookup.get(positionSourceKey(source));
    if (match !== undefined) {
      resolved.push(match);
    }
  }
  return resolved;
};

/**
 * Whether any position has a source this reader can open. A source they
 * cannot resolve does not count: a notice that appeared for it would tell
 * them it exists.
 */
export const hasResolvedPositionSources = (
  positions: readonly Position[],
  lookup: PositionSourceLookup,
): boolean =>
  positions.some(
    (position) => resolvePositionSources(position, lookup).length > 0,
  );
