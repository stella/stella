export const summarizeSkillImportFailures = <TFailure extends { code: string }>(
  failures: readonly TFailure[],
  localize: (failure: TFailure) => string,
  fallback: string,
): string => {
  const messages = [
    ...new Set(
      failures
        .map((failure) => localize(failure).trim())
        .filter((message) => message.length > 0),
    ),
  ];
  return messages.length > 0 ? messages.join("; ") : fallback;
};

const hasExtension = (file: { name: string }, extension: string) =>
  file.name.toLowerCase().endsWith(extension);

/**
 * The file of a drop or pick that installs a skill: a .zip pack, or a bare
 * markdown skill dropped on its own. A dropped folder arrives flattened into
 * its files; installing just one of its markdown files would lose the rest
 * without a word, so a folder without a .zip answers `null` like any drop
 * that holds no skill.
 */
export const pickSkillPackFile = <TFile extends { name: string }>(
  files: readonly TFile[],
): TFile | null => {
  const pack = files.find((file) => hasExtension(file, ".zip"));
  if (pack !== undefined) {
    return pack;
  }
  const [only, ...rest] = files;
  return only !== undefined && rest.length === 0 && hasExtension(only, ".md")
    ? only
    : null;
};

type SkippedFile<TReason extends string> = {
  path: string;
  reason: TReason;
};

type ListSkippedImportFilesOptions<TReason extends string> = {
  installed: readonly {
    skippedFiles: readonly SkippedFile<TReason>[];
    sourceUrl: string;
  }[];
  skills: readonly { name: string; sourceUrl: string }[];
};

export type SkippedImportFile<TReason extends string> = SkippedFile<TReason> & {
  skillName: string;
};

/** The files one installed skill left out, by path, named after the skill. */
export const nameSkippedFiles = <TReason extends string>(
  skillName: string,
  skippedFiles: readonly SkippedFile<TReason>[],
): SkippedImportFile<TReason>[] =>
  skippedFiles
    .toSorted((a, b) => (a.path < b.path ? -1 : 1))
    .map(({ path, reason }) => ({ path, reason, skillName }));

/** Every file the imported skills left out, named after its skill. */
export const listSkippedImportFiles = <TReason extends string>({
  installed,
  skills,
}: ListSkippedImportFilesOptions<TReason>): SkippedImportFile<TReason>[] => {
  const names = new Map(skills.map(({ name, sourceUrl }) => [sourceUrl, name]));
  return installed.flatMap(({ skippedFiles, sourceUrl }) =>
    nameSkippedFiles(names.get(sourceUrl) ?? sourceUrl, skippedFiles),
  );
};
