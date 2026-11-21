import { splitFileName } from "@/lib/files/file-name-edit";

/**
 * The extension a file rename keeps, shown after the base-name editor so the
 * user sees what will be appended. Nothing for a name without an extension.
 */
export const fileExtensionSuffix = (fileName: string) => {
  const { extension } = splitFileName(fileName);
  return extension ? (
    <span className="text-muted-foreground text-xs">{extension}</span>
  ) : undefined;
};
