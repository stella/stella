/** CSS class map for time entry / expense status badges. */
export const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  approved: "bg-success/10 text-success dark:text-success",
  billed: "bg-accent text-foreground",
  written_off: "bg-destructive/10 text-destructive dark:text-destructive",
};
