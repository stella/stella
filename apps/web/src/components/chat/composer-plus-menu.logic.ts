export type ComposerMenuShortcut = "context" | "skills";

type ResolveComposerMenuShortcutOptions = {
  altKey: boolean;
  ctrlKey: boolean;
  hasContext: boolean;
  hasSkills: boolean;
  isAltGraph: boolean;
  isComposing: boolean;
  isEditorEmpty: boolean;
  key: string;
  metaKey: boolean;
};

export const resolveComposerMenuShortcut = ({
  altKey,
  ctrlKey,
  hasContext,
  hasSkills,
  isAltGraph,
  isComposing,
  isEditorEmpty,
  key,
  metaKey,
}: ResolveComposerMenuShortcutOptions): ComposerMenuShortcut | null => {
  const hasBlockingModifier = metaKey || (!isAltGraph && (altKey || ctrlKey));
  if (!isEditorEmpty || isComposing || hasBlockingModifier) {
    return null;
  }
  if (hasSkills && key === "/") {
    return "skills";
  }
  if (hasContext && key === "@") {
    return "context";
  }
  return null;
};
