import { useMemo, useRef, useState } from "react";
import type { ComponentProps, RefObject } from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Editor } from "@tiptap/core";
import { Result } from "better-result";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import { CHAT_SKILL_CONTEXT_NEED } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { COMPOSER_CONTROL_BUTTON_SIZE } from "@stll/ui/composer";
import {
  AtSignIcon,
  CpuIcon,
  NewChatIcon,
  PaperclipIcon,
  PlusIcon,
  ServerIcon,
  SkillIcon,
} from "@stll/ui/icons";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/menu";
import { typedCharacter } from "@stll/ui/typed-character";
import { cn } from "@stll/ui/utils";

import {
  useChatEditorExtensionVersion,
  useChatEditorManager,
} from "@/components/chat-editor-provider";
import {
  buildChatSlashItems,
  commandShortcutRowsFromSkillPages,
} from "@/components/chat-editor-slash-items";
import {
  MENTION_CATEGORY_ORDER,
  MentionIcon,
  useMentionCategoryLabel,
} from "@/components/chat-mention-category";
import { selectChatSuggestionItems } from "@/components/chat-mention-extension";
import type {
  ChatMentionOption,
  ChatReferenceCategory,
  ChatWorkspaceMentionOption,
} from "@/components/chat-mention-extension";
import {
  buildEntityMentionOption,
  buildWorkspaceMentionOptions,
  CHAT_MENTION_ENTITY_RESULT_LIMIT,
  CHAT_MENTION_SEARCH_DEBOUNCE_MS,
  getMentionViewScope,
  insertChatMention,
} from "@/components/chat-mention-helpers";
import { insertPastedTextChip } from "@/components/chat-pasted-text-extension";
import {
  ComposerEditModeSubmenu,
  type ComposerEditModeMenuProps,
} from "@/components/chat/chat-edit-mode-menu";
import {
  CHAT_MODEL_MENU_POPUP_CLASS_NAME,
  ChatModelOptionsMenu,
  type ComposerModelsMenuProps,
} from "@/components/chat/chat-model-options-menu";
import {
  charBeforeCaret,
  chooseShortcutPopupSide,
  COMPOSER_MENU_SHORTCUT_CHAR,
  contextMentionSearchKey,
  resolveComposerMenuShortcut,
  SHORTCUT_POPUP_SIDE,
  shouldDrainSkillPages,
  type ComposerMenuShortcut,
  type ShortcutPopupSide,
} from "@/components/chat/composer-plus-menu.logic";
import { ComposerQueryResults } from "@/components/chat/composer-query-results";
import {
  ComposerSubmenuSearch,
  pickHighlightedItemOnTab,
  useFocusSearchOnOpen,
  type ComposerSearchTrigger,
} from "@/components/chat/composer-submenu-search";
import { slashItemChipAttrs } from "@/components/chat/prompt-slash-extension";
import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import { MatterIcon } from "@/components/matter-icon";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useSetChatWebSearch } from "@/features/chat/components/chat-web-search-toggle";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { getChatThreadKey } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  knowledgeKeys,
  mcpConnectionsOptions,
  mcpConnectorsOptions,
  skillsOptions,
} from "@/lib/knowledge/queries";
import {
  chatSkillRowState,
  oneClickSkillNeeds,
  slashItemSkillId,
  type ChatSkillRowState,
  type ComposerSkillChatContext,
} from "@/lib/prompts/chat-skill-availability.logic";
import { useComposerSkillAvailability } from "@/lib/prompts/use-chat-unavailable-skills";
import type { ReservedChatCommandContext } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView } from "@/lib/use-query-view";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { useEntitiesOptions } from "@/lib/workspaces/queries/entities";
import { viewsOptions } from "@/lib/workspaces/queries/views";

/** Enables and drives the Skills submenu and the "/" shortcut. Reuses the
 *  same data source and chip content as the AI prompt input's `/` menu. */
export type ComposerSkillsMenuProps = {
  activeOrganizationId: string;
  /** The chat this composer sends in. With it, a skill that chat cannot
   *  run shows disabled with what it lacks; without it, the menu answers
   *  for the widest chat. */
  chat?: ComposerSkillChatContext | undefined;
  editor: Editor | null;
  reservedCommands?: ReservedChatCommandContext | null | undefined;
};

/** Enables and drives the Context submenu and the "@" shortcut: reference a
 *  matter, a file inside one, or anything a registered mention source finds,
 *  as a mention chip. */
export type ComposerContextMenuProps = {
  activeOrganizationId: string;
  editor: Editor | null;
  /** Scopes an inserted file/matter mention's `sourceWorkspaceId`: omitted
   *  when the referenced matter is already the thread's own workspace. */
  threadRef: ChatThreadRef;
};

type ComposerPlusMenuProps = {
  disabled: boolean;
  guideAnchorsEnabled?: boolean;
  onOpenFilePicker: () => void;
  /** Starts a new thread from the menu's leading row. `null` hides the row
   *  (a thread with nothing to leave, or a rotation under way), mirroring
   *  the dock's own new-chat button which keeps the same action. */
  onNewThread?: (() => void) | null | undefined;
  models?: ComposerModelsMenuProps | undefined;
  /** Enables the Edit mode submenu (how AI edits land in the open DOCX).
   *  Lives only here, never in the dock; omit on surfaces without a
   *  selectable edit mode. */
  editMode?: ComposerEditModeMenuProps | undefined;
  skills?: ComposerSkillsMenuProps | undefined;
  /** Enables the Context submenu (mention a matter or one of its files);
   *  omit on surfaces without a mention-insertion target. */
  context?: ComposerContextMenuProps | undefined;
  /** Enables the MCP Servers submenu; omit on surfaces without a tools
   *  catalogue link. */
  mcp?: { activeOrganizationId: string } | undefined;
  /** Positioning for the trigger button, differing per slot: absolute on the
   *  empty placeholder line, `me-auto` at the start of the bottom action row. */
  triggerClassName?: string | undefined;
};

// The composer's (+) affordance: a single Menu rendered into whichever slot the
// composer state calls for. A circular, filled button (not a bare ghost icon)
// carrying new chat / attach / models / edit mode / skills / MCP actions, the
// submenus hover-opening (Cursor's (+) pattern). Shared by every chat surface
// so the affordance can never drift; each submenu appears only when the
// surface passes the matching prop. The list-backed submenus' queries are
// gated on the root menu's open state, so opening (+) — not mounting the
// composer — is what triggers the fetches.
//
// The "/" and "@" editor shortcuts open the Skills or Context list as a
// standalone popup anchored at the caret, never as the root menu with a
// submenu forced open: a shortcut leaves the pointer wherever the caret was,
// typically on top of a sibling root item, and Base UI closes an open submenu
// as soon as the pointer moves over a sibling (`itemhover`), so the popup
// gets no siblings to lose to. These popups are the composer's only "/" and
// "@" pickers; the editor itself installs no inline suggestion popover.
export const ComposerPlusMenu = ({
  disabled,
  guideAnchorsEnabled = false,
  onOpenFilePicker,
  onNewThread,
  models,
  editMode,
  skills,
  context,
  mcp,
  triggerClassName,
}: ComposerPlusMenuProps) => {
  const t = useTranslations();
  const [menuOpen, setMenuOpen] = useState(false);
  // Set only by the editor shortcut listener below. Closing a shortcut popup
  // returns focus to the editor; an ordinary (+) click or Escape keeps Base
  // UI's default of returning focus to the trigger button.
  const [shortcutMenu, setShortcutMenu] = useState<ComposerMenuShortcut | null>(
    null,
  );
  // Set together with `shortcutMenu` but never cleared, so a closing popup
  // animates out where it opened instead of jumping to the (+) button.
  const [shortcutPlacement, setShortcutPlacement] =
    useState<ShortcutPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shortcutEditor = skills?.editor ?? context?.editor ?? null;
  const hasSkillsShortcut = skills !== undefined;
  const hasContextShortcut = context !== undefined;

  // The menu owns its editor shortcuts. Any composer that renders a Skills
  // or Context submenu therefore gets the same "/" and "@" behavior wherever
  // a word starts, without a second surface-level key handler that can
  // drift. The trigger is consumed here (the search field shows it instead)
  // and the list owns filtering.
  useExternalSyncEffect(() => {
    if (!shortcutEditor || shortcutEditor.isDestroyed) {
      return undefined;
    }

    const editorElement = shortcutEditor.view.dom;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (disabled) {
        return;
      }

      const shortcut = resolveComposerMenuShortcut({
        charBeforeCaret: charBeforeCaret(shortcutEditor.state.selection.$from),
        character: typedCharacter(event),
        hasContext: hasContextShortcut,
        hasSkills: hasSkillsShortcut,
      });
      if (!shortcut) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      setShortcutPlacement(createCaretPlacement(shortcutEditor, triggerRef));
      setShortcutMenu(shortcut);
    };

    editorElement.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      editorElement.removeEventListener("keydown", handleKeyDown, {
        capture: true,
      });
    };
  }, [disabled, hasContextShortcut, hasSkillsShortcut, shortcutEditor]);

  // Focusing without a position keeps the editor's own selection: the caret
  // the trigger was typed at, or wherever an outside click just put it.
  const closeShortcutMenu = () => {
    setShortcutMenu(null);
    if (shortcutEditor && !shortcutEditor.isDestroyed) {
      shortcutEditor.commands.focus();
    }
  };
  const popupAnchor = shortcutPlacement?.anchor ?? triggerRef;
  const popupSide = shortcutPlacement?.side ?? SHORTCUT_POPUP_SIDE.above;
  const submenuHost = { kind: "submenu", guideAnchorsEnabled } as const;

  return (
    <>
      <Menu onOpenChange={setMenuOpen} open={menuOpen}>
        <MenuTrigger
          aria-label={t("chat.composerMenu.open")}
          disabled={disabled}
          ref={triggerRef}
          render={
            <Button
              {...guideAnchor(
                GUIDE_ANCHORS.chatToolsButton,
                guideAnchorsEnabled,
              )}
              className={cn(
                "border-border size-7 shrink-0 rounded-full border",
                triggerClassName,
              )}
              size={COMPOSER_CONTROL_BUTTON_SIZE}
              type="button"
              variant="secondary"
            />
          }
        >
          <PlusIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="start" side="top">
          {onNewThread && (
            <>
              <MenuItem onClick={onNewThread}>
                <NewChatIcon />
                {t("chat.newChat")}
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuItem
            {...guideAnchor(GUIDE_ANCHORS.chatMenuAttach, guideAnchorsEnabled)}
            onClick={onOpenFilePicker}
          >
            <PaperclipIcon />
            {t("chat.attachFile")}
          </MenuItem>
          {models && (
            <ComposerModelsSubmenu
              enabled={menuOpen}
              guideAnchorsEnabled={guideAnchorsEnabled}
              models={models}
            />
          )}
          {editMode && (
            <ComposerEditModeSubmenu
              onChange={editMode.onChange}
              optionId={editMode.optionId}
            />
          )}
          {skills && (
            <ComposerSkillsMenu
              enabled={menuOpen}
              host={submenuHost}
              skills={skills}
            />
          )}
          {context && (
            <ComposerContextMenu
              context={context}
              enabled={menuOpen}
              host={submenuHost}
            />
          )}
          {mcp && (
            <ComposerMcpSubmenu
              enabled={menuOpen}
              guideAnchorsEnabled={guideAnchorsEnabled}
              mcp={mcp}
            />
          )}
        </MenuPopup>
      </Menu>
      {skills && (
        <ComposerSkillsMenu
          enabled={shortcutMenu === "skills"}
          host={{
            kind: "shortcut",
            anchor: popupAnchor,
            open: shortcutMenu === "skills",
            onClose: closeShortcutMenu,
            side: popupSide,
          }}
          skills={skills}
        />
      )}
      {context && (
        <ComposerContextMenu
          context={context}
          enabled={shortcutMenu === "context"}
          host={{
            kind: "shortcut",
            anchor: popupAnchor,
            open: shortcutMenu === "context",
            onClose: closeShortcutMenu,
            side: popupSide,
          }}
        />
      )}
    </>
  );
};

type ShortcutAnchor = NonNullable<ComponentProps<typeof MenuPopup>["anchor"]>;

type ShortcutPlacement = { anchor: ShortcutAnchor; side: ShortcutPopupSide };

// The side is fixed by `chooseShortcutPopupSide` when the popup opens; Base
// UI's default flip would re-decide it on every change in the list's height.
const SHORTCUT_POPUP_COLLISION_AVOIDANCE = {
  side: "none",
  align: "shift",
  fallbackAxisSide: "none",
} as const satisfies NonNullable<
  ComponentProps<typeof MenuPopup>["collisionAvoidance"]
>;

/**
 * A virtual anchor at the caret a shortcut was typed at, and the side its
 * popup opens on. The position is read once, so the anchor keeps one identity
 * while its popup is open; the rect is re-measured on each layout so it
 * follows scrolling, falling back to the (+) button once the caret can no
 * longer be measured.
 */
const createCaretPlacement = (
  editor: Editor,
  fallback: RefObject<HTMLButtonElement | null>,
): ShortcutPlacement => {
  const caret = editor.state.selection.from;
  const measureCaret = () => {
    if (!editor.isDestroyed) {
      const coords = Result.try(() => editor.view.coordsAtPos(caret));
      if (!Result.isError(coords)) {
        const { bottom, left, top } = coords.value;
        return new DOMRect(left, top, 0, bottom - top);
      }
    }
    return fallback.current?.getBoundingClientRect() ?? new DOMRect();
  };
  const opening = measureCaret();
  return {
    anchor: {
      contextElement: editor.view.dom,
      getBoundingClientRect: measureCaret,
    },
    side: chooseShortcutPopupSide({
      caretBottom: opening.bottom,
      caretTop: opening.top,
      viewportHeight: window.innerHeight,
    }),
  };
};

/**
 * Where a Skills or Context list renders: as a hover-opening submenu of the
 * (+) root menu, or as the standalone popup an editor shortcut opens, anchored
 * at the caret and owned by the shortcut's open state.
 */
type ComposerListHost =
  | { kind: "submenu"; guideAnchorsEnabled: boolean }
  | {
      kind: "shortcut";
      anchor: ShortcutAnchor;
      open: boolean;
      onClose: () => void;
      side: ShortcutPopupSide;
    };

/** The shortcut popup's search leads with the trigger the user typed; the
 *  (+) submenus keep the magnifier. */
const searchTrigger = (
  host: ComposerListHost,
  shortcut: ComposerMenuShortcut,
): ComposerSearchTrigger | undefined =>
  host.kind === "shortcut"
    ? { char: COMPOSER_MENU_SHORTCUT_CHAR[shortcut], onErase: host.onClose }
    : undefined;

const ComposerSubmenuEmpty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-muted-foreground px-2.5 py-2 text-xs">{children}</p>
);

const ComposerModelsSubmenu = ({
  enabled,
  guideAnchorsEnabled,
  models,
}: {
  enabled: boolean;
  guideAnchorsEnabled: boolean;
  models: ComposerModelsMenuProps;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <MenuSub onOpenChange={setOpen} open={open}>
      <MenuSubTrigger
        {...guideAnchor(GUIDE_ANCHORS.chatMenuModels, guideAnchorsEnabled)}
      >
        <CpuIcon />
        {t("chat.composerMenu.models")}
      </MenuSubTrigger>
      <MenuSubPopup className={CHAT_MODEL_MENU_POPUP_CLASS_NAME}>
        <ChatModelOptionsMenu
          enabled={enabled && open}
          key={open ? "open" : "closed"}
          models={models}
          open={open}
        />
      </MenuSubPopup>
    </MenuSub>
  );
};

const itemName = (item: SlashItem): string => {
  if (item.kind === "prompt") {
    return item.prompt.name;
  }
  if (item.kind === "skill") {
    return item.skill.name;
  }
  return item.command.name;
};

const itemKey = (item: SlashItem): string => {
  if (item.kind === "prompt") {
    return `prompt-${item.prompt.id}`;
  }
  if (item.kind === "skill") {
    return `skill-${item.skill.id}`;
  }
  return `command-${item.command.id}`;
};

/** Secondary, muted line under an item's name, mirroring the former
 *  `/`-suggestion list's row shape (prompt body / skill description). */
const itemSecondary = (item: SlashItem): string => {
  if (item.kind === "prompt") {
    return item.prompt.body;
  }
  if (item.kind === "skill") {
    return item.skill.description;
  }
  return item.command.command;
};

const ComposerSkillItemBody = ({
  blocked,
  item,
  secondary,
}: {
  /** A skill this chat cannot run: muted, and the second line says why. */
  blocked: boolean;
  item: SlashItem;
  secondary: string;
}) => (
  <>
    <SkillIcon
      className={cn("mt-0.5 self-start", blocked && "text-muted-foreground")}
    />
    <span className="min-w-0 flex-1">
      <BidiText
        as="span"
        className={cn(
          "block truncate text-sm",
          blocked && "text-muted-foreground",
        )}
      >
        {itemName(item)}
      </BidiText>
      <BidiText
        as="span"
        className={cn(
          "text-muted-foreground block text-xs",
          // The reason is the row's point; let it wrap rather than clip.
          !blocked && "truncate",
        )}
      >
        {secondary}
      </BidiText>
    </span>
  </>
);

/**
 * A blocked row whose one click turns web search on and, once the thread
 * has stored it, inserts the skill: a send reads the stored switch, so an
 * insert before then could still be refused.
 */
const WebSearchFixSkillItem = ({
  item,
  message,
  onSelect,
  threadRef,
}: {
  item: SlashItem;
  message: string;
  onSelect: (item: SlashItem) => void;
  threadRef: ChatThreadRef;
}) => {
  const setWebSearch = useSetChatWebSearch(threadRef);
  return (
    <MenuItem
      onClick={() => {
        setWebSearch(true, {
          onSaved: () => {
            onSelect(item);
          },
        });
      }}
    >
      <ComposerSkillItemBody blocked item={item} secondary={message} />
    </MenuItem>
  );
};

/**
 * One row of the Skills submenu. A skill this chat cannot run stays listed,
 * disabled, with what the chat lacks; where the composer can meet that need
 * in one click, the row does so and inserts the skill.
 */
const ComposerSkillMenuItem = ({
  chat,
  item,
  onSelect,
  state,
}: {
  chat: ComposerSkillChatContext | undefined;
  item: SlashItem;
  onSelect: (item: SlashItem) => void;
  state: ChatSkillRowState;
}) => {
  const t = useTranslations();
  if (state.status === "offered") {
    return (
      <MenuItem
        onClick={() => {
          onSelect(item);
        }}
      >
        <ComposerSkillItemBody
          blocked={false}
          item={item}
          secondary={itemSecondary(item)}
        />
      </MenuItem>
    );
  }
  const message = t(state.messageKey);
  if (state.fixable && chat !== undefined) {
    if (state.need === CHAT_SKILL_CONTEXT_NEED.webSearch) {
      return (
        <WebSearchFixSkillItem
          item={item}
          message={message}
          onSelect={onSelect}
          threadRef={chat.threadRef}
        />
      );
    }
    const { onReviewEdits } = chat;
    if (
      state.need === CHAT_SKILL_CONTEXT_NEED.reviewEdits &&
      onReviewEdits !== undefined
    ) {
      return (
        <MenuItem
          onClick={() => {
            onReviewEdits();
            onSelect(item);
          }}
        >
          <ComposerSkillItemBody blocked item={item} secondary={message} />
        </MenuItem>
      );
    }
  }
  return (
    <MenuItem disabled>
      <ComposerSkillItemBody blocked item={item} secondary={message} />
    </MenuItem>
  );
};

export const ComposerSkillsMenu = ({
  enabled,
  host,
  skills,
}: {
  enabled: boolean;
  host: ComposerListHost;
  skills: ComposerSkillsMenuProps;
}) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const { activeOrganizationId, chat, editor, reservedCommands } = skills;
  const { id: userId } = useAuthenticatedUser();
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const open = host.kind === "shortcut" ? host.open : submenuOpen;
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnOpen(open, searchRef);
  const skillsQuery = useInfiniteQuery({
    ...skillsOptions(activeOrganizationId, userId),
    enabled,
  });
  const skillsView = useQueryView(skillsQuery, {
    isEmpty: (data) =>
      data.pages.every(
        (page) => page.builtIn.length === 0 && page.installed.length === 0,
      ),
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = skillsQuery;
  const data = skillsView.type === "items" ? skillsView.items : undefined;

  const availability = useComposerSkillAvailability({
    chat,
    enabled,
    organizationId: activeOrganizationId,
    userId,
  });
  // Only skills no chat can run leave the menu; one this chat alone cannot
  // run stays, disabled, with what the chat lacks.
  const unavailableSkillIds = availability?.hidden;
  const oneClickNeeds = oneClickSkillNeeds(chat);
  const shortcutRows = useMemo(
    () => commandShortcutRowsFromSkillPages(data?.pages, unavailableSkillIds),
    [data?.pages, unavailableSkillIds],
  );
  const items = useMemo(
    () =>
      buildChatSlashItems({
        shortcuts: shortcutRows,
        skillPages: data?.pages,
        unavailableSkillIds,
        reservedCommands: reservedCommands ?? null,
      }),
    [reservedCommands, shortcutRows, data?.pages, unavailableSkillIds],
  );

  const query = search.trim().toLowerCase();
  useExternalSyncEffect(() => {
    if (
      skillsQuery.isError ||
      !shouldDrainSkillPages({
        hasNextPage,
        isFetchingNextPage,
        open,
        query,
      })
    ) {
      return;
    }
    detached(fetchNextPage(), "composer-plus-menu.fetch-next-page");
  }, [
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    open,
    query,
    skillsQuery.isError,
  ]);

  const filteredItems = query
    ? items.filter((item) => itemName(item).toLowerCase().includes(query))
    : items;

  const handleSelect = (item: SlashItem) => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    insertPastedTextChip(editor, slashItemChipAttrs(item));
  };

  let skillItemsContent: React.ReactNode;
  if (
    filteredItems.length === 0 &&
    query !== "" &&
    (hasNextPage || isFetchingNextPage)
  ) {
    skillItemsContent = (
      <ComposerSubmenuEmpty>{t("common.loading")}</ComposerSubmenuEmpty>
    );
  } else if (filteredItems.length === 0) {
    skillItemsContent = (
      <ComposerSubmenuEmpty>
        {t("chat.composerMenu.noSkills")}
      </ComposerSubmenuEmpty>
    );
  } else {
    skillItemsContent = filteredItems.map((item) => (
      <ComposerSkillMenuItem
        chat={chat}
        item={item}
        key={itemKey(item)}
        onSelect={handleSelect}
        state={chatSkillRowState({
          availability,
          oneClickNeeds,
          skillId: slashItemSkillId(item),
        })}
      />
    ));
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (host.kind === "shortcut") {
      if (!nextOpen) {
        host.onClose();
      }
    } else {
      setSubmenuOpen(nextOpen);
    }
    if (!nextOpen) {
      setSearch("");
    }
  };
  // Reuses the chat landing page's "Skills" section label (same value)
  // instead of adding a duplicate key.
  const label = t("chat.landing.skills");
  const content = (
    <>
      <ComposerSubmenuSearch
        onChange={setSearch}
        placeholder={t("chat.composerMenu.searchSkills")}
        ref={searchRef}
        trigger={searchTrigger(host, "skills")}
        value={search}
      />
      <ComposerQueryResults
        views={{ skills: skillsView }}
        hasItems={filteredItems.length > 0}
        empty={skillItemsContent}
      >
        {skillItemsContent}
      </ComposerQueryResults>
      {hasNextPage && (
        <MenuItem
          disabled={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "composer-plus-menu.fetch-next-page");
          }}
        >
          {isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        onClick={() => {
          detached(
            navigate({
              to: "/knowledge/tools",
              search: { kind: "skill" },
            }),
            "composer-plus-menu.navigate",
          );
        }}
      >
        {t("chat.composerMenu.openSkills")}
      </MenuItem>
    </>
  );

  if (host.kind === "shortcut") {
    return (
      <ComposerShortcutPopup
        anchor={host.anchor}
        label={label}
        onOpenChange={handleOpenChange}
        open={open}
        side={host.side}
      >
        {content}
      </ComposerShortcutPopup>
    );
  }
  return (
    <MenuSub onOpenChange={handleOpenChange} open={open}>
      <MenuSubTrigger
        {...guideAnchor(GUIDE_ANCHORS.chatMenuSkills, host.guideAnchorsEnabled)}
      >
        <SkillIcon />
        {label}
      </MenuSubTrigger>
      <MenuSubPopup className="w-72" onKeyDown={pickHighlightedItemOnTab}>
        {content}
      </MenuSubPopup>
    </MenuSub>
  );
};

// The trigger-less Menu a shortcut opens at the caret, following the
// sr-only-trigger shape of the shell's anchored menus (`useAnchoredMenu`).
const ComposerShortcutPopup = ({
  anchor,
  children,
  label,
  onOpenChange,
  open,
  side,
}: {
  anchor: ShortcutAnchor;
  children: React.ReactNode;
  label: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  side: ShortcutPopupSide;
}) => (
  <Menu onOpenChange={onOpenChange} open={open}>
    <MenuTrigger nativeButton={false} render={<span className="sr-only" />} />
    <MenuPopup
      align="start"
      anchor={anchor}
      aria-label={label}
      className="w-72"
      collisionAvoidance={SHORTCUT_POPUP_COLLISION_AVOIDANCE}
      onKeyDown={pickHighlightedItemOnTab}
      side={side}
    >
      {children}
    </MenuPopup>
  </Menu>
);

type ContextMatter = {
  id: string;
  name: string;
  color: string | null;
};

const isWorkspaceMention = (
  option: ChatMentionOption,
): option is ChatWorkspaceMentionOption => option.category === "workspace";

/**
 * The provider's mention sources searched with the typed query: the open
 * matter's files, case law, and the local options merged in by the same
 * selector (`selectChatSuggestionItems`), so the Context list offers
 * everything a mention source registers. Settles over the same 150ms window
 * as the matter file search; an empty query searches nothing. The key is
 * scoped to the user, organization, thread and registration generation (see
 * `contextMentionSearchKey`).
 */
const useContextMentionSearch = ({
  open,
  organizationId,
  search,
  threadRef,
}: {
  open: boolean;
  organizationId: string;
  search: string;
  threadRef: ChatThreadRef;
}) => {
  const { getMentionItems, searchMentionItems } = useChatEditorManager();
  const registrationVersion = useChatEditorExtensionVersion();
  const { id: userId } = useAuthenticatedUser();
  const [query] = useDebounce(search.trim(), CHAT_MENTION_SEARCH_DEBOUNCE_MS);
  const enabled = open && query !== "";
  const mentionQuery = useQuery({
    queryKey: contextMentionSearchKey({
      organizationId,
      query,
      registrationVersion,
      threadKey: getChatThreadKey(threadRef),
      userId,
    }),
    queryFn: async () => {
      const [localItems, searchedItems] = await Promise.all([
        getMentionItems(),
        searchMentionItems(query),
      ]);
      return {
        items: selectChatSuggestionItems({
          localItems: localItems.items,
          query,
          searchedItems: searchedItems.items,
        }),
        failures: [...localItems.failures, ...searchedItems.failures],
      };
    },
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const view = useQueryView(mentionQuery, {
    isEmpty: (data) => data.items.length === 0 && data.failures.length === 0,
  });
  return {
    view,
    enabled,
    retry: mentionQuery.refetch,
    failures: enabled && view.type === "items" ? view.items.failures : [],
    results: enabled && view.type === "items" ? view.items.items : [],
    // Still settling: the debounce has not caught up with the field, or the
    // sources are answering.
    isSearching:
      search.trim() !== "" &&
      (query !== search.trim() || mentionQuery.isFetching),
  };
};

// Top level of the Context list: matters, each a nested hover-opening
// submenu (see `ComposerContextMatterSub`) rather than a selectable leaf —
// picking a matter row's own mention happens one level down, alongside its
// files, so the same click target isn't overloaded with "open the submenu"
// and "insert a mention" at once. A non-empty search also lists the mention
// sources' matches (files, case law) grouped by category, so a word typed
// after "@" finds what it names wherever it lives.
export const ComposerContextMenu = ({
  context,
  enabled,
  host,
}: {
  context: ComposerContextMenuProps;
  enabled: boolean;
  host: ComposerListHost;
}) => {
  const t = useTranslations();
  const { activeOrganizationId, editor, threadRef } = context;
  const { id: userId } = useAuthenticatedUser();
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const open = host.kind === "shortcut" ? host.open : submenuOpen;
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnOpen(open, searchRef);
  // Same navigation list `ChatMatterPicker` and the mention sources' matter
  // options read from — no dedicated endpoint for this submenu.
  const mattersQuery = useQuery({
    ...workspacesNavigationOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
    enabled,
  });
  const mattersView = useQueryView(mattersQuery, {
    isEmpty: (data) => data.workspaces.length === 0,
  });
  const matters: ContextMatter[] =
    mattersView.type === "items" ? mattersView.items.workspaces : [];
  const mentionSearch = useContextMentionSearch({
    open,
    organizationId: activeOrganizationId,
    search,
    threadRef,
  });

  const query = search.trim().toLowerCase();
  const filteredMatters = query
    ? matters.filter((matter) => matter.name.toLowerCase().includes(query))
    : matters;

  const handleOpenChange = (nextOpen: boolean) => {
    if (host.kind === "shortcut") {
      if (!nextOpen) {
        host.onClose();
      }
    } else {
      setSubmenuOpen(nextOpen);
    }
    if (!nextOpen) {
      setSearch("");
    }
  };
  const emptyLabel = () => {
    if (mentionSearch.isSearching) {
      return t("common.loading");
    }
    if (query !== "") {
      return t("common.noResults");
    }
    return t("chat.composerMenu.noMatters");
  };
  const label = t("chat.composerMenu.context");
  const content = (
    <>
      <ComposerSubmenuSearch
        onChange={setSearch}
        placeholder={t("chat.composerMenu.searchMatters")}
        ref={searchRef}
        trigger={searchTrigger(host, "context")}
        value={search}
      />
      {mentionSearch.failures.map((failure) => (
        <div key={`${failure.sourceId}:${failure.operation}`}>
          <BidiText as="span">{t(failure.labelKey)}</BidiText>
          <QueryViewFeedback
            view={{ type: "error", error: failure, retry: mentionSearch.retry }}
          />
        </div>
      ))}
      <ComposerQueryResults
        views={
          mentionSearch.enabled
            ? { matters: mattersView, mentions: mentionSearch.view }
            : { matters: mattersView }
        }
        hasItems={
          filteredMatters.length > 0 || mentionSearch.results.length > 0
        }
        empty={
          mentionSearch.failures.length === 0 ? (
            <ComposerSubmenuEmpty>{emptyLabel()}</ComposerSubmenuEmpty>
          ) : null
        }
      >
        <ComposerContextResults
          editor={editor}
          hasQuery={query !== ""}
          isSearching={mentionSearch.isSearching}
          matters={filteredMatters}
          mentions={mentionSearch.results}
          threadRef={threadRef}
        />
      </ComposerQueryResults>
    </>
  );

  if (host.kind === "shortcut") {
    return (
      <ComposerShortcutPopup
        anchor={host.anchor}
        label={label}
        onOpenChange={handleOpenChange}
        open={open}
        side={host.side}
      >
        {content}
      </ComposerShortcutPopup>
    );
  }
  return (
    <MenuSub onOpenChange={handleOpenChange} open={open}>
      <MenuSubTrigger
        {...guideAnchor(
          GUIDE_ANCHORS.chatMenuContext,
          host.guideAnchorsEnabled,
        )}
      >
        <AtSignIcon />
        {label}
      </MenuSubTrigger>
      <MenuSubPopup className="w-72" onKeyDown={pickHighlightedItemOnTab}>
        {content}
      </MenuSubPopup>
    </MenuSub>
  );
};

// The Context list's rows, grouped in the shared mention order. Matters come
// from the navigation list (every match, with its drill-down), plus any matter
// option a mention source adds that the list lacks; the other categories come
// from the mention search. Group labels appear once more than one group does.
const ComposerContextResults = ({
  editor,
  hasQuery,
  isSearching,
  matters,
  mentions,
  threadRef,
}: {
  editor: Editor | null;
  hasQuery: boolean;
  isSearching: boolean;
  matters: ContextMatter[];
  mentions: ChatMentionOption[];
  threadRef: ChatThreadRef;
}) => {
  const t = useTranslations();
  const categoryLabel = useMentionCategoryLabel();
  const matterIds = new Set(matters.map((matter) => matter.id));
  const sourcedMatters = mentions
    .filter(isWorkspaceMention)
    .filter((option) => !matterIds.has(option.resource.id))
    .map((option): ContextMatter => ({
      id: option.resource.id,
      name: option.label,
      color: null,
    }));

  const renderRows = (category: ChatReferenceCategory): React.ReactNode[] => {
    if (category === "workspace") {
      return [...matters, ...sourcedMatters].map((matter) => (
        <ComposerContextMatterSub
          editor={editor}
          key={matter.id}
          matter={matter}
          threadRef={threadRef}
        />
      ));
    }
    return mentions
      .filter((option) => option.category === category)
      .map((option) => (
        <ComposerMentionItem
          editor={editor}
          key={option.resource.id}
          option={option}
        />
      ));
  };
  const groups = MENTION_CATEGORY_ORDER.map((category) => ({
    category,
    rows: renderRows(category),
  })).filter((group) => group.rows.length > 0);

  if (groups.length === 0) {
    if (isSearching) {
      return <ComposerSubmenuEmpty>{t("common.loading")}</ComposerSubmenuEmpty>;
    }
    return (
      <ComposerSubmenuEmpty>
        {hasQuery ? t("common.noResults") : t("chat.composerMenu.noMatters")}
      </ComposerSubmenuEmpty>
    );
  }
  return (
    <>
      {groups.map((group) => (
        <MenuGroup key={group.category}>
          {groups.length > 1 && (
            <MenuGroupLabel>{categoryLabel(group.category)}</MenuGroupLabel>
          )}
          {group.rows}
        </MenuGroup>
      ))}
      {isSearching && (
        <ComposerSubmenuEmpty>{t("common.loading")}</ComposerSubmenuEmpty>
      )}
    </>
  );
};

// One mention option (a file or a decision) as a menu row: the same glyph and
// the same chip (`insertChatMention`) wherever the option was found.
const ComposerMentionItem = ({
  editor,
  option,
}: {
  editor: Editor | null;
  option: ChatMentionOption;
}) => (
  <MenuItem
    onClick={() => {
      if (!editor || editor.isDestroyed) {
        return;
      }
      insertChatMention(editor, option);
    }}
  >
    <MentionIcon mention={option} />
    <BidiText as="span" className="min-w-0 flex-1 truncate">
      {option.label}
    </BidiText>
  </MenuItem>
);

// One matter's nested submenu: a leading row to mention the matter itself
// (selecting the parent row only opens this submenu, so the matter-level
// mention needs its own target), then the matter's files — fetched lazily,
// only once this specific submenu opens, and scoped to the matter's first
// view like the workspace mention source (`getMentionViewScope`).
const ComposerContextMatterSub = ({
  editor,
  matter,
  threadRef,
}: {
  editor: Editor | null;
  matter: ContextMatter;
  threadRef: ChatThreadRef;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnOpen(open, searchRef);

  const {
    data: views,
    isError: viewsFailed,
    isPending: isLoadingViews,
  } = useQuery({
    ...viewsOptions(matter.id),
    enabled: open,
  });
  const activeView = views?.at(0) ?? null;
  const { filters, sorts } = useMemo(
    () => getMentionViewScope(activeView?.layout),
    [activeView?.layout],
  );
  // Same 150ms settle window as the workspace mention source's entity search
  // (`use-workspace-chat-mention-registration.ts`), so typing here produces
  // the same request cadence instead of a query per keystroke.
  const [debouncedSearch] = useDebounce(
    search.trim(),
    CHAT_MENTION_SEARCH_DEBOUNCE_MS,
  );
  const entitiesKey = useMemo(
    () => ({
      workspaceId: matter.id,
      filters,
      sorts,
      ...(debouncedSearch && { search: debouncedSearch }),
      pageSize: CHAT_MENTION_ENTITY_RESULT_LIMIT,
    }),
    [debouncedSearch, filters, matter.id, sorts],
  );
  const { data: entitiesData, isError: entitiesFailed } = useQuery({
    ...useEntitiesOptions(entitiesKey),
    enabled: open && views !== undefined,
  });

  // Only stamp a `sourceWorkspaceId` when the file's matter differs from the
  // thread's own workspace, so a same-matter mention stays byte-identical to
  // one picked in that matter's own chat.
  const sourceWorkspaceId =
    threadRef.scope === "workspace" && threadRef.workspaceId === matter.id
      ? undefined
      : matter.id;
  const fileOptions = useMemo<ChatMentionOption[]>(() => {
    if (!entitiesData) {
      return [];
    }
    return entitiesData.entities.map((entity) =>
      buildEntityMentionOption({
        entity,
        matterId: matter.id,
        sourceWorkspaceId,
      }),
    );
  }, [entitiesData, matter.id, sourceWorkspaceId]);
  const matterMentionOption = useMemo<ChatMentionOption | undefined>(
    () =>
      buildWorkspaceMentionOptions({
        workspaces: [{ id: matter.id, name: matter.name }],
        firstViewIdsByWorkspaceId: undefined,
      }).at(0),
    [matter.id, matter.name],
  );

  const renderFileOptions = () => {
    if (viewsFailed || entitiesFailed) {
      return (
        <ComposerSubmenuEmpty>
          {t("chat.mention.loadError")}
        </ComposerSubmenuEmpty>
      );
    }
    if (isLoadingViews || !entitiesData) {
      return <ComposerSubmenuEmpty>{t("common.loading")}</ComposerSubmenuEmpty>;
    }
    if (fileOptions.length === 0) {
      return (
        <ComposerSubmenuEmpty>
          {t("chat.composerMenu.noFiles")}
        </ComposerSubmenuEmpty>
      );
    }
    return fileOptions.map((option) => (
      <ComposerMentionItem
        editor={editor}
        key={option.resource.id}
        option={option}
      />
    ));
  };

  return (
    <MenuSub
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setSearch("");
        }
      }}
    >
      <MenuSubTrigger>
        <MatterIcon
          className="size-3.5 shrink-0"
          matter={{ id: matter.id, color: matter.color }}
        />
        <BidiText as="span" className="min-w-0 flex-1 truncate">
          {matter.name}
        </BidiText>
      </MenuSubTrigger>
      <MenuSubPopup className="w-72">
        <ComposerSubmenuSearch
          onChange={setSearch}
          placeholder={t("chat.composerMenu.searchFiles")}
          ref={searchRef}
          value={search}
        />
        {matterMentionOption && (
          <MenuItem
            onClick={() => {
              if (editor && !editor.isDestroyed) {
                insertChatMention(editor, matterMentionOption);
              }
            }}
          >
            <MatterIcon
              className="size-3.5 shrink-0"
              matter={{ id: matter.id, color: matter.color }}
            />
            <span className="min-w-0 flex-1">
              <BidiText as="span" className="block truncate text-sm">
                {matter.name}
              </BidiText>
              <BidiText
                as="span"
                className="text-muted-foreground block truncate text-xs"
              >
                {t("chat.composerMenu.referenceMatter")}
              </BidiText>
            </span>
          </MenuItem>
        )}
        <MenuSeparator />
        {renderFileOptions()}
      </MenuSubPopup>
    </MenuSub>
  );
};

export const ComposerMcpSubmenu = ({
  enabled,
  guideAnchorsEnabled,
  mcp,
}: {
  enabled: boolean;
  guideAnchorsEnabled: boolean;
  mcp: { activeOrganizationId: string };
}) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = mcp;
  const { id: userId } = useAuthenticatedUser();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnOpen(open, searchRef);
  const connectorsQuery = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled,
  });
  const connectionsQuery = useQuery({
    ...mcpConnectionsOptions(activeOrganizationId, userId),
    enabled,
  });
  const connectorsView = useQueryView(connectorsQuery, {
    isEmpty: (data) => data.connectors.length === 0,
  });
  const connectionsView = useQueryView(connectionsQuery, {
    isEmpty: (data) => data.connections.length === 0,
  });
  const connectorsData =
    connectorsView.type === "items" ? connectorsView.items : undefined;
  const connectionsData =
    connectionsView.type === "items" ? connectionsView.items : undefined;

  const connectionBySlug = useMemo(() => {
    const map = new Map<
      string,
      NonNullable<typeof connectionsData>["connections"][number]
    >();
    if (connectionsData) {
      for (const connection of connectionsData.connections) {
        map.set(connection.connectorSlug, connection);
      }
    }
    return map;
  }, [connectionsData]);

  const query = search.trim().toLowerCase();
  const connectors = connectorsData ? connectorsData.connectors : [];
  const rows = query
    ? connectors.filter((connector) =>
        connector.displayName.toLowerCase().includes(query),
      )
    : connectors;

  const openMcpSettings = () => {
    detached(
      navigate({ to: "/knowledge/tools", search: { kind: "mcp" } }),
      "composer-plus-menu.navigate",
    );
  };

  const handleToggle = async (connectionId: string, nextEnabled: boolean) => {
    const result = await Result.tryPromise(async () => {
      const response = await api.mcp
        .connections({
          connectionId: toSafeId<"mcpUserConnection">(connectionId),
        })
        .patch({ enabled: nextEnabled });
      return unwrapEden(response);
    });
    if (Result.isError(result)) {
      notifyUserError(result.error, t("common.somethingWentWrong"));
      return;
    }
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.mcp.connections(activeOrganizationId, userId),
      }),
      "composer-plus-menu.invalidate",
    );
  };

  let mcpRowsContent: React.ReactNode;
  if (connectorsView.type === "pending" || connectionsView.type === "pending") {
    mcpRowsContent = (
      <ComposerSubmenuEmpty>{t("common.loading")}</ComposerSubmenuEmpty>
    );
  } else if (rows.length === 0) {
    mcpRowsContent = (
      <ComposerSubmenuEmpty>
        {t("chat.composerMenu.noMcpServers")}
      </ComposerSubmenuEmpty>
    );
  } else {
    mcpRowsContent = rows.map((connector) => {
      const connection = connectionBySlug.get(connector.slug);
      if (!connection) {
        return (
          <MenuItem key={connector.id} onClick={openMcpSettings}>
            <BidiText as="span" className="truncate">
              {connector.displayName}
            </BidiText>
          </MenuItem>
        );
      }
      return (
        <MenuCheckboxItem
          checked={connection.enabled}
          closeOnClick={false}
          key={connector.id}
          onClick={() => {
            detached(
              handleToggle(connection.id, !connection.enabled),
              "composer-plus-menu.toggle",
            );
          }}
        >
          <BidiText as="span" className="truncate">
            {connector.displayName}
          </BidiText>
        </MenuCheckboxItem>
      );
    });
  }

  return (
    <MenuSub
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setSearch("");
        }
      }}
    >
      <MenuSubTrigger
        {...guideAnchor(GUIDE_ANCHORS.chatMenuMcp, guideAnchorsEnabled)}
      >
        <ServerIcon />
        {t("chat.composerMenu.mcpServers")}
      </MenuSubTrigger>
      <MenuSubPopup className="w-64">
        <ComposerSubmenuSearch
          onChange={setSearch}
          placeholder={t("chat.composerMenu.searchMcpServers")}
          ref={searchRef}
          value={search}
        />
        <ComposerQueryResults
          views={{ connectors: connectorsView, connections: connectionsView }}
          hasItems={rows.length > 0}
          empty={mcpRowsContent}
        >
          {mcpRowsContent}
        </ComposerQueryResults>
        <MenuSeparator />
        <MenuItem onClick={openMcpSettings}>
          {t("chat.composerMenu.openMcpSettings")}
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
};
