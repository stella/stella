export const FILE_PROPERTY_TYPE_IMMUTABLE_CODE = "file_property_type_immutable";

export const isFileProperty = (content: { type: string }): boolean =>
  content.type === "file";
