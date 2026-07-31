export const shouldFetchChatThreadTitle = ({
  groupedTitle,
  lastActivityAt,
}: {
  groupedTitle: string | null | undefined;
  lastActivityAt: string | null | undefined;
}): boolean =>
  groupedTitle === null &&
  lastActivityAt !== null &&
  lastActivityAt !== undefined;
