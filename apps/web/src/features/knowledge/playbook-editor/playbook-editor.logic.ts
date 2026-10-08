import type {
  DataTag,
  FetchStatus,
  QueryClient,
  QueryKey,
  QueryState,
} from "@tanstack/react-query";
import { panic } from "better-result";

import { stableStringify } from "@stll/stable-stringify";

import { optionalArray } from "@/lib/arrays";
import {
  hasErrors,
  newExtractPosition,
  newGradedPosition,
  normalizePosition,
  type PlaybookPerspective,
  type PlaybookPositionSources,
  type PlaybookPositionsValue,
  type PlaybookTrigger,
  type Position,
  validatePosition,
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

export const positionFingerprint = (position: Position): string =>
  stableStringify(normalizePosition(position));

/**
 * A card added with "Add position" and not typed in. It is not part of the
 * playbook yet: leaving it out of the payload, the dirty check and the
 * validity check (all through `savedPositions`) lets the rest of the form
 * save while the card waits to be filled in. A position the playbook already
 * holds is never blank in this sense: emptied, it fails validation instead
 * of leaving the save unnoticed.
 */
const isUntouchedBlankPosition = (position: Position): boolean => {
  const blank =
    position.mode === "graded" ? newGradedPosition() : newExtractPosition();
  return (
    positionFingerprint(position) ===
    positionFingerprint({ ...blank, sourceId: position.sourceId })
  );
};

type SavedPositionsArgs = {
  positions: readonly Position[];
  /** Ids of the positions the playbook holds, from its baseline. */
  persistedIds: ReadonlySet<string>;
};

/** The positions a save would persist. */
const savedPositions = ({
  positions,
  persistedIds,
}: SavedPositionsArgs): Position[] =>
  positions.filter(
    (position) =>
      persistedIds.has(position.sourceId) ||
      !isUntouchedBlankPosition(position),
  );

/** Ids of the saved positions that fail validation, in list order. */
export const invalidPositionIds = (args: SavedPositionsArgs): string[] =>
  savedPositions(args)
    .filter((position) => hasErrors(validatePosition(position)))
    .map((position) => position.sourceId);

type BuildPlaybookSavePayloadArgs = {
  draft: PlaybookDraft;
  persistedIds: ReadonlySet<string>;
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
  draft: {
    name,
    description,
    documentTypeKey,
    perspective,
    trigger,
    positions,
  },
  persistedIds,
}: BuildPlaybookSavePayloadArgs) => {
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
    items: savedPositions({ positions, persistedIds }).map(normalizePosition),
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
const playbookDraftFingerprint = (args: BuildPlaybookSavePayloadArgs): string =>
  stableStringify(buildPlaybookSavePayload(args));

/**
 * The clean state a draft is compared against: the draft as last persisted
 * (or as first seeded, for a new playbook) plus its fingerprint, computed
 * once and carried together so the two can never disagree. `persistedIds`
 * names the positions the playbook holds; a blank card the baseline carries
 * (a New Playbook form's first card) is not among them.
 */
export type PlaybookBaseline = {
  draft: PlaybookDraft;
  fingerprint: string;
  persistedIds: ReadonlySet<string>;
};

const NO_PERSISTED_IDS: ReadonlySet<string> = new Set();

export const createPlaybookBaseline = (
  draft: PlaybookDraft,
): PlaybookBaseline => {
  const persistedIds = new Set(
    savedPositions({
      positions: draft.positions,
      persistedIds: NO_PERSISTED_IDS,
    }).map((position) => position.sourceId),
  );
  return {
    draft,
    fingerprint: playbookDraftFingerprint({ draft, persistedIds }),
    persistedIds,
  };
};

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
  return (
    playbookDraftFingerprint({
      draft: current,
      persistedIds: baseline.persistedIds,
    }) !== baseline.fingerprint
  );
};

// ── Seeding from the cached detail ────────────────────

type CachedDetailState = Pick<QueryState, "isInvalidated" | "dataUpdatedAt">;

/**
 * Whether the form may take its initial values from the cached detail,
 * decided when the editor mounts or reloads.
 *
 * - `open`: the cached detail is current, so use it.
 * - `awaiting`: a write (this editor's save or approve, a chat save, a
 *   restore, a rejected stale save) invalidated the cached detail, which was
 *   fetched at `supersededAt`. Wait for the refetch: the form fills in once
 *   and saves the whole playbook, so starting from the outdated copy would
 *   undo whatever that write changed.
 * - `stale`: the refetch did not complete, so the form was filled from the
 *   outdated copy anyway and keeps it until the user reloads.
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

/** Whether a newer detail has been fetched for a form showing an old copy. */
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
 * Decides what the editor shows for the detail it currently has. An outdated
 * copy is withheld only while its refetch is running. If the refetch pauses
 * (offline) or fails, the outdated copy is shown, marked as stale, instead of
 * a spinner that never ends.
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
 * Returns the `stale` gate to store once the form has been filled from an
 * outdated copy, or null if there is nothing to change. Storing it means a
 * later refetch cannot return the editor to the waiting state and unmount a
 * form the user is typing in.
 */
export const latchedSeedGate = (
  gate: DetailSeedGate,
  seed: DetailSeed,
): DetailSeedGate | null =>
  gate.type === "awaiting" && seed.type === "stale"
    ? { type: "stale", supersededAt: gate.supersededAt }
    : null;

/**
 * Marks the cached detail as outdated and refetches it. The cache is marked
 * before the request starts, so a reload during the request waits for the
 * new copy instead of using the old one. Resolves to the fresh detail, or
 * null if the refetch did not complete.
 */
export const refetchSupersededDetail = async <TData>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, TData, unknown>,
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

// One stored source. It holds ids only; the names come from the detail's
// `positionSources`, which is looked up for each reader.
type PositionSource = NonNullable<Position["sources"]>[number];

const positionSourceKey = ({ workspaceId, entityId }: PositionSource) =>
  `${workspaceId}:${entityId}`;

export const toPositionSourceLookup = (
  resolved: PlaybookPositionSources,
): PositionSourceLookup =>
  new Map(resolved.map((source) => [positionSourceKey(source), source]));

/**
 * The sources of one position that this reader can open, in stored order.
 * A source the reader cannot open is left out entirely, with no placeholder
 * or count, so the page does not reveal that it exists.
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
 * Whether any position has a source this reader can open. Sources the reader
 * cannot open do not count: showing a notice because of one would reveal
 * that it exists.
 */
export const hasResolvedPositionSources = (
  positions: readonly Position[],
  lookup: PositionSourceLookup,
): boolean =>
  positions.some(
    (position) => resolvePositionSources(position, lookup).length > 0,
  );
