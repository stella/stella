import { ClientOperationError } from "@/lib/errors";

export type DroppedFileTreeFile = {
  file: File;
  pathSegments: string[];
};

export type DroppedFileTree = {
  files: DroppedFileTreeFile[];
  directoryPaths: string[][];
};

export type DroppedDataTransferItem = {
  kind: string;
  getAsFile: () => File | null;
  webkitGetAsEntry?: () => unknown;
};

export type DroppedDataTransferSource = {
  items: DroppedDataTransferItem[];
};

type FileSystemFileEntryLike = {
  isFile: true;
  name: string;
  file: (
    successCallback: (file: File) => void,
    errorCallback?: (error: unknown) => void,
  ) => void;
};

type FileSystemDirectoryReaderLike = {
  readEntries: (
    successCallback: (entries: unknown[]) => void,
    errorCallback?: (error: unknown) => void,
  ) => void;
};

type FileSystemDirectoryEntryLike = {
  isDirectory: true;
  name: string;
  createReader: () => FileSystemDirectoryReaderLike;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isFileEntry = (entry: unknown): entry is FileSystemFileEntryLike =>
  isRecord(entry) &&
  entry["isFile"] === true &&
  typeof entry["name"] === "string" &&
  typeof entry["file"] === "function";

const isDirectoryEntry = (
  entry: unknown,
): entry is FileSystemDirectoryEntryLike =>
  isRecord(entry) &&
  entry["isDirectory"] === true &&
  typeof entry["name"] === "string" &&
  typeof entry["createReader"] === "function";

const pathWithSegment = (path: string[], segment: string): string[] => {
  if (segment.length === 0) {
    throw new ClientOperationError({
      action: "read-dropped-directory",
      message: "Dropped file tree contains an empty path segment",
    });
  }

  return [...path, segment];
};

const readFileEntry = async (entry: FileSystemFileEntryLike): Promise<File> =>
  await new Promise<File>((resolve, reject) => {
    entry.file(resolve, (error) => {
      reject(
        new ClientOperationError({
          action: "read-dropped-file",
          message: "Failed to read dropped file",
          cause: error,
        }),
      );
    });
  });

const readDirectoryEntriesBatch = async (
  reader: FileSystemDirectoryReaderLike,
): Promise<unknown[]> =>
  await new Promise<unknown[]>((resolve, reject) => {
    reader.readEntries(resolve, (error) => {
      reject(
        new ClientOperationError({
          action: "read-dropped-directory",
          message: "Failed to read dropped directory",
          cause: error,
        }),
      );
    });
  });

const readAllDirectoryEntries = async (
  entry: FileSystemDirectoryEntryLike,
): Promise<unknown[]> => {
  const reader = entry.createReader();
  const entries: unknown[] = [];

  while (true) {
    const batch = await readDirectoryEntriesBatch(reader);
    if (batch.length === 0) {
      return entries;
    }
    entries.push(...batch);
  }
};

type CollectDirectoryOptions = {
  entry: FileSystemDirectoryEntryLike;
  path: string[];
  tree: DroppedFileTree;
};

const collectDirectory = async ({
  entry,
  path,
  tree,
}: CollectDirectoryOptions): Promise<void> => {
  tree.directoryPaths.push(path);

  const entries = await readAllDirectoryEntries(entry);
  for (const child of entries) {
    if (isDirectoryEntry(child)) {
      await collectDirectory({
        entry: child,
        path: pathWithSegment(path, child.name),
        tree,
      });
      continue;
    }

    if (!isFileEntry(child)) {
      continue;
    }

    const file = await readFileEntry(child);
    tree.files.push({
      file,
      pathSegments: pathWithSegment(path, file.name || child.name),
    });
  }
};

export const collectDroppedFileTree = async ({
  items,
}: DroppedDataTransferSource): Promise<DroppedFileTree> => {
  const tree: DroppedFileTree = {
    files: [],
    directoryPaths: [],
  };

  for (const item of items) {
    if (item.kind !== "file") {
      continue;
    }

    const entry = item.webkitGetAsEntry?.();
    if (isDirectoryEntry(entry)) {
      await collectDirectory({
        entry,
        path: pathWithSegment([], entry.name),
        tree,
      });
      continue;
    }

    if (isFileEntry(entry)) {
      const file = await readFileEntry(entry);
      tree.files.push({
        file,
        pathSegments: [file.name || entry.name],
      });
      continue;
    }

    const file = item.getAsFile();
    if (file) {
      tree.files.push({ file, pathSegments: [file.name] });
    }
  }

  return tree;
};
