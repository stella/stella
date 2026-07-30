export const summarizeSkillImportFailures = (
  failures: readonly { message: string }[],
  fallback: string,
): string => {
  const messages = [
    ...new Set(
      failures
        .map((failure) => failure.message.trim())
        .filter((message) => message.length > 0),
    ),
  ];
  return messages.length > 0 ? messages.join("; ") : fallback;
};
