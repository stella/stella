export const shouldFetchChatThreadTitle = ({
  groupedTitle,
  threadExists,
}: {
  groupedTitle: string | null | undefined;
  threadExists: boolean | undefined;
}): boolean => groupedTitle === null && threadExists === true;
