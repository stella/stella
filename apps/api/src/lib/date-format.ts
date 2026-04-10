type FormatDateTimeInTimeZoneProps = {
  date?: Date | undefined;
  timezone: string;
};

export const formatDateTimeInTimeZone = ({
  date = new Date(),
  timezone,
}: FormatDateTimeInTimeZoneProps) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
};

type FormatIsoDateForDisplayProps = {
  isoDate: string;
};

export const formatIsoDateForDisplay = ({
  isoDate,
}: FormatIsoDateForDisplayProps) => {
  const [year, month, day] = isoDate.split("-");
  const date = new Date(Number(year), Number(month) - 1, Number(day));

  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};
