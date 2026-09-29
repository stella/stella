import { getFormatter } from "@/i18n/i18n-store";

export const formatMinutes = (minutes: number): string => {
  const formatter = getFormatter();
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(
      formatter.number(hours, {
        style: "unit",
        unit: "hour",
        unitDisplay: "short",
      }),
    );
  }
  if (remainingMinutes > 0 || parts.length === 0) {
    parts.push(
      formatter.number(remainingMinutes, {
        style: "unit",
        unit: "minute",
        unitDisplay: "short",
      }),
    );
  }
  return parts.join(" ");
};

export const formatDecimalHours = (minutes: number): string =>
  getFormatter().number(minutes / 60, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
