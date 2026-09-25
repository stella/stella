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

/** Every file the imported skills left out, named after its skill. */
export const listSkippedImportFiles = <TReason extends string>({
  installed,
  skills,
}: ListSkippedImportFilesOptions<TReason>): SkippedImportFile<TReason>[] => {
  const names = new Map(skills.map(({ name, sourceUrl }) => [sourceUrl, name]));
  return installed.flatMap(({ skippedFiles, sourceUrl }) => {
    const skillName = names.get(sourceUrl) ?? sourceUrl;
    return skippedFiles
      .toSorted((a, b) => (a.path < b.path ? -1 : 1))
      .map(({ path, reason }) => ({ path, reason, skillName }));
  });
};
