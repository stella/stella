export const FILE_PROPERTY_TYPE_IMMUTABLE_CODE = "file_property_type_immutable";

/** An AI money column was asked for by a caller without the table-analysis feature. */
export const AI_MONEY_COLUMN_UNAVAILABLE_CODE = "ai_money_column_unavailable";

/**
 * A reason was sent for a cell that holds no person's replacement of a run's
 * value (a run settled it again, or nobody replaced it).
 */
export const CELL_OVERRIDE_ABSENT_CODE = "cell_override_absent";

/**
 * The name a matter's file column starts with, whichever client created it.
 * The row is shared across members, so it stays in English; the web app shows
 * it in each reader's language for as long as the stored name equals this.
 */
export const DEFAULT_FILE_PROPERTY_NAME = "Documents";

export const isFileProperty = (content: { type: string }): boolean =>
  content.type === "file";
