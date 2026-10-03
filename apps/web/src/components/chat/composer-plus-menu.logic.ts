import type { ResolvedPos } from "@tiptap/pm/model";

export const COMPOSER_MENU_SHORTCUT = {
  context: "context",
  skills: "skills",
} as const;

export type ComposerMenuShortcut =
  (typeof COMPOSER_MENU_SHORTCUT)[keyof typeof COMPOSER_MENU_SHORTCUT];

/** The character each shortcut is typed with. It never reaches the editor;
 *  the shortcut's search field shows it in place of the magnifier. */
export const COMPOSER_MENU_SHORTCUT_CHAR = {
  context: "@",
  skills: "/",
} as const satisfies Record<ComposerMenuShortcut, string>;

type ContextMentionSearchKeyOptions = {
  organizationId: string;
  query: string;
  registrationVersion: number;
  threadKey: string;
  userId: string;
};

/**
 * Cache key of the Context picker's mention search. The results come from the
 * mention sources registered for the open thread, so the key names the
 * signed-in user, the organization, the thread (and with it the workspace) and
 * the registration generation: a search repeated elsewhere never answers from
 * another scope's rows.
 */
export const contextMentionSearchKey = ({
  organizationId,
  query,
  registrationVersion,
  threadKey,
  userId,
}: ContextMentionSearchKeyOptions) =>
  [
    "chat-mention-search",
    organizationId,
    userId,
    threadKey,
    registrationVersion,
    query,
  ] as const;

// Stands in for an inline leaf (a mention or skill chip) before the caret: the
// chip is a word of its own, so a trigger typed flush against it stays literal.
const INLINE_LEAF_CHAR = "\ufffc";

/**
 * The character just before the caret, or `null` at the start of a block (an
 * empty composer included). A hard break reads as the newline it renders.
 */
export const charBeforeCaret = ($from: ResolvedPos): string | null => {
  if ($from.parentOffset === 0) {
    return null;
  }
  const { nodeBefore } = $from;
  if (nodeBefore?.isText && nodeBefore.text) {
    return nodeBefore.text.at(-1) ?? null;
  }
  return nodeBefore?.type.name === "hardBreak" ? "\n" : INLINE_LEAF_CHAR;
};

type ShouldDrainSkillPagesOptions = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  open: boolean;
  query: string;
};

export const shouldDrainSkillPages = ({
  hasNextPage,
  isFetchingNextPage,
  open,
  query,
}: ShouldDrainSkillPagesOptions): boolean =>
  open && query.trim() !== "" && hasNextPage && !isFetchingNextPage;

type ResolveComposerMenuShortcutOptions = {
  /** From {@link charBeforeCaret}. */
  charBeforeCaret: string | null;
  /** The keystroke's `typedCharacter` (`@stll/ui/typed-character`). */
  character: string | null;
  hasContext: boolean;
  hasSkills: boolean;
};

/** A trigger starts a word at the start of a block or after whitespace, so
 *  `and/or`, `jan@firm.cz` and URLs keep typing their character literally. */
const startsWord = (charBefore: string | null): boolean =>
  charBefore === null || /^\s$/u.test(charBefore);

export const resolveComposerMenuShortcut = ({
  charBeforeCaret: charBefore,
  character,
  hasContext,
  hasSkills,
}: ResolveComposerMenuShortcutOptions): ComposerMenuShortcut | null => {
  if (!startsWord(charBefore)) {
    return null;
  }
  if (hasSkills && character === COMPOSER_MENU_SHORTCUT_CHAR.skills) {
    return COMPOSER_MENU_SHORTCUT.skills;
  }
  if (hasContext && character === COMPOSER_MENU_SHORTCUT_CHAR.context) {
    return COMPOSER_MENU_SHORTCUT.context;
  }
  return null;
};

export const SHORTCUT_POPUP_SIDE = {
  above: "top",
  below: "bottom",
} as const;

export type ShortcutPopupSide =
  (typeof SHORTCUT_POPUP_SIDE)[keyof typeof SHORTCUT_POPUP_SIDE];

/** Room a shortcut popup needs above the caret to show its search field and
 *  a handful of rows before the list has to scroll. */
export const SHORTCUT_POPUP_COMFORT_HEIGHT = 320;

type ChooseShortcutPopupSideOptions = {
  caretBottom: number;
  caretTop: number;
  viewportHeight: number;
};

/**
 * The side of the caret a shortcut popup opens on, decided once from the room
 * around the caret when it opens. The popup keeps that side while open and
 * scrolls within the room it has: a side re-evaluated against the list's
 * height flips the popup across the caret whenever results load or the query
 * changes, landing it under a resting pointer whose hover then takes focus
 * from the search field. Above is preferred, like the composer's other menus;
 * below only when above is short of the comfortable height and below has
 * more room.
 */
export const chooseShortcutPopupSide = ({
  caretBottom,
  caretTop,
  viewportHeight,
}: ChooseShortcutPopupSideOptions): ShortcutPopupSide => {
  const roomAbove = caretTop;
  const roomBelow = viewportHeight - caretBottom;
  if (roomAbove >= SHORTCUT_POPUP_COMFORT_HEIGHT || roomAbove >= roomBelow) {
    return SHORTCUT_POPUP_SIDE.above;
  }
  return SHORTCUT_POPUP_SIDE.below;
};
