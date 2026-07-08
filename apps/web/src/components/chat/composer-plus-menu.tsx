import { useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Ref } from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Editor } from "@tiptap/core";
import { Result } from "better-result";
import {
  BookOpenIcon,
  CpuIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { PROVIDER_LABELS } from "@/components/ai-config-role-models.logic";
import {
  buildChatSlashItems,
  commandShortcutRowsFromSkillPages,
} from "@/components/chat-editor-slash-items";
import { insertPastedTextChip } from "@/components/chat-pasted-text-extension";
import { slashItemChipAttrs } from "@/components/chat/prompt-slash-extension";
import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";
import { modelOptionsOptions } from "@/routes/_protected.chat/-queries";
import {
  knowledgeKeys,
  mcpConnectionsOptions,
  mcpConnectorsOptions,
  skillsOptions,
} from "@/routes/_protected.knowledge/-queries";

/** Enables and drives the Models submenu. Omit on surfaces without a model
 *  picker (the API expects a per-thread `PATCH .../model` target). */
export type ComposerModelsMenuProps = {
  activeOrganizationId: string;
  threadRef: ChatThreadRef;
  /** Current per-thread override ("provider::modelId"), or null when the
   *  thread uses the org default. */
  selectedModel: string | null;
  /** Called after a successful PATCH so the caller can update its cached
   *  thread data or draft meta. */
  onModelChange: (model: string | null) => void;
};

/** Enables and drives the Skills submenu. Reuses the same data source and
 *  chip content as the composer's `/` slash menu. */
export type ComposerSkillsMenuProps = {
  activeOrganizationId: string;
  editor: Editor | null;
};

type ComposerPlusMenuProps = {
  disabled: boolean;
  onOpenFilePicker: () => void;
  models?: ComposerModelsMenuProps | undefined;
  skills?: ComposerSkillsMenuProps | undefined;
  /** Enables the MCP Servers submenu; omit on surfaces without a tools
   *  catalogue link. */
  mcp?: { activeOrganizationId: string } | undefined;
  /** Positioning for the trigger button, differing per slot: absolute on the
   *  empty placeholder line, `me-auto` at the start of the bottom action row. */
  triggerClassName?: string | undefined;
  /**
   * Fired when the menu closes (Escape, outside click, or a selection) after
   * having been opened programmatically via the imperative handle's
   * `openSkills()` — the "/" trigger on chat surfaces with a Skills submenu.
   * Never fired for a menu opened through the ordinary (+) click/hover path.
   * Lets the caller return focus to the editor instead of Base UI's default
   * post-close focus target (the trigger button).
   */
  onSlashMenuClose?: (() => void) | undefined;
  ref?: Ref<ComposerPlusMenuHandle>;
};

/** Imperative handle exposing the "/"-trigger entry point: opens the (+)
 *  menu with the Skills submenu already open and its search input focused,
 *  without requiring a real hover/click sequence. */
export type ComposerPlusMenuHandle = {
  openSkills: () => void;
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
  onOpenFilePicker,
  models,
  skills,
  mcp,
  triggerClassName,
  onSlashMenuClose,
  ref,
}: ComposerPlusMenuProps) => {
  const t = useTranslations();
  const [menuOpen, setMenuOpen] = useState(false);
  const [skillsSubmenuOpen, setSkillsSubmenuOpen] = useState(false);
  // Set only by `openSkills()` below; consulted (and cleared) the next time
  // the root menu closes, so only a "/"-triggered open reroutes focus back
  // to the editor on close — an ordinary (+) click/Escape still falls back
  // to Base UI's default (return focus to the trigger button).
  const openedViaSlashRef = useRef(false);

  useImperativeHandle(ref, () => ({
    openSkills: () => {
      openedViaSlashRef.current = true;
      setMenuOpen(true);
      setSkillsSubmenuOpen(true);
    },
  }));

  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (open) {
      return;
    }
    setSkillsSubmenuOpen(false);
    if (openedViaSlashRef.current) {
      openedViaSlashRef.current = false;
      onSlashMenuClose?.();
    }
  };

  return (
    <Menu onOpenChange={handleMenuOpenChange} open={menuOpen}>
      <MenuTrigger
        aria-label={t("chat.composerMenu.open")}
        disabled={disabled}
        render={
          <Button
            className={cn(
              "border-border size-7 shrink-0 rounded-full border",
              triggerClassName,
            )}
            size="icon-xs"
            type="button"
            variant="secondary"
          />
        }
      >
        <PlusIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuItem onClick={onOpenFilePicker}>
          <PaperclipIcon />
          {t("chat.attachFile")}
        </MenuItem>
        {models && <ComposerModelsSubmenu enabled={menuOpen} models={models} />}
        {skills && (
          <ComposerSkillsSubmenu
            enabled={menuOpen}
            onOpenChange={setSkillsSubmenuOpen}
            open={skillsSubmenuOpen}
            skills={skills}
          />
        )}
        {mcp && <ComposerMcpSubmenu enabled={menuOpen} mcp={mcp} />}
      </MenuPopup>
    </Menu>
  );
};

// Base UI's Menu intercepts keystrokes for typeahead and arrow-key
// navigation, which would hijack typing in a nested search input. Every
// submenu's search field stops propagation for all keys except the ones
// the menu still needs: Escape to close, Up/Down to move the highlight,
// Enter to activate the highlighted item.
const MENU_NAV_KEYS = new Set(["Escape", "ArrowDown", "ArrowUp", "Enter"]);

type ComposerSubmenuSearchProps = {
  onChange: (value: string) => void;
  placeholder: string;
  ref: React.RefObject<HTMLInputElement | null>;
  value: string;
};

const ComposerSubmenuSearch = ({
  onChange,
  placeholder,
  ref,
  value,
}: ComposerSubmenuSearchProps) => (
  <div className="px-2 pt-1.5 pb-2">
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (!MENU_NAV_KEYS.has(event.key)) {
            event.stopPropagation();
          }
        }}
        placeholder={placeholder}
        ref={ref}
        size="sm"
        value={value}
      />
    </InputGroup>
  </div>
);

const ComposerSubmenuEmpty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-muted-foreground px-2.5 py-2 text-xs">{children}</p>
);

/** Deferred focus: Base UI's own focus-trap logic runs first when a
 *  submenu opens, so a plain `autoFocus` on the input loses the race. */
const focusSearchOnOpen = (ref: React.RefObject<HTMLInputElement | null>) => {
  setTimeout(() => ref.current?.focus(), 0);
};

const ComposerModelsSubmenu = ({
  enabled,
  models,
}: {
  enabled: boolean;
  models: ComposerModelsMenuProps;
}) => {
  const t = useTranslations();
  const { activeOrganizationId, threadRef, selectedModel, onModelChange } =
    models;
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const { data } = useQuery({
    ...modelOptionsOptions(activeOrganizationId),
    enabled,
  });

  const rows = useMemo(() => {
    const allRows = [
      { value: "", label: t("chat.modelSelector.defaultLabel") },
      ...(data?.options ?? []).map((option) => ({
        value: option.value,
        label: `${PROVIDER_LABELS[option.provider]} · ${option.modelId}`,
      })),
    ];
    const query = search.trim().toLowerCase();
    if (!query) {
      return allRows;
    }
    return allRows.filter((row) => row.label.toLowerCase().includes(query));
  }, [data?.options, search, t]);

  const handleSelect = async (value: string) => {
    const model = value === "" ? null : value;
    if (model === selectedModel) {
      return;
    }
    const result = await Result.tryPromise(
      async () =>
        await api.chat
          .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
          .model.patch(
            { model },
            {
              query:
                threadRef.scope === "workspace"
                  ? {
                      workspaceId: toSafeId<"workspace">(threadRef.workspaceId),
                    }
                  : {},
            },
          ),
    );
    if (Result.isError(result) || result.value.error) {
      stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
      return;
    }
    onModelChange(model);
  };

  return (
    <MenuSub
      onOpenChange={(open) => {
        if (open) {
          focusSearchOnOpen(searchRef);
        } else {
          setSearch("");
        }
      }}
    >
      <MenuSubTrigger>
        <CpuIcon />
        {t("chat.composerMenu.models")}
      </MenuSubTrigger>
      <MenuSubPopup className="w-64">
        <ComposerSubmenuSearch
          onChange={setSearch}
          // Reuses the AI-config role-model picker's placeholder (same
          // wording, same purpose) instead of adding a duplicate key.
          placeholder={t("organization.aiConfig.modelIdPlaceholder")}
          ref={searchRef}
          value={search}
        />
        <MenuRadioGroup value={selectedModel ?? ""}>
          {rows.map((row) => (
            <MenuRadioItem
              key={row.value || "default"}
              onClick={() => {
                void handleSelect(row.value);
              }}
              value={row.value}
            >
              <span className="truncate">{row.label}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
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

/** Secondary, muted line under an item's name — mirrors the `/`-suggestion
 *  list's row shape (prompt body / skill description) so both surfaces
 *  read as one consistent picker. This submenu's items never include
 *  reserved commands (`buildChatSlashItems` is called without
 *  `includeReservedCommands`), so the command branch is unreachable here
 *  but kept for exhaustiveness with `SlashItem`. */
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
  onOpenChange,
  open,
  skills,
}: {
  enabled: boolean;
  /** Controlled open state so the "/" trigger can force this specific
   *  submenu open alongside the root menu (see `ComposerPlusMenuHandle`). */
  onOpenChange: (open: boolean) => void;
  open: boolean;
  skills: ComposerSkillsMenuProps;
}) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const { activeOrganizationId, editor } = skills;
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      ...skillsOptions(activeOrganizationId),
      enabled,
    });

  useExternalSyncEffect(() => {
    if (!enabled || !hasNextPage || isFetchingNextPage) {
      return;
    }
    void fetchNextPage();
  }, [enabled, fetchNextPage, hasNextPage, isFetchingNextPage]);

  const shortcutRows = useMemo(
    () => commandShortcutRowsFromSkillPages(data?.pages),
    [data?.pages],
  );
  // `includeReservedCommands` defaults to false, so `/new` and `/model`
  // never appear here — only saved prompts and enabled skills.
  const items = useMemo(
    () =>
      buildChatSlashItems({ shortcuts: shortcutRows, skillPages: data?.pages }),
    [shortcutRows, data?.pages],
  );

  const query = search.trim().toLowerCase();
  const filteredItems = query
    ? items.filter((item) => itemName(item).toLowerCase().includes(query))
    : items;

  const handleSelect = (item: SlashItem) => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    insertPastedTextChip(editor, slashItemChipAttrs(item));
  };

  return (
    <MenuSub
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (nextOpen) {
          focusSearchOnOpen(searchRef);
        } else {
          setSearch("");
        }
      }}
      open={open}
    >
      <MenuSubTrigger>
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
        {filteredItems.length === 0 ? (
          <ComposerSubmenuEmpty>
            {t("chat.composerMenu.noSkills")}
          </ComposerSubmenuEmpty>
        ) : (
          filteredItems.map((item) => (
            <MenuItem
              key={itemKey(item)}
              onClick={() => {
                handleSelect(item);
              }}
            >
              <BookOpenIcon className="self-start" />
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
          ))
        )}
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            void navigate({
              to: "/knowledge/tools",
              search: { kind: "skill" },
            });
          }}
        >
          {t("chat.composerMenu.openSkills")}
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
};

const ComposerMcpSubmenu = ({
  enabled,
  mcp,
}: {
  enabled: boolean;
  mcp: { activeOrganizationId: string };
}) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = mcp;
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const { data: connectorsData } = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled,
  });
  const { data: connectionsData } = useQuery({
    ...mcpConnectionsOptions(activeOrganizationId),
    enabled,
  });

  const connectionBySlug = useMemo(() => {
    const map = new Map<
      string,
      NonNullable<typeof connectionsData>["connections"][number]
    >();
    for (const connection of connectionsData?.connections ?? []) {
      map.set(connection.connectorSlug, connection);
    }
    return map;
  }, [connectionsData?.connections]);

  const query = search.trim().toLowerCase();
  const connectors = connectorsData?.connectors ?? [];
  const rows = query
    ? connectors.filter((connector) =>
        connector.displayName.toLowerCase().includes(query),
      )
    : connectors;

  const openMcpSettings = () => {
    void navigate({ to: "/knowledge/tools", search: { kind: "mcp" } });
  };

  const handleToggle = async (connectionId: string, nextEnabled: boolean) => {
    const result = await Result.tryPromise(
      async () =>
        await api.mcp
          .connections({
            connectionId: toSafeId<"mcpUserConnection">(connectionId),
          })
          .patch({ enabled: nextEnabled, queryKey: ["mcp"] }),
    );
    if (Result.isError(result) || result.value.error) {
      stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.mcp.connections(activeOrganizationId),
    });
  };

  return (
    <MenuSub
      onOpenChange={(open) => {
        if (open) {
          focusSearchOnOpen(searchRef);
        } else {
          setSearch("");
        }
      }}
    >
      <MenuSubTrigger>
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
        {rows.length === 0 ? (
          <ComposerSubmenuEmpty>
            {t("chat.composerMenu.noMcpServers")}
          </ComposerSubmenuEmpty>
        ) : (
          rows.map((connector) => {
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
                  void handleToggle(connection.id, !connection.enabled);
                }}
              >
                <BidiText as="span" className="truncate">
                  {connector.displayName}
                </BidiText>
              </MenuCheckboxItem>
            );
          })
        )}
        <MenuSeparator />
        <MenuItem onClick={openMcpSettings}>
          {t("chat.composerMenu.openMcpSettings")}
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
};
