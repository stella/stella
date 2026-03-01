/** Escape SQL LIKE metacharacters so they match literally. */
export const escapeLike = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
