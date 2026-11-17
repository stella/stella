/** First-line boxes shared by table cells, row labels, and selection controls. */
export const TABLE_FIRST_LINE = {
  /** Plain text at the table's body line height. */
  text: { slot: "h-5", content: "min-h-5" },
  /** A body line inside an editable field. */
  control: { slot: "h-7", content: "min-h-7" },
} as const;

export type TableFirstLine = keyof typeof TABLE_FIRST_LINE;
