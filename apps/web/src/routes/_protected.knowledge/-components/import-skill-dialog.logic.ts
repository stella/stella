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
