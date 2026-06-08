import { ClientOperationError } from "@/lib/errors";
import type {
  DroppedFileTree,
  DroppedFileTreeFile,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/external-file-drop.logic";

const DIRECTORY_PATH_SEPARATOR = "\0";

export type DirectoryUploadStep = {
  key: string;
  name: string;
  parentKey: string | null;
};

export type FileUploadPlacement = {
  file: File;
  parentKey: string | null;
};

export type DroppedFolderUploadPlan = {
  directories: DirectoryUploadStep[];
  files: FileUploadPlacement[];
};

const directoryPathKey = (pathSegments: readonly string[]): string =>
  pathSegments.join(DIRECTORY_PATH_SEPARATOR);

const assertValidPathSegment = (segment: string): void => {
  if (segment.length > 0) {
    return;
  }

  throw new ClientOperationError({
    action: "plan-dropped-folder-upload",
    message: "Dropped file tree contains an empty path segment",
  });
};

const assertValidFilePath = ({ pathSegments }: DroppedFileTreeFile): void => {
  if (pathSegments.length > 0) {
    return;
  }

  throw new ClientOperationError({
    action: "plan-dropped-folder-upload",
    message: "Dropped file tree contains a file without a path",
  });
};

const addDirectoryPath = (
  directoriesByKey: Map<string, DirectoryUploadStep>,
  pathSegments: readonly string[],
): DirectoryUploadStep | null => {
  let latest: DirectoryUploadStep | null = null;

  for (let depth = 1; depth <= pathSegments.length; depth += 1) {
    const prefix = pathSegments.slice(0, depth);
    const name = prefix.at(-1);
    if (name === undefined) {
      return latest;
    }
    assertValidPathSegment(name);

    const key = directoryPathKey(prefix);
    const existing = directoriesByKey.get(key);
    if (existing) {
      latest = existing;
      continue;
    }

    const parentSegments = prefix.slice(0, -1);
    const directory: DirectoryUploadStep = {
      key,
      name,
      parentKey:
        parentSegments.length > 0 ? directoryPathKey(parentSegments) : null,
    };
    directoriesByKey.set(key, directory);
    latest = directory;
  }

  return latest;
};

export const buildDroppedFolderUploadPlan = (
  tree: DroppedFileTree,
): DroppedFolderUploadPlan => {
  const directoriesByKey = new Map<string, DirectoryUploadStep>();

  for (const directoryPath of tree.directoryPaths) {
    addDirectoryPath(directoriesByKey, directoryPath);
  }

  const files: FileUploadPlacement[] = [];
  for (const droppedFile of tree.files) {
    assertValidFilePath(droppedFile);
    const parentPath = droppedFile.pathSegments.slice(0, -1);
    const parent = addDirectoryPath(directoriesByKey, parentPath);
    files.push({
      file: droppedFile.file,
      parentKey: parent?.key ?? null,
    });
  }

  return {
    directories: [...directoriesByKey.values()],
    files,
  };
};
