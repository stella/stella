/**
 * Writing a review change's decision to the server, one row per member, and
 * taking the whole change back when the server refuses part of it.
 */

import type { revertDocxSuggestionRequest } from "@/components/ai-suggestions/docx-suggestion-persistence";
import { undoAcceptedMembers } from "@/components/ai-suggestions/review-change-apply.logic";
import type { ReviewChangeUndoEditor } from "@/components/ai-suggestions/review-change-apply.logic";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";

/** What a suggestion write reports; a revert can also meet the pending cap. */
export type DocxWriteResult = Awaited<
  ReturnType<typeof revertDocxSuggestionRequest>
>;

export type MemberResolution = {
  member: ReviewSuggestion;
  resolve: () => Promise<DocxWriteResult>;
  /** Puts the server row back to where it was before `resolve`. */
  undo: () => Promise<DocxWriteResult>;
};

export type SettledChange = {
  results: readonly DocxWriteResult[];
  /** Results of undoing the members that had synced before the rollback. */
  undone: readonly DocxWriteResult[];
};

type SettleChangeResolutionsOptions = {
  resolutions: readonly MemberResolution[];
  /** Results that leave the change standing; any other rolls it back. */
  standing: readonly DocxWriteResult[];
  /** Restore the whole change locally. */
  rollback: () => void;
  /** Runs one server write for a member. */
  run: (
    member: ReviewSuggestion,
    write: () => Promise<DocxWriteResult>,
  ) => Promise<DocxWriteResult>;
};

/**
 * Resolve every member in parallel. A change is one decision, so a member
 * whose result is not `standing` rolls the whole change back: locally through
 * `rollback`, and on the server by undoing the members that did sync.
 */
export const settleChangeResolutions = async ({
  resolutions,
  standing,
  rollback,
  run,
}: SettleChangeResolutionsOptions): Promise<SettledChange> => {
  const settled = await Promise.all(
    resolutions.map(async (resolution) => ({
      resolution,
      result: await run(resolution.member, resolution.resolve),
    })),
  );
  const results = settled.map(({ result }) => result);
  if (results.every((result) => standing.includes(result))) {
    return { results, undone: [] };
  }
  rollback();
  const undone = await Promise.all(
    settled
      .filter(({ result }) => result === "synced")
      .map(
        async ({ resolution }) => await run(resolution.member, resolution.undo),
      ),
  );
  return { results, undone };
};

export type ReplayRow = ReviewSuggestion & {
  status: "accepted" | "rejected";
};

/**
 * The rows each apply transaction resolved. An accept batch stamps one undo
 * handle on every member; a row without one was resolved on its own.
 */
const groupByApplyTransaction = (
  rows: readonly ReplayRow[],
): readonly ReplayRow[][] => {
  const groups: ReplayRow[][] = [];
  const groupByHandle = new Map<string, ReplayRow[]>();
  for (const row of rows) {
    const handleId = row.status === "accepted" ? row.undoHandle?.id : undefined;
    const group =
      handleId === undefined ? undefined : groupByHandle.get(handleId);
    if (group !== undefined) {
      group.push(row);
      continue;
    }
    const fresh = [row];
    groups.push(fresh);
    if (handleId !== undefined) {
      groupByHandle.set(handleId, fresh);
    }
  }
  return groups;
};

type ReplayResolvedSuggestionsOptions = {
  rows: readonly ReplayRow[];
  /** Read at rollback time: the editor can remount while the writes run. */
  readEditor: () => ReviewChangeUndoEditor | null;
  resolve: (row: ReplayRow) => Promise<DocxWriteResult>;
  revert: (row: ReviewSuggestion) => Promise<DocxWriteResult>;
  readLive: (id: string) => ReviewSuggestion | undefined;
  updateSuggestion: (id: string, patch: Partial<ReviewSuggestion>) => void;
  /** Runs one server write for a row, after that row's earlier writes. */
  run: SettleChangeResolutionsOptions["run"];
};

/**
 * Write resolutions the reviewer made before their rows existed on the server.
 *
 * Settled per apply transaction, the way the review actions settle a change:
 * a failed member takes its whole accept batch back, since the batch's undo
 * handle cannot undo one member alone. A stale row was resolved elsewhere, and
 * rolling back over it would not bring the server and the editor closer, so
 * only a failed write rolls back. The live rows are read at rollback time so
 * the undo reverses what actually landed.
 */
export const replayResolvedSuggestions = async ({
  rows,
  readEditor,
  resolve,
  revert,
  readLive,
  updateSuggestion,
  run,
}: ReplayResolvedSuggestionsOptions): Promise<readonly DocxWriteResult[]> => {
  const settled = await Promise.all(
    groupByApplyTransaction(rows).map(
      async (group) =>
        await settleChangeResolutions({
          resolutions: group.map((row) => ({
            member: row,
            resolve: async () => await resolve(row),
            undo: async () => await revert(row),
          })),
          standing: ["synced", "stale"],
          run,
          rollback: () => {
            const live = group.flatMap((row) => {
              const current = readLive(row.id);
              return current === undefined ? [] : [current];
            });
            const accepted = live.filter((row) => row.status === "accepted");
            undoAcceptedMembers(readEditor(), accepted);
            for (const row of accepted) {
              updateSuggestion(row.id, {
                status: "pending",
                revisionIds: null,
                undoHandle: null,
                applyMode: null,
              });
            }
            for (const row of live) {
              if (row.status === "rejected") {
                updateSuggestion(row.id, { status: "pending" });
              }
            }
          },
        }),
    ),
  );
  return settled.flatMap(({ results, undone }) => results.concat(undone));
};
