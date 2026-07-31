export const shouldFetchChatThreadTitle = ({
  groupedTitle,
  lastActivityAt,
}: {
  groupedTitle: string | null;
  lastActivityAt: string | null | undefined;
}): boolean =>
  groupedTitle === null &&
  lastActivityAt !== null &&
  lastActivityAt !== undefined;
