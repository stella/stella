import { Result } from "better-result";
import type { UnhandledException } from "better-result";

/** A destination that exists on the server and can be written to directly. */
export type ResolvedMatterTarget = {
  workspaceId: string;
  parentId: string | null;
};

/**
 * The matter picker's value. A `pending` folder is staged in the UI only:
 * nothing is created until {@link resolveMatterTarget} runs, so cancelling the
 * dialog leaves no orphan behind. `pending.parentId` is always an existing
 * folder (or the matter root), which makes nesting a pending folder
 * unrepresentable.
 */
export type MatterTarget =
  | ({ type: "existing" } & ResolvedMatterTarget)
  | {
      type: "pending";
      workspaceId: string;
      name: string;
      parentId: string | null;
    };

/** Matches the server's entity-name bound (`handlers/entities/create.ts`). */
export const MAX_FOLDER_NAME_LENGTH = 255;

/**
 * Stage a folder under whatever the picker has selected. Returns `null` for a
 * name that is empty once trimmed, matching the server's validation.
 */
export const stageMatterFolder = (
  target: MatterTarget,
  name: string,
): MatterTarget | null => {
  const trimmed = name.trim();
  if (trimmed === "") {
    return null;
  }
  return {
    type: "pending",
    workspaceId: target.workspaceId,
    name: trimmed,
    // The current selection, so a pending folder never nests in another.
    parentId: target.parentId,
  };
};

/** The shape of a folder row the path walk needs; `WorkspaceFolder` satisfies it. */
type FolderLink = {
  entityId: string;
  parentId: string | null;
};

/**
 * A folder and every folder above it, root-first. Expanding this whole path is
 * what keeps the new-folder row visible: expanding only the immediate parent
 * still leaves it inside a collapsed grandparent. `null` (the matter root) has
 * no path. An id the tree does not contain is left out and ends the walk, and a
 * cycle in a malformed tree terminates instead of hanging.
 */
export const matterFolderPath = (
  folders: readonly FolderLink[],
  folderId: string | null,
): string[] => {
  const byId = new Map(folders.map((folder) => [folder.entityId, folder]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current = folderId;
  while (current !== null && !seen.has(current)) {
    const folder = byId.get(current);
    if (folder === undefined) {
      break;
    }
    seen.add(current);
    path.push(current);
    current = folder.parentId;
  }
  return path.toReversed();
};

type CreateFolder = (folder: {
  workspaceId: string;
  parentId: string | null;
  name: string;
}) => Promise<{ entityId: string }>;

/**
 * Turn a {@link MatterTarget} into a {@link ResolvedMatterTarget}, creating the
 * staged folder if there is one. An `existing` target never touches the network.
 */
export const resolveMatterTarget = async (
  target: MatterTarget,
  createFolder: CreateFolder,
): Promise<Result<ResolvedMatterTarget, UnhandledException>> => {
  if (target.type === "existing") {
    return Result.ok({
      workspaceId: target.workspaceId,
      parentId: target.parentId,
    });
  }
  const created = await Result.tryPromise(
    async () =>
      await createFolder({
        workspaceId: target.workspaceId,
        parentId: target.parentId,
        name: target.name,
      }),
  );
  if (Result.isError(created)) {
    return Result.err(created.error);
  }
  return Result.ok({
    workspaceId: target.workspaceId,
    parentId: created.value.entityId,
  });
};
