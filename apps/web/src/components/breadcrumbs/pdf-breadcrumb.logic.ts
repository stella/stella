/**
 * Pure decisions behind the document crumb's inline rename: whether the crumb
 * offers one at all and what a keystroke on the focused crumb means. The name
 * a commit sends comes from `@/lib/files/file-name-edit`. The editor itself
 * is the shared `InlineEdit` driven by `useInlineRename`, so those own the
 * draft buffer and the Escape/blur wiring.
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
