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
