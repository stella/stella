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
import { Temporal } from "@stll/time";

import { optionalArray } from "@/lib/arrays";
import {
  hasErrors,
  newExtractPosition,
  newGradedPosition,
  normalizePosition,
  type PlaybookApprovalStatus,
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

const positionFingerprint = (position: Position): string =>
  stableStringify(normalizePosition(position));

/**
 * A card added with "Add position" and not typed in. It is not part of the
 * playbook yet: leaving it out of the payload, the dirty check and the
 * validity check (all through `savedPositions`) lets the rest of the form
 * save while the card waits to be filled in.
 */
const isUntouchedBlankPosition = (position: Position): boolean => {
  const blank =
    position.mode === "graded" ? newGradedPosition() : newExtractPosition();
  return (
    positionFingerprint(position) ===
    positionFingerprint({ ...blank, sourceId: position.sourceId })
  );
};

/** The positions a save would persist. */
export const savedPositions = (positions: readonly Position[]): Position[] =>
  positions.filter((position) => !isUntouchedBlankPosition(position));

/** Ids of the saved positions that fail validation, in list order. */
export const invalidPositionIds = (positions: readonly Position[]): string[] =>
  savedPositions(positions)
    .filter((position) => hasErrors(validatePosition(position)))
    .map((position) => position.sourceId);

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
    items: savedPositions(positions).map(normalizePosition),
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
const playbookDraftFingerprint = (draft: PlaybookDraft): string =>
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

// ── Following the server ──────────────────────────────

/**
 * The playbook as the server last returned it, or the blank state of a new
 * one. The form takes its values from it at mount and again whenever a newer
 * one arrives while the form is clean.
 */
export type PlaybookSnapshot = {
  draft: PlaybookDraft;
  /** Concurrency token of this content; null for a playbook not yet saved. */
  updatedAt: string | null;
  status: PlaybookApprovalStatus;
  approvedAt: string | null;
};

const isNewerToken = (candidate: string | null, current: string | null) =>
  candidate !== null &&
  current !== null &&
  Temporal.Instant.compare(
    Temporal.Instant.from(candidate),
    Temporal.Instant.from(current),
  ) > 0;

/**
 * - `current`: the form already holds this version or a newer one.
 * - `reseed`: the server has a newer version and the form has no edits, so
 *   the form takes the server's content and token together.
 * - `behind`: the server has a newer version, but the form has edits; its
 *   next save meets the version conflict.
 */
export type ServerFollow =
  | { type: "current" }
  | { type: "reseed" }
  | { type: "behind" };

type ResolveServerFollowArgs = {
  /** The token the form's draft was read or saved with. */
  formUpdatedAt: string | null;
  serverUpdatedAt: string | null;
  isDirty: boolean;
};

/**
 * A token always stays with the draft it was read with: the form moves to a
 * newer token only by taking that version's content too, and never moves to
 * an older one, so a refetch that started before the form's own save cannot
 * roll it back.
 */
export const resolveServerFollow = ({
  formUpdatedAt,
  serverUpdatedAt,
  isDirty,
}: ResolveServerFollowArgs): ServerFollow => {
  if (!isNewerToken(serverUpdatedAt, formUpdatedAt)) {
    return { type: "current" };
  }
  return isDirty ? { type: "behind" } : { type: "reseed" };
};

type InsertLocalOnlyArgs = {
  serverOrder: readonly string[];
  localOrder: readonly string[];
  localOnly: ReadonlySet<string>;
};

/** Places each local-only id right after the id it follows in `localOrder`. */
const insertLocalOnly = ({
  serverOrder,
  localOrder,
  localOnly,
}: InsertLocalOnlyArgs): string[] => {
  const order = [...serverOrder];
  let previous: string | null = null;
  for (const id of localOrder) {
    if (localOnly.has(id)) {
      const at = previous === null ? 0 : order.indexOf(previous) + 1;
      order.splice(at, 0, id);
    }
    if (order.includes(id)) {
      previous = id;
    }
  }
  return order;
};

type RebasePlaybookDraftArgs = {
  /** The server version the form's edits started from. */
  baseline: PlaybookDraft;
  /** The form's draft, with the user's edits since `baseline`. */
  local: PlaybookDraft;
  /** The newer server version. */
  server: PlaybookDraft;
};

/** Ids of `ids` in order, keeping only those `keep` contains. */
const orderedWithin = (
  ids: readonly string[],
  keep: { has: (id: string) => boolean },
) => ids.filter((id) => keep.has(id));

const isSameSequence = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Replays the user's edits on top of a newer server version, so neither the
 * edits nor the other writer's save is lost. The caller makes `server` the new
 * baseline; the result is dirty exactly when it differs from `server`.
 *
 * - A position the user added or changed since `baseline` replaces or joins
 *   the server's, even when the server removed it: the user wins a conflict
 *   on the same position. A position the user removed is dropped.
 * - If the user reordered positions, their order wins and positions only the
 *   server has go at the end. Otherwise the server's order wins and each
 *   position only the user has goes after the one it followed locally.
 * - `name`, `description` and `documentTypeKey` keep the user's value where
 *   it differs from `baseline`. `perspective` and `trigger` are not editable
 *   in the form and follow the server.
 */
export const rebasePlaybookDraft = ({
  baseline,
  local,
  server,
}: RebasePlaybookDraftArgs): PlaybookDraft => {
  const baseById = new Map(
    baseline.positions.map((position) => [position.sourceId, position]),
  );
  const localIds = new Set(local.positions.map(({ sourceId }) => sourceId));
  const serverIds = new Set(server.positions.map(({ sourceId }) => sourceId));
  const userEdited = new Map<string, Position>();
  for (const position of local.positions) {
    const base = baseById.get(position.sourceId);
    if (
      base === undefined ||
      positionFingerprint(base) !== positionFingerprint(position)
    ) {
      userEdited.set(position.sourceId, position);
    }
  }
  const userRemoved = (id: string) => baseById.has(id) && !localIds.has(id);

  const byId = new Map<string, Position>();
  for (const position of server.positions) {
    if (!userRemoved(position.sourceId)) {
      byId.set(
        position.sourceId,
        userEdited.get(position.sourceId) ?? position,
      );
    }
  }
  for (const [id, position] of userEdited) {
    byId.set(id, position);
  }

  const localOrder = local.positions.map(({ sourceId }) => sourceId);
  const serverOrder = server.positions.map(({ sourceId }) => sourceId);
  const userReordered = !isSameSequence(
    orderedWithin(localOrder, baseById),
    orderedWithin(
      baseline.positions.map(({ sourceId }) => sourceId),
      localIds,
    ),
  );
  const resultIds = new Set(byId.keys());
  const order = userReordered
    ? [
        ...orderedWithin(localOrder, resultIds),
        ...orderedWithin(serverOrder, resultIds).filter(
          (id) => !localIds.has(id),
        ),
      ]
    : insertLocalOnly({
        serverOrder: orderedWithin(serverOrder, resultIds),
        localOrder,
        localOnly: new Set(
          orderedWithin(localOrder, resultIds).filter(
            (id) => !serverIds.has(id),
          ),
        ),
      });

  const pick = <T>(base: T, mine: T, theirs: T): T =>
    mine === base ? theirs : mine;
  return {
    name: pick(baseline.name, local.name, server.name),
    description: pick(
      baseline.description,
      local.description,
      server.description,
    ),
    documentTypeKey: pick(
      baseline.documentTypeKey,
      local.documentTypeKey,
      server.documentTypeKey,
    ),
    perspective: server.perspective,
    trigger: server.trigger,
    positions: order.map(
      (id) => byId.get(id) ?? panic(`Rebased position ${id} has no content`),
    ),
  };
};

type DraftToAdoptArgs = {
  follow: ServerFollow;
  /** What a form with edits does with a newer version: keep its edits and
   *  meet the conflict on its next save, or rebase them onto the version. */
  whenBehind: "keep" | "rebase";
  baseline: PlaybookDraft;
  local: PlaybookDraft;
  server: PlaybookDraft;
};

/** The draft the form takes along with the server's newer token, if any. */
export const draftToAdopt = ({
  follow,
  whenBehind,
  baseline,
  local,
  server,
}: DraftToAdoptArgs): PlaybookDraft | null => {
  switch (follow.type) {
    case "current":
      return null;
    case "reseed":
      return server;
    case "behind":
      return whenBehind === "rebase"
        ? rebasePlaybookDraft({ baseline, local, server })
        : null;
    default:
      follow satisfies never;
      return panic(`Unhandled server follow: ${String(follow)}`);
  }
};

type AutosavesArgs = {
  host: "page" | "pane";
  /** False for a playbook not yet created. */
  exists: boolean;
  status: PlaybookApprovalStatus;
  canUpdate: boolean;
};

/**
 * Only the pane autosaves, and only a draft the user may update. Every save
 * returns a playbook to draft, and approval is a step a person took on
 * purpose, so an approved playbook keeps explicit Save.
 */
export const canAutosave = ({
  host,
  exists,
  status,
  canUpdate,
}: AutosavesArgs): boolean =>
  host === "pane" && exists && status === "draft" && canUpdate;

/**
 * What the pane's save status says. A dirty form that is not being saved
 * never reads as saved.
 */
export type PaneSaveStatus =
  | { type: "saved" }
  | { type: "saving" }
  | { type: "failed" }
  | { type: "needs-attention"; nameMissing: boolean; invalidPositions: number };

type ResolvePaneSaveStatusArgs = {
  isDirty: boolean;
  /** The state of the latest save request. */
  request: "idle" | "in-flight" | "failed";
  nameMissing: boolean;
  invalidPositions: number;
};

export const resolvePaneSaveStatus = ({
  isDirty,
  request,
  nameMissing,
  invalidPositions,
}: ResolvePaneSaveStatusArgs): PaneSaveStatus => {
  if (request === "in-flight") {
    return { type: "saving" };
  }
  if (!isDirty) {
    return { type: "saved" };
  }
  if (nameMissing || invalidPositions > 0) {
    return { type: "needs-attention", nameMissing, invalidPositions };
  }
  // Dirty and valid: autosave is due, or the last attempt failed.
  return request === "failed" ? { type: "failed" } : { type: "saving" };
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
