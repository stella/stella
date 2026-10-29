import type { useFormatter } from "use-intl";

export const formatDuration = (
  milliseconds: number,
  format: ReturnType<typeof useFormatter>,
): string => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${format.number(Math.floor(seconds / 60), { useGrouping: false })}:${format.number(seconds % 60, { minimumIntegerDigits: 2, useGrouping: false })}`;
};
