export const FILE_PROPERTY_TYPE_IMMUTABLE_CODE = "file_property_type_immutable";

/**
 * The name a matter's file column starts with, whichever client created it.
 * The row is shared across members, so it stays in English; the web app shows
 * it in each reader's language for as long as the stored name equals this.
 */
export const DEFAULT_FILE_PROPERTY_NAME = "Documents";

export const isFileProperty = (content: { type: string }): boolean =>
  content.type === "file";
