const DATE_ROLLOVER_EPSILON_MS = 50;

const padDatePart = (value: number): string =>
  value.toString().padStart(2, "0");

export const localDateFromTimestamp = (timestamp: number): string => {
  const current = new Date(timestamp);
  return [
    current.getFullYear(),
    padDatePart(current.getMonth() + 1),
    padDatePart(current.getDate()),
  ].join("-");
};

export const millisecondsUntilNextLocalDate = (timestamp: number): number => {
  const current = new Date(timestamp);
  const nextLocalDate = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() + 1,
  );
  return (
    Math.max(0, nextLocalDate.getTime() - timestamp) + DATE_ROLLOVER_EPSILON_MS
  );
};
