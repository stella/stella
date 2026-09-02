import { useMemo, useRef, useState } from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Editor } from "@tiptap/core";
import { Result } from "better-result";
import {
  AtSignIcon,
  BookOpenIcon,
  CpuIcon,
  PaperclipIcon,
  PlusIcon,
  ServerIcon,
} from "lucide-react";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { COMPOSER_CONTROL_BUTTON_SIZE } from "@stll/ui/composer";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  buildChatSlashItems,
  commandShortcutRowsFromSkillPages,
} from "@/components/chat-editor-slash-items";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import {
  buildEntityMentionOption,
  buildWorkspaceMentionOptions,
  CHAT_MENTION_ENTITY_RESULT_LIMIT,
  CHAT_MENTION_SEARCH_DEBOUNCE_MS,
  getMentionViewScope,
  insertChatMention,
} from "@/components/chat-mention-helpers";
import { MentionIcon } from "@/components/chat-mention-list";
import { insertPastedTextChip } from "@/components/chat-pasted-text-extension";
import {
  CHAT_MODEL_MENU_POPUP_CLASS_NAME,
  ChatModelOptionsMenu,
  type ComposerModelsMenuProps,
} from "@/components/chat/chat-model-options-menu";
import {
  COMPOSER_MENU_SHORTCUT,
  resolveComposerMenuShortcut,
  shouldDrainSkillPages,
} from "@/components/chat/composer-plus-menu.logic";
import {
  ComposerSubmenuSearch,
  useFocusSearchOnOpen,
} from "@/components/chat/composer-submenu-search";
import { slashItemChipAttrs } from "@/components/chat/prompt-slash-extension";
import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import { MatterIcon } from "@/components/matter-icon";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import {
  knowledgeKeys,
  mcpConnectionsOptions,
  mcpConnectorsOptions,
  skillsOptions,
} from "@/lib/knowledge/queries";
import type { ReservedChatCommandContext } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { useEntitiesOptions } from "@/lib/workspaces/queries/entities";
import { viewsOptions } from "@/lib/workspaces/queries/views";

/** Enables and drives the Skills submenu. Reuses the same data source and
 *  chip content as the composer's `/` slash menu. */
export type ComposerSkillsMenuProps = {
  activeOrganizationId: string;
  editor: Editor | null;
  reservedCommands?: ReservedChatCommandContext | null | undefined;
};

/** Enables and drives the Context submenu: reference a matter, or a file
 *  inside one, as a mention chip. Reuses the same matter/entity data
 *  sources and the same mention-chip shape as the "@" suggestion popover. */
export type ComposerContextMenuProps = {
  activeOrganizationId: string;
  editor: Editor | null;
  /** Scopes an inserted file/matter mention's `sourceWorkspaceId`: omitted
   *  when the referenced matter is already the thread's own workspace,
   *  mirroring the "@" popover's cross-matter bookkeeping. */
  threadRef: ChatThreadRef;
};

type ComposerPlusMenuProps = {
  disabled: boolean;
  guideAnchorsEnabled?: boolean;
  onOpenFilePicker: () => void;
  models?: ComposerModelsMenuProps | undefined;
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
// carrying attach / models / skills / MCP actions, the latter three as
// hover-opening submenus (Cursor's (+) pattern). Shared by every chat surface
// so the affordance can never drift; each submenu appears only when the
// surface passes the matching prop. The three submenus' list queries are
// gated on the root menu's open state, so opening (+) — not mounting the
// composer — is what triggers the fetches.
export const ComposerPlusMenu = ({
  disabled,
  guideAnchorsEnabled = false,
  onOpenFilePicker,
  models,
  skills,
  context,
  mcp,
  triggerClassName,
}: ComposerPlusMenuProps) => {
  const t = useTranslations();
  const [menuOpen, setMenuOpen] = useState(false);
  const [skillsSubmenuOpen, setSkillsSubmenuOpen] = useState(false);
  const [contextSubmenuOpen, setContextSubmenuOpen] = useState(false);
  // Set only by the editor shortcut listener below; consulted (and cleared)
  // the next time the root menu closes, so only a "/" or "@"-triggered open
  // reroutes focus back to the editor. An ordinary (+) click/Escape keeps
  // Base UI's default of returning focus to the trigger button.
  const openedProgrammaticallyRef = useRef(false);
  const shortcutEditor = skills?.editor ?? context?.editor ?? null;
  const hasSkillsShortcut = skills !== undefined;
  const hasContextShortcut = context !== undefined;

  // The menu owns its editor shortcuts. Any composer that renders a Skills
  // submenu therefore gets the same "/" behavior at any cursor position
  // without a second surface-level key handler that can drift. The slash is
  // consumed here and the unified Skills submenu owns filtering.
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
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        hasContext: hasContextShortcut,
        hasSkills: hasSkillsShortcut,
        isAltGraph: event.getModifierState("AltGraph"),
        isComposing: event.isComposing,
        isEditorEmpty: shortcutEditor.isEmpty,
        key: event.key,
        metaKey: event.metaKey,
      });
      if (!shortcut) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      openedProgrammaticallyRef.current = true;
      setMenuOpen(true);
      if (shortcut === COMPOSER_MENU_SHORTCUT.skills) {
        setSkillsSubmenuOpen(true);
      } else {
        setContextSubmenuOpen(true);
      }
    };

    editorElement.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      editorElement.removeEventListener("keydown", handleKeyDown, {
        capture: true,
      });
    };
  }, [disabled, hasContextShortcut, hasSkillsShortcut, shortcutEditor]);

  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (open) {
      return;
    }
    setSkillsSubmenuOpen(false);
    setContextSubmenuOpen(false);
    if (openedProgrammaticallyRef.current) {
      openedProgrammaticallyRef.current = false;
      if (shortcutEditor && !shortcutEditor.isDestroyed) {
        shortcutEditor.commands.focus();
      }
    }
  };

  return (
    <Menu onOpenChange={handleMenuOpenChange} open={menuOpen}>
      <MenuTrigger
        aria-label={t("chat.composerMenu.open")}
        disabled={disabled}
        render={
          <Button
            {...guideAnchor(GUIDE_ANCHORS.chatToolsButton, guideAnchorsEnabled)}
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
        {skills && (
          <ComposerSkillsSubmenu
            enabled={menuOpen}
            guideAnchorsEnabled={guideAnchorsEnabled}
            onOpenChange={setSkillsSubmenuOpen}
            open={skillsSubmenuOpen}
            skills={skills}
          />
        )}
        {context && (
          <ComposerContextSubmenu
            context={context}
            enabled={menuOpen}
            guideAnchorsEnabled={guideAnchorsEnabled}
            onOpenChange={setContextSubmenuOpen}
            open={contextSubmenuOpen}
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
  );
};

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

const ComposerSkillsSubmenu = ({
  enabled,
  guideAnchorsEnabled,
  onOpenChange,
  open,
  skills,
}: {
  enabled: boolean;
  guideAnchorsEnabled: boolean;
  /** Controlled open state so the "/" trigger can force this specific
   *  submenu open alongside the root menu. */
  onOpenChange: (open: boolean) => void;
  open: boolean;
  skills: ComposerSkillsMenuProps;
}) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const { activeOrganizationId, editor, reservedCommands } = skills;
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnOpen(open, searchRef);
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending: isLoadingSkills,
  } = useInfiniteQuery({
    ...skillsOptions(activeOrganizationId),
    enabled,
  });

  const shortcutRows = useMemo(
    () => commandShortcutRowsFromSkillPages(data?.pages),
    [data?.pages],
  );
  const items = useMemo(
    () =>
      buildChatSlashItems({
        shortcuts: shortcutRows,
        skillPages: data?.pages,
        reservedCommands: reservedCommands ?? null,
      }),
    [reservedCommands, shortcutRows, data?.pages],
  );

  const query = search.trim().toLowerCase();
  useExternalSyncEffect(() => {
    if (
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
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, open, query]);

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
  if (isLoadingSkills) {
    skillItemsContent = (
      <ComposerSubmenuEmpty>{t("common.loading")}</ComposerSubmenuEmpty>
    );
  } else if (
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
      <MenuItem
        key={itemKey(item)}
        onClick={() => {
          handleSelect(item);
        }}
      >
        <BookOpenIcon className="mt-0.5 self-start" />
        <span className="min-w-0 flex-1">
          <BidiText as="span" className="block truncate text-sm">
            {itemName(item)}
          </BidiText>
          <BidiText
            as="span"
            className="text-muted-foreground block truncate text-xs"
          >
            {itemSecondary(item)}
          </BidiText>
        </span>
      </MenuItem>
    ));
  }

  return (
    <MenuSub
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          setSearch("");
        }
      }}
      open={open}
    >
      <MenuSubTrigger
        {...guideAnchor(GUIDE_ANCHORS.chatMenuSkills, guideAnchorsEnabled)}
      >
        <BookOpenIcon />
        {/* Reuses the chat landing page's "Skills" section label (same
            value) instead of adding a duplicate key. */}
        {t("chat.landing.prompts")}
      </MenuSubTrigger>
      <MenuSubPopup className="w-72">
        <ComposerSubmenuSearch
          onChange={setSearch}
          placeholder={t("chat.composerMenu.searchSkills")}
          ref={searchRef}
          value={search}
        />
        {skillItemsContent}
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
      </MenuSubPopup>
    </MenuSub>
  );
};

type ContextMatter = {
  id: string;
  name: string;
  color: string | null;
};

// Top level of the Context submenu: search-filtered matters, each a nested
// hover-opening submenu (see `ComposerContextMatterSub`) rather than a
// selectable leaf — picking a matter row's own mention happens one level
// down, alongside its files, so the same click target isn't overloaded with
// "open the submenu" and "insert a mention" at once. Kept to one kind
// (files) for now; other referenceable kinds (tasks, etc.) would slot in
// next to `ComposerContextMatterSub`'s file list without changing this
// level's shape.
const ComposerContextSubmenu = ({
  context,
  enabled,
  guideAnchorsEnabled,
  onOpenChange,
  open,
}: {
  context: ComposerContextMenuProps;
  enabled: boolean;
  guideAnchorsEnabled: boolean;
  /** Controlled open state so the "@" trigger can force this specific
   *  submenu open alongside the root menu. */
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const t = useTranslations();
  const { activeOrganizationId, editor, threadRef } = context;
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnOpen(open, searchRef);
  // Same navigation list `ChatMatterPicker` and the "@" popover's workspace
  // mentions read from — no dedicated endpoint for this submenu.
  const { data } = useQuery({
    ...workspacesNavigationOptions(activeOrganizationId),
    enabled,
  });
  const matters: ContextMatter[] = data ? data.workspaces : [];

  const query = search.trim().toLowerCase();
  const filteredMatters = query
    ? matters.filter((matter) => matter.name.toLowerCase().includes(query))
    : matters;

  return (
    <MenuSub
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          setSearch("");
        }
      }}
      open={open}
    >
      <MenuSubTrigger
        {...guideAnchor(GUIDE_ANCHORS.chatMenuContext, guideAnchorsEnabled)}
      >
        <AtSignIcon />
        {t("chat.composerMenu.context")}
      </MenuSubTrigger>
      <MenuSubPopup className="w-72">
        <ComposerSubmenuSearch
          onChange={setSearch}
          placeholder={t("chat.composerMenu.searchMatters")}
          ref={searchRef}
          value={search}
        />
        {filteredMatters.length === 0 ? (
          <ComposerSubmenuEmpty>
            {t("chat.composerMenu.noMatters")}
          </ComposerSubmenuEmpty>
        ) : (
          filteredMatters.map((matter) => (
            <ComposerContextMatterSub
              editor={editor}
              key={matter.id}
              matter={matter}
              threadRef={threadRef}
            />
          ))
        )}
      </MenuSubPopup>
    </MenuSub>
  );
};

// One matter's nested submenu: a leading row to mention the matter itself
// (selecting the parent row only opens this submenu, so the matter-level
// mention needs its own target), then the matter's files — fetched lazily,
// only once this specific submenu opens, and scoped to the matter's first
// view exactly like the "@" popover's workspace drill-down
// (`loadWorkspaceEntities` in chat-editor-provider.tsx).
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

  const { data: views, isPending: isLoadingViews } = useQuery({
    ...viewsOptions(matter.id),
    enabled: open,
  });
  const activeView = views?.at(0) ?? null;
  const { filters, sorts } = useMemo(
    () => getMentionViewScope(activeView?.layout),
    [activeView?.layout],
  );
  // Same 150ms settle window as the "@" popover's entity search
  // (`debouncedSearchEntities` in chat-editor-provider.tsx), so typing here
  // produces the same request cadence instead of a query per keystroke.
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
  const { data: entitiesData } = useQuery({
    ...useEntitiesOptions(entitiesKey),
    enabled: open && views !== undefined,
  });

  // Cross-matter bookkeeping mirrors `fetchWorkspaceEntities`: only stamp a
  // `sourceWorkspaceId` when the file's matter differs from the thread's own
  // workspace, so a same-matter mention stays byte-identical to one typed
  // via "@" in that matter's own chat.
  const sourceWorkspaceId =
    threadRef.scope === "workspace" && threadRef.workspaceId === matter.id
      ? undefined
      : matter.id;
  const fileOptions = useMemo<ChatMentionOption[]>(() => {
    if (!entitiesData) {
      return [];
    }
    return entitiesData.entities.map((entity) =>
      buildEntityMentionOption({ entity, sourceWorkspaceId }),
    );
  }, [entitiesData, sourceWorkspaceId]);
  const matterMentionOption = useMemo<ChatMentionOption | undefined>(
    () =>
      buildWorkspaceMentionOptions({
        workspaces: [{ id: matter.id, name: matter.name }],
        firstViewIdsByWorkspaceId: undefined,
      }).at(0),
    [matter.id, matter.name],
  );

  const handleSelect = (option: ChatMentionOption) => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    insertChatMention(editor, option);
  };

  const renderFileOptions = () => {
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
      <MenuItem
        key={option.resource.id}
        onClick={() => {
          handleSelect(option);
        }}
      >
        <MentionIcon mention={option} />
        <BidiText as="span" className="min-w-0 flex-1 truncate">
          {option.label}
        </BidiText>
      </MenuItem>
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
              handleSelect(matterMentionOption);
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

const ComposerMcpSubmenu = ({
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
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnOpen(open, searchRef);
  const { data: connectorsData, isPending: isLoadingConnectors } = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled,
  });
  const { data: connectionsData, isPending: isLoadingConnections } = useQuery({
    ...mcpConnectionsOptions(activeOrganizationId),
    enabled,
  });

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
      stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
      return;
    }
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.mcp.connections(activeOrganizationId),
      }),
      "composer-plus-menu.invalidate",
    );
  };

  let mcpRowsContent: React.ReactNode;
  if (isLoadingConnectors || isLoadingConnections) {
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
        {mcpRowsContent}
        <MenuSeparator />
        <MenuItem onClick={openMcpSettings}>
          {t("chat.composerMenu.openMcpSettings")}
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
};
