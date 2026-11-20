import type {
  DroppedFileTree,
  DroppedFileTreeFile,
} from "@/hooks/external-file-drop.logic";

/**
 * Whether these files still owe the user the question "is this a new version
 * of a document you already have?".
 */
export const REFERENCE_CHECK = {
  ask: "ask",
  /** The caller has already put the question and acted on the answer. */
  skip: "skip",
} as const;

type ReferenceCheckMode =
  (typeof REFERENCE_CHECK)[keyof typeof REFERENCE_CHECK];

/**
 * Whether these files still owe the user the question "this matter already
 * holds these exact bytes; upload them anyway?".
 */
export const DUPLICATE_CHECK = {
  ask: "ask",
  /** The user already chose to file these as new documents. */
  skip: "skip",
} as const;

type DuplicateCheckMode =
  (typeof DUPLICATE_CHECK)[keyof typeof DUPLICATE_CHECK];

type CreateFileEntitiesOptions = {
  parentId?: string | null | undefined;
  referenceCheck?: ReferenceCheckMode | undefined;
  duplicateCheck?: DuplicateCheckMode | undefined;
};

export type CreateFileEntitiesInput =
  | ({ files: File[] } & CreateFileEntitiesOptions)
  | ({ tree: DroppedFileTree } & CreateFileEntitiesOptions);

export const hasUploadInputItems = (
  input: CreateFileEntitiesInput,
): boolean => {
  if ("tree" in input) {
    return input.tree.files.length > 0 || input.tree.directoryPaths.length > 0;
  }

  return input.files.length > 0;
};

export const uploadInputFiles = (input: CreateFileEntitiesInput): File[] =>
  "tree" in input ? input.tree.files.map(({ file }) => file) : [...input.files];

export const withUploadInputFileReplacements = (
  input: CreateFileEntitiesInput,
  replacements: ReadonlyMap<File, File>,
): CreateFileEntitiesInput => {
  const options = {
    parentId: input.parentId,
    referenceCheck: input.referenceCheck,
    duplicateCheck: input.duplicateCheck,
  };
  if ("tree" in input) {
    return {
      tree: {
        files: input.tree.files.map(({ file, pathSegments }) => ({
          file: replacements.get(file) ?? file,
          pathSegments,
        })),
        directoryPaths: input.tree.directoryPaths,
      },
      ...options,
    };
  }

  return {
    files: input.files.map((file) => replacements.get(file) ?? file),
    ...options,
  };
};

const isWithin = (
  directoryPath: readonly string[],
  { pathSegments }: DroppedFileTreeFile,
): boolean =>
  pathSegments.length > directoryPath.length &&
  directoryPath.every((segment, index) => pathSegments[index] === segment);

/**
 * The dropped directories still worth creating once some files are left out.
 * A directory goes when every file the drop put inside it was left out, and
 * everything inside it goes with it: a re-dropped folder whose files are all
 * skipped must not leave an empty copy of its tree behind. A directory that
 * was empty in the drop itself stays, as long as its parents do.
 */
const keptDirectoryPaths = (
  tree: DroppedFileTree,
  keptFiles: readonly DroppedFileTreeFile[],
): string[][] => {
  const emptied = tree.directoryPaths.filter(
    (directoryPath) =>
      tree.files.some((file) => isWithin(directoryPath, file)) &&
      !keptFiles.some((file) => isWithin(directoryPath, file)),
  );
  return tree.directoryPaths.filter(
    (directoryPath) =>
      !emptied.some(
        (emptiedPath) =>
          emptiedPath.length <= directoryPath.length &&
          emptiedPath.every(
            (segment, index) => directoryPath[index] === segment,
          ),
      ),
  );
};

/**
 * The same upload minus the files the user chose not to send as new
 * documents (filed as versions, or skipped as duplicates). A dropped folder
 * loses the directories those files leave empty.
 */
export const withoutUploadInputFiles = (
  input: CreateFileEntitiesInput,
  excluded: ReadonlySet<File>,
): CreateFileEntitiesInput => {
  const options = {
    parentId: input.parentId ?? null,
    referenceCheck: REFERENCE_CHECK.skip,
    duplicateCheck: input.duplicateCheck,
  };
  if ("tree" in input) {
    const files = input.tree.files.filter(({ file }) => !excluded.has(file));
    return {
      tree: {
        files,
        directoryPaths: keptDirectoryPaths(input.tree, files),
      },
      ...options,
    };
  }

  return {
    files: input.files.filter((file) => !excluded.has(file)),
    ...options,
  };
};

/**
 * The upload left after the duplicate prompt: every duplicate the user did
 * not choose to upload anyway is skipped, and the other files of the batch
 * go ahead untouched.
 */
export const afterDuplicateChoice = ({
  input,
  duplicateFiles,
  uploadAnywayFiles,
}: {
  input: CreateFileEntitiesInput;
  duplicateFiles: readonly File[];
  uploadAnywayFiles: readonly File[];
}): CreateFileEntitiesInput => {
  const uploadAnyway = new Set(uploadAnywayFiles);
  return {
    ...withoutUploadInputFiles(
      input,
      new Set(duplicateFiles.filter((file) => !uploadAnyway.has(file))),
    ),
    duplicateCheck: DUPLICATE_CHECK.skip,
  };
};
