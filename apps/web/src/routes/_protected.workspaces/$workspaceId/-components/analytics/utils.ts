/** Format minutes as "Xh Ym" or "Xh". */
export const formatHours = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

/** Format an ISO date string as a short label (e.g. "Jan 15"). */
export const formatPeriodLabel = (period: string): string => {
  const [y = 0, m = 1, d = 1] = period.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};

/** Format a Date as "YYYY-MM-DD". */
export const formatDateISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
