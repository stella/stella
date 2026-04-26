/** CSS class map for time entry / expense status badges. */
export const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  approved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  billed: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  written_off: "bg-red-500/10 text-red-700 dark:text-red-400",
};
