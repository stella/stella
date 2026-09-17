/**
 * Pure decisions behind the document crumb's inline rename: whether the crumb
 * offers one at all, what a keystroke on the focused crumb means, and what
 * name a commit sends. The editor itself is the shared `InlineEdit` driven by
 * `useInlineRename`, so those own the draft buffer and the Escape/blur wiring.
 */

type DocumentCrumbRenameGate = {
  /** The `entity` search param; empty while the route carries no document. */
  entityId: string;
  /** Role check for the rename endpoint's `entity: ["update"]` permission. */
  canUpdateEntity: boolean;
  /**
   * False when another crumb follows (the page organizer appends one), where a
   * double-click is an ambiguous affordance rather than "rename what I opened".
   */
  isLastCrumb: boolean;
};

export const canRenameDocumentCrumb = ({
  entityId,
  canUpdateEntity,
  isLastCrumb,
}: DocumentCrumbRenameGate): boolean =>
  canUpdateEntity && isLastCrumb && entityId.length > 0;

type CrumbRenameShortcut = "start-rename" | "ignore";

/**
 * Keyboard parity for the double-click. Enter costs nothing to intercept: the
 * crumb links to the route the user is already on. F2 is the platform-wide
 * rename key.
 */
export const resolveCrumbRenameShortcut = (key: string): CrumbRenameShortcut =>
  key === "Enter" || key === "F2" ? "start-rename" : "ignore";

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

export type DocumentRenameSubmission =
  | { type: "commit"; name: string }
  | { type: "discard" };

type DocumentRenameSubmissionInput = {
  /** The raw draft the editor holds when Enter or a blur commits it. */
  draft: string;
  /** The stored file name, extension included. */
  currentName: string;
};

/**
 * What a commit sends. The draft edits the base name only, so the stored
 * extension is re-appended; a blank or unchanged result sends nothing, which
 * is also what Escape leaves behind because it never reaches this point.
 */
export const resolveDocumentRenameSubmission = ({
  draft,
  currentName,
}: DocumentRenameSubmissionInput): DocumentRenameSubmission => {
  const trimmed = draft.trim();
  if (trimmed.length === 0) {
    return { type: "discard" };
  }
  const name = `${trimmed}${splitFileName(currentName).extension}`;
  if (name === currentName) {
    return { type: "discard" };
  }
  return { type: "commit", name };
};
