import { panic } from "better-result";

import { Temporal } from "@stll/time";

import {
  createPlaybookBaseline,
  type PlaybookBaseline,
  type PlaybookDraft,
  positionFingerprint,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import type {
  PlaybookApprovalStatus,
  Position,
} from "@/lib/knowledge/playbook-types";

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

/** False when either token is missing: there is nothing to compare. */
const isNewerToken = (
  candidate: string | null,
  current: string | null,
): boolean =>
  candidate !== null &&
  current !== null &&
  Temporal.Instant.compare(
    Temporal.Instant.from(candidate),
    Temporal.Instant.from(current),
  ) > 0;

type SavedPlaybookStateArgs = {
  current: { updatedAt: string | null; baseline: PlaybookBaseline };
  savedAt: string | null;
  savedDraft: PlaybookDraft;
};

export const resolveSavedPlaybookState = ({
  current,
  savedAt,
  savedDraft,
}: SavedPlaybookStateArgs) =>
  current.updatedAt === null || isNewerToken(savedAt, current.updatedAt)
    ? { updatedAt: savedAt, baseline: createPlaybookBaseline(savedDraft) }
    : current;

/**
 * - `current`: the form already holds this version or a newer one.
 * - `reseed`: the server has a newer version and the form has no edits, so
 *   the form takes the server's content and token together.
 * - `behind`: the server has a newer version, but the form has edits.
 */
type ServerFollow = "current" | "reseed" | "behind";

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
    return "current";
  }
  return isDirty ? "behind" : "reseed";
};

type LocalPlaybookIntentArgs = {
  unacknowledgedDrafts: readonly PlaybookDraft[];
  pendingSaveCount: number;
  changedFromBaseline: boolean;
  serverUpdatedAt: string | null;
  updatedAt: string | null;
  readCount: number;
  failedReadCount: number;
};

export const resolveLocalPlaybookIntent = ({
  unacknowledgedDrafts,
  pendingSaveCount,
  changedFromBaseline,
  serverUpdatedAt,
  updatedAt,
  readCount,
  failedReadCount,
}: LocalPlaybookIntentArgs) => ({
  isDirty: changedFromBaseline || unacknowledgedDrafts.length > 0,
  verifiedUnchanged:
    unacknowledgedDrafts.length > 0 &&
    pendingSaveCount === 0 &&
    serverUpdatedAt === updatedAt &&
    readCount > failedReadCount,
});

// ── Rebasing edits onto a newer version ───────────────

/** Ids of `ids` in order, keeping only those `keep` contains. */
const orderedWithin = (
  ids: readonly string[],
  keep: { has: (id: string) => boolean },
) => ids.filter((id) => keep.has(id));

const isSameSequence = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

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
  pendingSaveCount?: number | undefined;
  follow: ServerFollow;
  /** What a form with edits does with a newer version: keep its edits and
   *  meet the conflict on its next save, or rebase them onto the version. */
  whenBehind: "keep" | "rebase";
  baseline: PlaybookDraft;
  local: PlaybookDraft;
  server: PlaybookDraft;
  unacknowledgedDrafts?: readonly PlaybookDraft[] | undefined;
};

/** The draft the form takes along with the server's newer token, if any. */
export const draftToAdopt = ({
  pendingSaveCount = 0,
  follow,
  whenBehind,
  baseline,
  local,
  server,
  unacknowledgedDrafts = [],
}: DraftToAdoptArgs): PlaybookDraft | null => {
  if (pendingSaveCount > 0) {
    return null;
  }
  switch (follow) {
    case "current":
      return null;
    case "reseed":
      return server;
    case "behind": {
      if (whenBehind === "keep") {
        return null;
      }
      let rebased = rebasePlaybookDraft({ baseline, local, server });
      // A failed response does not prove that its submitted draft was not committed.
      // Replaying each submitted baseline preserves edits that reverted that write.
      for (const submitted of unacknowledgedDrafts) {
        rebased = rebasePlaybookDraft({
          baseline: submitted,
          local,
          server: rebased,
        });
      }
      return rebased;
    }
    default:
      follow satisfies never;
      return panic(`Unhandled server follow: ${String(follow)}`);
  }
};

// ── Autosave ──────────────────────────────────────────

type CanAutosaveArgs = {
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
}: CanAutosaveArgs): boolean =>
  host === "pane" && exists && status === "draft" && canUpdate;

/** What the pane shows in place of the Save button. */
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

/** A dirty form that is not being saved never reads as saved. */
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
