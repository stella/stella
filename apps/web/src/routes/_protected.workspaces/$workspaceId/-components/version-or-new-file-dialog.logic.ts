/**
 * Extracts the file extension from a filename (lowercase, without the dot).
 * Returns null if no extension is found.
 */
export const getExtension = (fileName: string): string | null => {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1 || lastDot === fileName.length - 1) {
    return null;
  }
  return fileName.slice(lastDot + 1).toLowerCase();
};

type ExtensionMatchInput = {
  /** The filename of the existing entity's file */
  entityFileName: string | null | undefined;
  /** The filename of the file being dropped/uploaded */
  uploadFileName: string;
};

/**
 * Checks if the file extension of an uploaded file matches the extension
 * of an existing entity's file. Extensions are compared case-insensitively.
 *
 * Returns false if the entity has no file or if extensions don't match exactly.
 */
export const extensionMatches = ({
  entityFileName,
  uploadFileName,
}: ExtensionMatchInput): boolean => {
  if (!entityFileName) {
    return false;
  }

  const entityExt = getExtension(entityFileName);
  const uploadExt = getExtension(uploadFileName);

  // Both files must have extensions, and they must match
  if (entityExt === null || uploadExt === null) {
    return false;
  }

  return entityExt === uploadExt;
};
