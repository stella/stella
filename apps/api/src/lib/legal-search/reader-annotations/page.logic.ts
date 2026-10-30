/**
 * A page never ends inside a mark: the rows of a passage over several
 * paragraphs share a group, and a page cut between them would hand the
 * reader half a mark now and the rest, without its comment, on the next
 * page. The page runs past `limit` to the group's last row instead.
 */
export const pageLengthKeepingMarksWhole = (
  rows: readonly { groupId: string | null }[],
  limit: number,
): number => {
  const lastGroupId = rows.at(limit - 1)?.groupId ?? null;
  if (lastGroupId === null) {
    return limit;
  }
  let length = limit;
  while (rows.at(length)?.groupId === lastGroupId) {
    length += 1;
  }
  return length;
};
