export const COMPOSER_MENU_SHORTCUT = {
  context: "context",
  skills: "skills",
} as const;

export type ComposerMenuShortcut =
  (typeof COMPOSER_MENU_SHORTCUT)[keyof typeof COMPOSER_MENU_SHORTCUT];

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
    return COMPOSER_MENU_SHORTCUT.skills;
  }
  if (hasContext && key === "@") {
    return COMPOSER_MENU_SHORTCUT.context;
  }
  return null;
};
