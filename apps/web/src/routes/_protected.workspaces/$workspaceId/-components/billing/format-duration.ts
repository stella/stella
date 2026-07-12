import { getFormatter } from "@/i18n/i18n-store";

export const formatMinutes = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) {
    return `${h}h ${m}m`;
  }
  if (h > 0) {
    return `${h}h`;
  }
  return `${m}m`;
};

export const formatDecimalHours = (minutes: number): string =>
  getFormatter().number(minutes / 60, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
