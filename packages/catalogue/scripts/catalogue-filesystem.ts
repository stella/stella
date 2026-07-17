import { panic } from "better-result";
import { lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";

export type InspectedCatalogueEntry = {
  name: string;
  type: "directory" | "file";
};

export type InspectedCatalogueFilesystem = {
  directoryEntries: ReadonlyMap<string, readonly InspectedCatalogueEntry[]>;
  files: ReadonlyMap<string, string>;
  rootPath: string;
};

/**
 * Inspects the complete catalogue tree before consumers read any file content.
 * Git cannot represent symlinks as ordinary files, but a malicious catalogue
 * change can still add one. Rejecting links and special files here prevents the
 * validator or generator from following them into runner-local secrets.
 */
export const inspectCatalogueFilesystem = (
  entriesRoot: string,
): InspectedCatalogueFilesystem => {
  const rootPath = path.resolve(entriesRoot);
  const rootStats = lstatIfExists(rootPath);
  if (rootStats === null) {
    panic("Catalogue entries root does not exist");
  }
  if (rootStats.isSymbolicLink()) {
    panic(
      "Unsafe catalogue filesystem entry at .: symbolic links are forbidden",
    );
  }
  if (!rootStats.isDirectory()) {
    panic("Catalogue entries root must be a directory");
  }

  const rootRealPath = realpathSync(rootPath);
  const directoryEntries = new Map<
    string,
    readonly InspectedCatalogueEntry[]
  >();
  const files = new Map<string, string>();

  inspectDirectory({
    directoryEntries,
    directoryPath: rootPath,
    files,
    rootPath,
    rootRealPath,
  });

  return { directoryEntries, files, rootPath };
};

export const getInspectedDirectoryEntries = (
  filesystem: InspectedCatalogueFilesystem,
  directoryPath: string,
): readonly InspectedCatalogueEntry[] | null =>
  filesystem.directoryEntries.get(path.resolve(directoryPath)) ?? null;

export const getInspectedFilePath = (
  filesystem: InspectedCatalogueFilesystem,
  filePath: string,
): string | null => filesystem.files.get(path.resolve(filePath)) ?? null;

type InspectDirectoryOptions = {
  directoryEntries: Map<string, readonly InspectedCatalogueEntry[]>;
  directoryPath: string;
  files: Map<string, string>;
  rootPath: string;
  rootRealPath: string;
};

const inspectDirectory = ({
  directoryEntries,
  directoryPath,
  files,
  rootPath,
  rootRealPath,
}: InspectDirectoryOptions): void => {
  const entries: InspectedCatalogueEntry[] = [];
  const names = readdirSync(directoryPath).sort((a, b) => a.localeCompare(b));

  for (const name of names) {
    const entryPath = path.join(directoryPath, name);
    const displayPath = path.relative(rootPath, entryPath);
    const stats = lstatIfExists(entryPath);
    if (stats === null) {
      panic(
        `Unsafe catalogue filesystem entry at ${displayPath}: disappeared during inspection`,
      );
    }
    if (stats.isSymbolicLink()) {
      panic(
        `Unsafe catalogue filesystem entry at ${displayPath}: symbolic links are forbidden`,
      );
    }
    if (!(stats.isDirectory() || stats.isFile())) {
      panic(
        `Unsafe catalogue filesystem entry at ${displayPath}: only directories and regular files are allowed`,
      );
    }

    const realPath = realpathSync(entryPath);
    assertContainedRealPath({
      candidateRealPath: realPath,
      displayPath,
      rootRealPath,
    });

    if (stats.isDirectory()) {
      entries.push({ name, type: "directory" });
      inspectDirectory({
        directoryEntries,
        directoryPath: entryPath,
        files,
        rootPath,
        rootRealPath,
      });
      continue;
    }

    entries.push({ name, type: "file" });
    files.set(path.resolve(entryPath), realPath);
  }

  directoryEntries.set(path.resolve(directoryPath), entries);
};

type AssertContainedRealPathOptions = {
  candidateRealPath: string;
  displayPath: string;
  rootRealPath: string;
};

const assertContainedRealPath = ({
  candidateRealPath,
  displayPath,
  rootRealPath,
}: AssertContainedRealPathOptions): void => {
  const relativePath = path.relative(rootRealPath, candidateRealPath);
  const escapesRoot =
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);
  if (escapesRoot) {
    panic(
      `Unsafe catalogue filesystem entry at ${displayPath}: real path escapes the catalogue root`,
    );
  }
};

const lstatIfExists = (filePath: string): Stats | null => {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};
