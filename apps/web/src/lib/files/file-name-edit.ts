/**
 * Renaming a file edits its base name; the extension is shown beside the
 * editor and kept. Every rename surface (the document crumb, the inspector
 * header) goes through these two helpers so they cannot disagree.
 */

/** A file name split for editing: the extension is shown but not editable. */
export const splitFileName = (
  fileName: string,
): { baseName: string; extension: string } => {
  const dotIndex = fileName.lastIndexOf(".");
  // A leading dot is the whole name of a dotfile, not an extension.
  if (dotIndex <= 0) {
    return { baseName: fileName, extension: "" };
  }
  return {
    baseName: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex),
  };
};

export type FileRenameSubmission =
  { type: "commit"; name: string } | { type: "discard" };

type FileRenameSubmissionInput = {
  /** The raw draft the editor holds when Enter or a blur commits it. */
  draft: string;
  /** The stored file name, extension included. */
  currentName: string;
};

/**
 * What a commit sends. The draft edits the base name only, so the stored
 * extension is re-appended, unless the draft already ends with it (in any
 * case), which would otherwise double it. A blank or unchanged result sends
 * nothing, which is also what Escape leaves behind because it never reaches
 * this point.
 *
 * The editor hands the draft over trimmed, so a stored name padded with
 * whitespace (`" Draft.docx"`) comes back shortened without the user typing
 * anything. Comparing against the trimmed base name keeps that blur a no-op
 * rather than a rename nobody asked for.
 */
export const resolveFileRenameSubmission = ({
  draft,
  currentName,
}: FileRenameSubmissionInput): FileRenameSubmission => {
  const trimmed = draft.trim();
  if (trimmed.length === 0) {
    return { type: "discard" };
  }
  const { baseName, extension } = splitFileName(currentName);
  const name =
    extension.length > 0 &&
    trimmed.toLowerCase().endsWith(extension.toLowerCase())
      ? trimmed
      : `${trimmed}${extension}`;
  if (name === currentName.trim() || trimmed === baseName.trim()) {
    return { type: "discard" };
  }
  return { type: "commit", name };
};
