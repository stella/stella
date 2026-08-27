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
 * dialog leaves no orphan behind. Its creation location and the selected copy
 * destination are separate, so selecting another folder does not discard it.
 * `pending.parentId` is always an existing folder (or the matter root), which
 * makes nesting a pending folder unrepresentable.
 */
export type MatterTarget =
  | ({ type: "existing" } & ResolvedMatterTarget)
  | {
      type: "pending";
      workspaceId: string;
      name: string;
      parentId: string | null;
      selection:
        | { type: "existing"; parentId: string | null }
        | { type: "pending" };
    };

export type PendingMatterTarget = Extract<MatterTarget, { type: "pending" }>;

/** Matches the server's entity-name bound (`handlers/entities/create.ts`). */
export const MAX_FOLDER_NAME_LENGTH = 255;

const matterFolderCreationParentId = (target: MatterTarget) => {
  if (target.type === "existing") {
    return target.parentId;
  }
  if (target.selection.type === "existing") {
    return target.selection.parentId;
  }
  return target.parentId;
};

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
    // A second pending folder replaces the first beside its selected target;
    // pending folders never nest in one another.
    parentId: matterFolderCreationParentId(target),
    selection: { type: "pending" },
  };
};

/** Select an existing destination without discarding a staged folder. */
export const selectExistingMatterTarget = (
  target: MatterTarget,
  parentId: string | null,
): MatterTarget => {
  if (target.type === "existing") {
    return {
      type: "existing",
      workspaceId: target.workspaceId,
      parentId,
    };
  }
  return {
    type: "pending",
    workspaceId: target.workspaceId,
    name: target.name,
    parentId: target.parentId,
    selection: { type: "existing", parentId },
  };
};

/** Select the staged folder itself as the destination again. */
export const selectPendingMatterTarget = (
  target: PendingMatterTarget,
): PendingMatterTarget => {
  if (target.selection.type === "pending") {
    return target;
  }
  return {
    type: "pending",
    workspaceId: target.workspaceId,
    name: target.name,
    parentId: target.parentId,
    selection: { type: "pending" },
  };
};

/** Remove a staged folder while preserving the user's existing destination. */
export const discardPendingMatterFolder = (
  target: PendingMatterTarget,
): MatterTarget => ({
  type: "existing",
  workspaceId: target.workspaceId,
  parentId:
    target.selection.type === "existing"
      ? target.selection.parentId
      : target.parentId,
});

/**
 * Move a staged folder without creating it early. Keeping this as a pending
 * target means cancelling the dialog still leaves no orphan on the server.
 */
export const reparentPendingMatterFolder = (
  target: PendingMatterTarget,
  parentId: string | null,
): PendingMatterTarget => {
  if (target.parentId === parentId) {
    return target;
  }
  return {
    type: "pending",
    workspaceId: target.workspaceId,
    name: target.name,
    parentId,
    selection: target.selection,
  };
};

/** The shape of a folder row the path walk needs; `WorkspaceFolder` satisfies it. */
type FolderLink = {
  entityId: string;
  parentId: string | null;
};

type NamedFolderLink = FolderLink & {
  name: string;
};

type MatterFolderMoveSource =
  | { kind: "existing"; folderId: string; parentId: string | null }
  | { kind: "pending"; parentId: string | null };

export type MatterFolderMoveDestination = {
  parentId: string | null;
  name: string;
};

/**
 * Build the keyboard move menu only when it opens. One child graph finds an
 * existing folder's descendants, and one name index identifies destinations
 * that need an ancestor path to disambiguate them.
 */
export const matterFolderMoveDestinations = (
  folders: readonly NamedFolderLink[],
  source: MatterFolderMoveSource,
  rootName: string,
): MatterFolderMoveDestination[] => {
  const folderById = new Map(
    folders.map((folder) => [folder.entityId, folder]),
  );
  if (source.kind === "existing" && !folderById.has(source.folderId)) {
    return [];
  }

  const childrenByParentId = new Map<string, string[]>();
  const nameCounts = new Map<string, number>();
  for (const folder of folders) {
    nameCounts.set(folder.name, (nameCounts.get(folder.name) ?? 0) + 1);
    if (folder.parentId === null) {
      continue;
    }
    const childIds = childrenByParentId.get(folder.parentId);
    if (childIds === undefined) {
      childrenByParentId.set(folder.parentId, [folder.entityId]);
    } else {
      childIds.push(folder.entityId);
    }
  }

  const invalidParentIds = new Set<string | null>([source.parentId]);
  if (source.kind === "existing") {
    const remaining = [source.folderId];
    while (remaining.length > 0) {
      const folderId = remaining.pop();
      if (folderId === undefined || invalidParentIds.has(folderId)) {
        continue;
      }
      invalidParentIds.add(folderId);
      const childIds = childrenByParentId.get(folderId);
      if (childIds !== undefined) {
        remaining.push(...childIds);
      }
    }
  }

  const destinationPath = (folder: NamedFolderLink) => {
    if (nameCounts.get(folder.name) === 1) {
      return folder.name;
    }
    const names: string[] = [];
    const seen = new Set<string>();
    let current: NamedFolderLink | undefined = folder;
    while (current !== undefined && !seen.has(current.entityId)) {
      seen.add(current.entityId);
      names.push(current.name);
      current =
        current.parentId === null
          ? undefined
          : folderById.get(current.parentId);
    }
    return names.toReversed().join(" / ");
  };

  const pathByFolderId = new Map<string, string>();
  const folderIdsByPath = new Map<string, string[]>();
  for (const folder of folders) {
    const path = destinationPath(folder);
    pathByFolderId.set(folder.entityId, path);
    const folderIds = folderIdsByPath.get(path);
    if (folderIds === undefined) {
      folderIdsByPath.set(path, [folder.entityId]);
    } else {
      folderIds.push(folder.entityId);
    }
  }

  const duplicatePathIndexByFolderId = new Map<string, number>();
  for (const folderIds of folderIdsByPath.values()) {
    if (folderIds.length === 1) {
      continue;
    }
    for (const [index, folderId] of folderIds.toSorted().entries()) {
      duplicatePathIndexByFolderId.set(folderId, index + 1);
    }
  }

  const destinations: MatterFolderMoveDestination[] = [];
  if (!invalidParentIds.has(null)) {
    destinations.push({ parentId: null, name: rootName });
  }
  for (const folder of folders) {
    if (invalidParentIds.has(folder.entityId)) {
      continue;
    }
    const path = pathByFolderId.get(folder.entityId);
    if (path === undefined) {
      continue;
    }
    const duplicatePathIndex = duplicatePathIndexByFolderId.get(
      folder.entityId,
    );
    destinations.push({
      parentId: folder.entityId,
      name:
        duplicatePathIndex === undefined
          ? path
          : `${path} (${duplicatePathIndex})`,
    });
  }
  return destinations;
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

/**
 * Whether dragging a folder to a new parent would change the tree without
 * creating a cycle. The server enforces the same invariant; keeping it here
 * prevents invalid drop targets from presenting as actionable.
 */
export const canMoveMatterFolder = (
  folders: readonly FolderLink[],
  folderId: string,
  targetParentId: string | null,
): boolean => {
  const source = folders.find((folder) => folder.entityId === folderId);
  if (source === undefined || source.parentId === targetParentId) {
    return false;
  }
  if (targetParentId === null) {
    return true;
  }
  if (!folders.some((folder) => folder.entityId === targetParentId)) {
    return false;
  }
  return !matterFolderPath(folders, targetParentId).includes(folderId);
};

type CreateFolder = (folder: {
  workspaceId: string;
  parentId: string | null;
  name: string;
}) => Promise<{ entityId: string }>;

/**
 * Turn a {@link MatterTarget} into a {@link ResolvedMatterTarget}. A pending
 * folder is created even when the user subsequently selected another
 * destination; an `existing` target never touches the network.
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
    parentId:
      target.selection.type === "pending"
        ? created.value.entityId
        : target.selection.parentId,
  });
};
