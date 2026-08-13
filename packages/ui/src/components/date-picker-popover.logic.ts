const DATE_ROLLOVER_EPSILON_MS = 50;

export type CalendarMonth = {
  month: number;
  year: number;
};

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

const calendarMonthFromDate = (date: string): CalendarMonth => {
  const current = new Date(`${date}T00:00:00Z`);
  return { month: current.getUTCMonth(), year: current.getUTCFullYear() };
};

export const resolveCalendarViewMonth = ({
  override,
  today,
  value,
}: {
  override: CalendarMonth | null;
  today: string;
  value: string;
}): CalendarMonth => override ?? calendarMonthFromDate(value || today);

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
