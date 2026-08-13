const DATE_ROLLOVER_EPSILON_MS = 50;

export const utcDateFromTimestamp = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(0, 10);

export const millisecondsUntilNextUtcDate = (timestamp: number): number => {
  const current = new Date(timestamp);
  const nextUtcDate = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() + 1,
  );
  return Math.max(0, nextUtcDate - timestamp) + DATE_ROLLOVER_EPSILON_MS;
};
