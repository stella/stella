import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { preserveOffsetOnSource } from "@atlaskit/pragmatic-drag-and-drop/utils/preserve-offset-on-source";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ClipboardIcon,
  CopyPlusIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderInputIcon,
  FolderPlusIcon,
  LockKeyholeIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SearchIcon,
  ShieldAlertIcon,
  TagsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";
import { StellaMark } from "@stll/ui/stella-mark";
import { cn } from "@stll/ui/utils";

import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import {
  CLIPBOARD_ITEM_DRAG_TYPE,
  clipboardContextMenuPosition,
  clipboardDraggedItemId,
  clipboardSourceTintIndex,
  filterClipboardItems,
  formatClipboardAge,
  highlightClipboardText,
  isClipboardCopyShortcut,
  nextClipboardIndex,
  quickCopyIndex,
} from "./clipboard-logic";
import { isClipboardSnapshot } from "./clipboard-types";
import type {
  ClipboardCaptureStatus,
  ClipboardGroup,
  ClipboardGroupColor,
  ClipboardItem,
  ClipboardSnapshot,
  ClipboardSourceAppVisual,
} from "./clipboard-types";

const CLIPBOARD_GROUP_COLORS = [
  "gray",
  "blue",
  "emerald",
  "amber",
  "rose",
  "violet",
] as const satisfies readonly ClipboardGroupColor[];

const CLIPBOARD_GROUP_ACCENTS = {
  amber: "var(--color-amber-400)",
  blue: "var(--color-blue-400)",
  emerald: "var(--color-emerald-400)",
  gray: "var(--color-neutral-400)",
  rose: "var(--color-rose-400)",
  violet: "var(--color-violet-400)",
} as const satisfies Record<ClipboardGroupColor, string>;

const STELLA_WEB_APP_URL = "https://my.stll.app";
const MAX_GROUP_NAME_CHARACTERS = 64;
const CLIPBOARD_CARD_SELECTOR = "[data-clipboard-id]";
const CLIPBOARD_GROUP_DROP_SELECTOR = "[data-clipboard-group-id]";
const CLIPBOARD_NO_GROUP_DROP_ID = "__no_group__";
const PRIMARY_MODIFIER_LABEL = navigator.userAgent.includes("Mac")
  ? "⌘"
  : "Ctrl+";

const EMPTY_SNAPSHOT = {
  captureStatus: "active",
  groups: [],
  items: [],
  persistence: { status: "initializing" },
  sourceAppVisuals: [],
} satisfies ClipboardSnapshot;

const focusTimeline = (node: HTMLDivElement | null) => {
  if (node && document.activeElement === document.body) {
    node.focus();
  }
};

const scrollCardIntoView = (id: string) => {
  requestAnimationFrame(() => {
    document
      .querySelector(`[data-clipboard-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
  });
};

const focusCard = (id: string) => {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(
        `[data-clipboard-id="${CSS.escape(id)}"] [data-clipboard-card-trigger]`,
      )
      ?.focus();
  });
};

type ClipboardCardProps = {
  active: boolean;
  ageReferenceTime: number;
  dragging: boolean;
  groupColor: ClipboardGroupColor | null;
  groupName: string | null;
  index: number;
  item: ClipboardItem;
  onOpenMenu: (
    event: ReactMouseEvent<HTMLElement>,
    item: ClipboardItem,
    index: number,
  ) => void;
  onCopy: (item: ClipboardItem) => void;
  onSelect: (index: number) => void;
  query: string;
  sourceVisual: ClipboardSourceAppVisual | null;
};

type ClipboardCardStyle = CSSProperties & {
  "--clipboard-source-accent"?: string;
};

type ClipboardGroupStyle = CSSProperties & {
  "--clipboard-group-accent"?: string;
};

const ClipboardCard = ({
  active,
  ageReferenceTime,
  dragging,
  groupColor,
  groupName,
  index,
  item,
  onOpenMenu,
  onCopy,
  onSelect,
  query,
  sourceVisual,
}: ClipboardCardProps) => {
  const t = useTranslations("clipboard");
  const age = formatClipboardAge(item.copiedAt, ageReferenceTime);
  const formattedAge = new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: age.unit,
    unitDisplay: "narrow",
  }).format(age.value);
  const relativeTime =
    age.type === "lessThan" ? `<${formattedAge}` : formattedAge;
  const sourceAppName = item.sourceApp?.name ?? null;
  const sourceTintIndex = clipboardSourceTintIndex(
    item.sourceApp?.identifier ?? sourceAppName,
  );
  const accent = groupColor
    ? CLIPBOARD_GROUP_ACCENTS[groupColor]
    : sourceVisual?.color;
  const sourceStyle: ClipboardCardStyle | undefined = accent
    ? { "--clipboard-source-accent": accent }
    : undefined;
  const previewClassName = cn(
    "text-foreground line-clamp-[8] text-sm leading-5 text-pretty break-words whitespace-pre-wrap",
    item.type === "formattedText" &&
      "[&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_code]:font-mono [&_li]:ms-4 [&_ol]:list-decimal [&_strong]:font-semibold [&_ul]:list-disc",
  );
  const highlightedText = highlightClipboardText(item.plainText, query);
  let previewContent: ReactNode = (
    <div className={previewClassName} dir="auto">
      {item.plainText}
    </div>
  );
  if (item.type === "formattedText" && !query) {
    previewContent = (
      <div
        className={previewClassName}
        dangerouslySetInnerHTML={{
          // safe-html: Rust ammonia::Builder removes active content and permits only the semantic formatting tags declared in clipboard.rs before IPC.
          __html: item.html,
        }}
        dir="auto"
      />
    );
  }
  if (query) {
    previewContent = (
      <div className={previewClassName} dir="auto">
        {highlightedText.map((segment, segmentIndex) =>
          segment.match ? (
            <mark
              className="bg-foreground/16 text-foreground rounded-[3px] box-decoration-clone px-0.5"
              key={`${segmentIndex}-${segment.text}`}
            >
              {segment.text}
            </mark>
          ) : (
            <span key={`${segmentIndex}-${segment.text}`}>{segment.text}</span>
          ),
        )}
      </div>
    );
  }
  let metadataIcon: ReactNode = (
    <FileTextIcon aria-hidden="true" className="text-muted-foreground size-6" />
  );
  if (groupName) {
    metadataIcon = (
      <TagsIcon aria-hidden="true" className="text-muted-foreground size-6" />
    );
  }
  if (sourceAppName) {
    metadataIcon = sourceVisual?.iconDataUrl ? (
      <img
        alt=""
        aria-hidden="true"
        className="clipboard-source-icon size-7 shrink-0"
        draggable={false}
        src={sourceVisual.iconDataUrl}
      />
    ) : (
      <span
        aria-hidden="true"
        className="clipboard-source-dot size-3 shrink-0 rounded-full"
      />
    );
  }

  return (
    <article
      aria-current={active ? "true" : undefined}
      className={cn(
        "clipboard-card group relative w-[246px] shrink-0 self-stretch overflow-hidden rounded-[24px]",
        "motion-safe:transition-opacity motion-safe:duration-150",
        active ? "opacity-100" : "opacity-86 hover:opacity-100",
      )}
      data-clipboard-id={item.id}
      data-dragging={dragging ? "" : undefined}
      data-source-tint={sourceTintIndex ?? undefined}
      role="listitem"
      style={sourceStyle}
    >
      <button
        aria-label={t("copyItem", { number: index + 1 })}
        className="flex size-full flex-col text-start focus-visible:outline-none"
        data-clipboard-card-trigger=""
        onClick={() => onCopy(item)}
        onContextMenu={(event) => onOpenMenu(event, item, index)}
        onFocus={() => onSelect(index)}
        onMouseEnter={() => onSelect(index)}
        type="button"
      >
        <div className="relative min-h-0 flex-1 self-stretch overflow-hidden p-5">
          {previewContent}
        </div>

        <footer className="clipboard-card-footer flex h-12 shrink-0 items-center gap-3 px-4">
          <span
            className="relative flex min-w-0 items-center gap-2"
            title={sourceAppName ?? groupName ?? undefined}
          >
            {metadataIcon}
            <span
              className={cn(
                "text-muted-foreground truncate text-xs",
                sourceAppName && "clipboard-source-name",
              )}
              dir="auto"
            >
              {sourceAppName ??
                groupName ??
                (item.type === "formattedText"
                  ? t("formattedText")
                  : t("plainText"))}
            </span>
          </span>
          <time
            className="text-muted-foreground shrink-0 text-xs tabular-nums"
            dateTime={item.copiedAt}
          >
            {relativeTime}
          </time>
          {index < 9 ? (
            <kbd className="bg-muted text-muted-foreground ms-auto rounded-md px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
              {PRIMARY_MODIFIER_LABEL}
              {index + 1}
            </kbd>
          ) : null}
        </footer>
      </button>
    </article>
  );
};

type ClipboardDialogState =
  | { type: "closed" }
  | { type: "clearHistory" }
  | { color: ClipboardGroupColor; name: string; type: "createGroup" }
  | { type: "deleteGroup"; groupId: string; groupName: string };

type DialogShellProps = {
  children: ReactNode;
  destructive?: boolean;
  onClose: () => void;
  onSubmit: () => void;
  submitDisabled?: boolean;
  submitLabel: string;
  title: string;
};

const DialogShell = ({
  children,
  destructive = false,
  onClose,
  onSubmit,
  submitDisabled = false,
  submitLabel,
  title,
}: DialogShellProps) => {
  const t = useTranslations("clipboard");
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogPopup
        backdropClassName="bg-background/50 backdrop-blur-xl"
        bottomStickOnMobile={false}
        className="bg-popover/92 max-w-sm rounded-[26px] border-0 shadow-2xl backdrop-blur-3xl"
        showCloseButton={false}
        viewportClassName="grid-rows-[1fr_auto_1fr] p-5"
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader className="p-5 pb-0">
            <DialogTitle className="text-sm">{title}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="p-5 pt-4">{children}</DialogPanel>
          <DialogFooter className="px-5 pb-5" variant="bare">
            <DialogClose render={<Button type="button" variant="ghost" />}>
              {t("cancel")}
            </DialogClose>
            <Button
              disabled={submitDisabled}
              type="submit"
              variant={destructive ? "destructive" : "default"}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
};

type ClipboardDialogProps = {
  dialog: ClipboardDialogState;
  onChange: (dialog: ClipboardDialogState) => void;
  onCommand: (
    command: string,
    args?: Record<string, unknown>,
    onSuccess?: () => void,
  ) => void;
  onGroupDeleted: (groupId: string) => void;
};

const ClipboardDialog = ({
  dialog,
  onChange,
  onCommand,
  onGroupDeleted,
}: ClipboardDialogProps) => {
  const t = useTranslations("clipboard");
  const close = () => onChange({ type: "closed" });

  switch (dialog.type) {
    case "closed":
      return null;
    case "clearHistory":
      return (
        <DialogShell
          destructive
          onClose={close}
          onSubmit={() => {
            onCommand("clipboard_clear_history", {}, close);
          }}
          submitLabel={t("clear")}
          title={t("clear")}
        >
          <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
            {t("clearConfirmation")}
          </p>
        </DialogShell>
      );
    case "createGroup":
      return (
        <DialogShell
          onClose={close}
          onSubmit={() => {
            onCommand(
              "clipboard_create_group",
              {
                color: dialog.color,
                name: dialog.name,
              },
              close,
            );
          }}
          submitDisabled={!dialog.name.trim()}
          submitLabel={t("create")}
          title={t("createGroup")}
        >
          <label className="block">
            <span className="text-muted-foreground text-xs">
              {t("groupName")}
            </span>
            <Input
              autoFocus
              className="mt-2 h-11 rounded-2xl"
              dir="auto"
              onChange={(event) => {
                if (
                  Array.from(event.target.value).length >
                  MAX_GROUP_NAME_CHARACTERS
                ) {
                  return;
                }
                onChange({
                  color: dialog.color,
                  name: event.target.value,
                  type: "createGroup",
                });
              }}
              value={dialog.name}
            />
          </label>
          <fieldset className="mt-4">
            <legend className="text-muted-foreground text-xs">
              {t("groupColor")}
            </legend>
            <div className="mt-2 flex items-center gap-2">
              {CLIPBOARD_GROUP_COLORS.map((color, index) => (
                <button
                  aria-label={`${t("groupColor")} ${index + 1}`}
                  aria-pressed={dialog.color === color}
                  className={cn(
                    "ring-offset-popover grid size-11 place-items-center rounded-full ring-offset-2 transition-transform outline-none hover:scale-105 focus-visible:ring-2",
                    dialog.color === color && "ring-foreground/70 ring-2",
                  )}
                  key={color}
                  onClick={() =>
                    onChange({
                      color,
                      name: dialog.name,
                      type: "createGroup",
                    })
                  }
                  style={{ backgroundColor: CLIPBOARD_GROUP_ACCENTS[color] }}
                  type="button"
                >
                  {dialog.color === color ? (
                    <CheckIcon
                      aria-hidden="true"
                      className="bg-background/88 text-foreground size-5 rounded-full p-0.5 shadow-sm"
                    />
                  ) : null}
                </button>
              ))}
            </div>
          </fieldset>
        </DialogShell>
      );
    case "deleteGroup":
      return (
        <DialogShell
          destructive
          onClose={close}
          onSubmit={() => {
            onCommand("clipboard_delete_group", { id: dialog.groupId }, () => {
              onGroupDeleted(dialog.groupId);
              close();
            });
          }}
          submitLabel={t("deleteGroup")}
          title={t("deleteGroup")}
        >
          <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
            {t("deleteGroupConfirmation", { groupName: dialog.groupName })}
          </p>
        </DialogShell>
      );
    default: {
      const exhaustive: never = dialog;
      return exhaustive;
    }
  }
};

type ClipboardContextMenuState =
  | { type: "closed" }
  | { item: ClipboardItem; type: "actions"; x: number; y: number }
  | { item: ClipboardItem; type: "groups"; x: number; y: number };

type ClipboardDragState =
  | { type: "idle" }
  | {
      itemId: string;
      target: { type: "none" } | { groupId: string | null; type: "group" };
      type: "dragging";
    };

type ClipboardContextMenuProps = {
  groups: ClipboardGroup[];
  menu: Exclude<ClipboardContextMenuState, { type: "closed" }>;
  onChange: (menu: ClipboardContextMenuState) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onEdit: (id: string) => void;
  onMove: (id: string, groupId: string | null) => void;
};

const ClipboardContextMenu = ({
  groups,
  menu,
  onChange,
  onClose,
  onDelete,
  onDuplicate,
  onEdit,
  onMove,
}: ClipboardContextMenuProps) => {
  const t = useTranslations("clipboard");
  const position = clipboardContextMenuPosition({
    anchorX: menu.x,
    anchorY: menu.y,
    type: menu.type,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
  });
  const itemClassName =
    "text-foreground hover:bg-foreground/8 focus-visible:bg-foreground/8 flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-sm outline-none";
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"]',
      ),
    ).filter((item) => !item.hasAttribute("disabled"));
    if (items.length === 0) {
      return;
    }
    const activeItem =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const activeIndex = activeItem ? items.indexOf(activeItem) : -1;
    let nextIndex = 0;
    if (event.key === "ArrowDown") {
      nextIndex = (activeIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = (activeIndex - 1 + items.length) % items.length;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    }
    items.at(nextIndex)?.focus();
  };
  return (
    <div
      className="bg-popover ring-border fixed z-30 flex w-56 flex-col overflow-hidden rounded-2xl p-1.5 shadow-2xl ring-1"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      style={{
        insetInlineStart: position.x,
        maxHeight: position.maxHeight,
        top: position.y,
      }}
      tabIndex={-1}
    >
      {menu.type === "actions" ? (
        <>
          <button
            autoFocus
            className={itemClassName}
            onClick={() => {
              onEdit(menu.item.id);
              onClose();
            }}
            role="menuitem"
            type="button"
          >
            <PencilIcon
              aria-hidden="true"
              className="text-muted-foreground size-4"
            />
            {t("editItem")}
          </button>
          <button
            className={itemClassName}
            onClick={() => {
              onDuplicate(menu.item.id);
              onClose();
            }}
            role="menuitem"
            type="button"
          >
            <CopyPlusIcon
              aria-hidden="true"
              className="text-muted-foreground size-4"
            />
            {t("duplicateItem")}
          </button>
          <button
            className={itemClassName}
            onClick={() =>
              onChange({
                item: menu.item,
                type: "groups",
                x: menu.x,
                y: menu.y,
              })
            }
            onPointerEnter={() =>
              onChange({
                item: menu.item,
                type: "groups",
                x: menu.x,
                y: menu.y,
              })
            }
            role="menuitem"
            type="button"
          >
            <FolderInputIcon
              aria-hidden="true"
              className="text-muted-foreground size-4"
            />
            <span className="flex-1">{t("moveToGroup")}</span>
            <DirectionalIcon
              className="text-muted-foreground size-4"
              icon={ChevronRightIcon}
            />
          </button>
          <div className="bg-border my-1 h-px" />
          <button
            className={`${itemClassName} hover:text-destructive focus-visible:text-destructive`}
            onClick={() => {
              onDelete(menu.item.id);
              onClose();
            }}
            role="menuitem"
            type="button"
          >
            <Trash2Icon aria-hidden="true" className="size-4" />
            {t("deleteItem")}
          </button>
        </>
      ) : (
        <>
          <button
            autoFocus
            className={itemClassName}
            onClick={() =>
              onChange({
                item: menu.item,
                type: "actions",
                x: menu.x,
                y: menu.y,
              })
            }
            role="menuitem"
            type="button"
          >
            <DirectionalIcon
              className="text-muted-foreground size-4"
              icon={ChevronLeftIcon}
            />
            {t("moveToGroup")}
          </button>
          <div className="bg-border my-1 h-px" />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {[{ color: null, id: null, name: t("noGroup") }, ...groups].map(
              (group) => (
                <button
                  aria-checked={menu.item.groupId === group.id}
                  className={itemClassName}
                  key={group.id ?? "none"}
                  onClick={() => {
                    onMove(menu.item.id, group.id);
                    onClose();
                  }}
                  role="menuitemradio"
                  type="button"
                >
                  <CheckIcon
                    aria-hidden="true"
                    className={cn(
                      "size-4",
                      menu.item.groupId === group.id
                        ? "opacity-100"
                        : "opacity-0",
                    )}
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2.5 shrink-0 rounded-full",
                      group.color === null && "border-border border",
                    )}
                    style={
                      group.color === null
                        ? undefined
                        : {
                            backgroundColor:
                              CLIPBOARD_GROUP_ACCENTS[group.color],
                          }
                    }
                  />
                  <span className="truncate" dir="auto">
                    {group.name}
                  </span>
                </button>
              ),
            )}
          </div>
        </>
      )}
    </div>
  );
};

const ClipboardApp = () => {
  const t = useTranslations("clipboard");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const contextMenuTriggerRef = useRef<HTMLElement>(null);
  const [snapshot, setSnapshot] = useState<ClipboardSnapshot>(EMPTY_SNAPSHOT);
  const [ageReferenceTime, setAgeReferenceTime] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ClipboardDialogState>({
    type: "closed",
  });
  const [contextMenu, setContextMenu] = useState<ClipboardContextMenuState>({
    type: "closed",
  });
  const [dragState, setDragState] = useState<ClipboardDragState>({
    type: "idle",
  });
  const errorReadHistory = t("errorReadHistory");

  useEffect(() => {
    const readSnapshot = () => {
      void invoke<unknown>("clipboard_get_snapshot")
        .then((value) => {
          if (!isClipboardSnapshot(value)) {
            reportDesktopError({
              code: DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
              operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryRead,
              window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
            });
            setError(errorReadHistory);
            return undefined;
          }
          setSnapshot(value);
          return undefined;
        })
        .catch(() => {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
            operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryRead,
            window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
          });
          setError(errorReadHistory);
        });
    };
    readSnapshot();
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listen("clipboard-history-changed", readSnapshot)
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return undefined;
        }
        stopListening = unlisten;
        return undefined;
      })
      .catch(() => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
          operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistorySubscribe,
          window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
        });
        setError(errorReadHistory);
      });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [errorReadHistory]);

  const activeGroupId = snapshot.groups.some(
    (group) => group.id === selectedGroupId,
  )
    ? selectedGroupId
    : null;
  const filteredItems = filterClipboardItems(
    snapshot.items,
    query,
    activeGroupId,
  );
  const groupsById = new Map(snapshot.groups.map((group) => [group.id, group]));
  const sourceAppVisuals = new Map(
    snapshot.sourceAppVisuals.map((visual) => [visual.key, visual]),
  );
  const activeIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredItems.length - 1),
  );
  const activeItem = filteredItems.at(activeIndex);
  const activeItemId = activeItem?.id;

  useEffect(() => {
    const focusActiveCard = () => {
      if (activeItemId) {
        focusCard(activeItemId);
        return;
      }
      timelineRef.current?.focus();
    };
    const handleWindowFocus = () => {
      setAgeReferenceTime(Date.now());
      focusActiveCard();
    };
    window.addEventListener("focus", handleWindowFocus);
    if (
      document.hasFocus() &&
      (document.activeElement === document.body ||
        document.activeElement === timelineRef.current)
    ) {
      focusActiveCard();
    }
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [activeItemId]);

  const nextGroupColor =
    CLIPBOARD_GROUP_COLORS.at(
      snapshot.groups.length % CLIPBOARD_GROUP_COLORS.length,
    ) ?? "gray";
  let emptyStateTitle = t("emptyTitle");
  if (query) {
    emptyStateTitle = t("noResults");
  } else if (activeGroupId) {
    emptyStateTitle = t("groupEmpty");
  }

  const applySnapshotCommand = useCallback(
    (
      command: string,
      args: Record<string, unknown> = {},
      onSuccess?: () => void,
    ) => {
      setError(null);
      void invoke<unknown>(command, args)
        .then((value) => {
          if (isClipboardSnapshot(value)) {
            setSnapshot(value);
            onSuccess?.();
            return undefined;
          }
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
            operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryUpdate,
            window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
          });
          setError(t("errorUpdateHistory"));
          return undefined;
        })
        .catch(() => {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
            operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryUpdate,
            window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
          });
          setError(t("errorUpdateHistory"));
        });
    },
    [t],
  );

  const copyItem = (item: ClipboardItem) => {
    setError(null);
    void invoke("clipboard_copy_item", { id: item.id }).catch(() => {
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardCopy,
        window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
      });
      setError(t("errorPaste"));
    });
  };

  const openEditor = (id: string) => {
    setError(null);
    void invoke("clipboard_open_editor", { id }).catch(() => {
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryUpdate,
        window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
      });
      setError(t("errorUpdateHistory"));
    });
  };

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    item: ClipboardItem,
    index: number,
  ) => {
    event.preventDefault();
    contextMenuTriggerRef.current = event.currentTarget;
    setSelectedIndex(index);
    setContextMenu({
      item,
      type: "actions",
      x: event.clientX,
      y: event.clientY,
    });
  };

  const closeContextMenu = () => {
    setContextMenu({ type: "closed" });
    requestAnimationFrame(() => contextMenuTriggerRef.current?.focus());
  };

  useEffect(() => {
    const itemIds = new Set(snapshot.items.map((item) => item.id));
    const groupIds = new Set(snapshot.groups.map((group) => group.id));
    const cleanups: (() => void)[] = [];

    for (const element of document.querySelectorAll<HTMLElement>(
      CLIPBOARD_CARD_SELECTOR,
    )) {
      const itemId = element.dataset["clipboardId"];
      if (!itemId || !itemIds.has(itemId)) {
        continue;
      }
      cleanups.push(
        draggable({
          element,
          getInitialData: () => ({
            itemId,
            type: CLIPBOARD_ITEM_DRAG_TYPE,
          }),
          onDragStart: () => {
            setDragState({
              itemId,
              target: { type: "none" },
              type: "dragging",
            });
          },
          onDrop: () => setDragState({ type: "idle" }),
          onGenerateDragPreview: ({ location, nativeSetDragImage }) => {
            setCustomNativeDragPreview({
              getOffset: preserveOffsetOnSource({
                element,
                input: location.current.input,
              }),
              nativeSetDragImage,
              render: ({ container }) => {
                const clone = element.cloneNode(true);
                if (!(clone instanceof HTMLElement)) {
                  return;
                }
                const bounds = element.getBoundingClientRect();
                clone.style.height = `${bounds.height}px`;
                clone.style.width = `${bounds.width}px`;
                container.append(clone);
              },
            });
          },
        }),
      );
    }

    for (const element of document.querySelectorAll<HTMLElement>(
      CLIPBOARD_GROUP_DROP_SELECTOR,
    )) {
      const dropId = element.dataset["clipboardGroupId"];
      const groupId = dropId === CLIPBOARD_NO_GROUP_DROP_ID ? null : dropId;
      if (
        groupId === undefined ||
        (groupId !== null && !groupIds.has(groupId))
      ) {
        continue;
      }
      cleanups.push(
        dropTargetForElements({
          canDrop: ({ source }) =>
            clipboardDraggedItemId(source.data, itemIds) !== null,
          element,
          onDragEnter: ({ source }) => {
            const itemId = clipboardDraggedItemId(source.data, itemIds);
            if (!itemId) {
              return;
            }
            setDragState({
              itemId,
              target: { groupId, type: "group" },
              type: "dragging",
            });
          },
          onDragLeave: ({ source }) => {
            const itemId = clipboardDraggedItemId(source.data, itemIds);
            if (!itemId) {
              return;
            }
            setDragState({
              itemId,
              target: { type: "none" },
              type: "dragging",
            });
          },
          onDrop: ({ source }) => {
            const itemId = clipboardDraggedItemId(source.data, itemIds);
            setDragState({ type: "idle" });
            if (!itemId) {
              return;
            }
            applySnapshotCommand("clipboard_set_item_group", {
              groupId,
              id: itemId,
            });
          },
        }),
      );
    }

    return combine(...cleanups);
  }, [
    activeGroupId,
    applySnapshotCommand,
    query,
    snapshot.groups,
    snapshot.items,
  ]);

  const isDropTarget = (groupId: string | null) =>
    dragState.type === "dragging" &&
    dragState.target.type === "group" &&
    dragState.target.groupId === groupId;

  const selectIndex = (index: number) => {
    setSelectedIndex(index);
    const item = filteredItems.at(index);
    if (item) {
      scrollCardIntoView(item.id);
      focusCard(item.id);
    }
  };

  const navigate = (direction: "next" | "previous") => {
    selectIndex(
      nextClipboardIndex(activeIndex, direction, filteredItems.length),
    );
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (dialog.type !== "closed") {
      return;
    }
    const primaryModifier = event.metaKey || event.ctrlKey;
    if (primaryModifier && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }
    if (event.target instanceof HTMLInputElement) {
      if (event.key === "Enter" && activeItem) {
        if (event.isComposing) {
          return;
        }
        event.preventDefault();
        copyItem(activeItem);
      }
      return;
    }
    if (isClipboardCopyShortcut(event) && activeItem) {
      event.preventDefault();
      copyItem(activeItem);
      return;
    }
    if (primaryModifier) {
      const quickIndex = quickCopyIndex(event.key, filteredItems.length);
      if (quickIndex !== null) {
        event.preventDefault();
        const item = filteredItems.at(quickIndex);
        if (item) {
          copyItem(item);
        }
        return;
      }
    }
    if (
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    const cardTrigger = target?.closest("[data-clipboard-card-trigger]");
    const interactiveTarget = target?.closest(
      "button, a, input, textarea, select, [contenteditable='true']",
    );
    if (interactiveTarget && !cardTrigger) {
      return;
    }
    if (cardTrigger && event.key === " ") {
      return;
    }
    if (
      event.key.length === 1 &&
      !event.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      setQuery((currentQuery) => currentQuery + event.key);
      setSelectedIndex(0);
      searchInputRef.current?.focus();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      navigate("next");
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      navigate("previous");
      return;
    }
    if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      copyItem(activeItem);
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && activeItem) {
      event.preventDefault();
      applySnapshotCommand("clipboard_delete_item", { id: activeItem.id });
    }
  };

  const handleKeyDownCapture = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (contextMenu.type !== "closed") {
      closeContextMenu();
      return;
    }
    if (dialog.type !== "closed") {
      setDialog({ type: "closed" });
      return;
    }
    if (query) {
      setQuery("");
      setSelectedIndex(0);
      searchInputRef.current?.focus();
      return;
    }
    void invoke("clipboard_hide");
  };

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return () => undefined;
    }
    timeline.addEventListener("keydown", handleKeyDown);
    timeline.addEventListener("keydown", handleKeyDownCapture, true);
    return () => {
      timeline.removeEventListener("keydown", handleKeyDown);
      timeline.removeEventListener("keydown", handleKeyDownCapture, true);
    };
  }, [handleKeyDown, handleKeyDownCapture]);

  const nextCaptureStatus: ClipboardCaptureStatus =
    snapshot.captureStatus === "active" ? "paused" : "active";
  let persistenceLabel = t("memoryOnly");
  if (snapshot.persistence.status === "encrypted") {
    persistenceLabel = t("encryptedHistory");
  } else if (snapshot.persistence.status === "deletionOnly") {
    persistenceLabel = t("errorReadHistory");
  }
  let feedback: ReactNode = null;
  if (error) {
    feedback = (
      <div
        className="bg-destructive text-destructive-foreground absolute inset-x-0 top-0 z-20 px-5 py-1.5 text-center text-xs"
        role="alert"
      >
        {error}
      </div>
    );
  }

  return (
    <div
      className="clipboard-window text-foreground relative flex min-h-dvh flex-col overflow-hidden outline-none"
      aria-label={t("timeline")}
      ref={(node) => {
        timelineRef.current = node;
        focusTimeline(node);
      }}
      role="application"
      tabIndex={-1}
    >
      <ClipboardDialog
        dialog={dialog}
        onChange={setDialog}
        onCommand={applySnapshotCommand}
        onGroupDeleted={(groupId) => {
          setSelectedGroupId((currentGroupId) =>
            currentGroupId === groupId ? null : currentGroupId,
          );
        }}
      />
      {contextMenu.type === "closed" ? null : (
        <>
          <button
            aria-label={t("close")}
            className="fixed inset-0 z-20 cursor-default"
            onClick={closeContextMenu}
            tabIndex={-1}
            type="button"
          />
          <ClipboardContextMenu
            groups={snapshot.groups}
            menu={contextMenu}
            onChange={setContextMenu}
            onClose={closeContextMenu}
            onDelete={(id) =>
              applySnapshotCommand("clipboard_delete_item", { id })
            }
            onDuplicate={(id) =>
              applySnapshotCommand("clipboard_duplicate_item", { id })
            }
            onEdit={openEditor}
            onMove={(id, groupId) =>
              applySnapshotCommand("clipboard_set_item_group", { groupId, id })
            }
          />
        </>
      )}
      <main className="relative min-h-0 flex-1">
        {feedback}

        <nav
          aria-label={t("groups")}
          className="clipboard-groups-rail absolute inset-x-0 top-0 z-10 flex h-13 scrollbar-none items-center gap-1.5 overflow-x-auto px-4"
        >
          <Button
            aria-pressed={activeGroupId === null}
            className="h-11 shrink-0 rounded-full px-4 text-xs"
            data-clipboard-group-id={CLIPBOARD_NO_GROUP_DROP_ID}
            data-drop-target={isDropTarget(null) ? "" : undefined}
            onClick={() => {
              setSelectedGroupId(null);
              setSelectedIndex(0);
            }}
            variant={activeGroupId === null ? "secondary" : "ghost"}
          >
            {t("allClips")}
          </Button>
          {snapshot.groups.map((group) => {
            const groupStyle: ClipboardGroupStyle = {
              "--clipboard-group-accent": CLIPBOARD_GROUP_ACCENTS[group.color],
            };
            return (
              <Button
                aria-pressed={activeGroupId === group.id}
                className="clipboard-group-chip h-11 shrink-0 rounded-full px-4 text-xs"
                data-clipboard-group-id={group.id}
                data-drop-target={isDropTarget(group.id) ? "" : undefined}
                data-group-chip=""
                key={group.id}
                onClick={() => {
                  setSelectedGroupId(group.id);
                  setSelectedIndex(0);
                }}
                style={groupStyle}
                variant="ghost"
              >
                <span
                  aria-hidden="true"
                  className="clipboard-group-chip-dot size-2 shrink-0 rounded-full"
                />
                {group.name}
              </Button>
            );
          })}
          {activeGroupId ? (
            <Button
              aria-label={t("deleteGroup")}
              className="size-11 shrink-0 rounded-full"
              onClick={() => {
                const group = snapshot.groups.find(
                  (candidate) => candidate.id === activeGroupId,
                );
                if (group) {
                  setDialog({
                    type: "deleteGroup",
                    groupId: group.id,
                    groupName: group.name,
                  });
                }
              }}
              size="icon"
              title={t("deleteGroup")}
              variant="ghost"
            >
              <Trash2Icon aria-hidden="true" className="size-3.5" />
            </Button>
          ) : null}
          <Button
            className="sticky end-0 z-10 ms-auto h-11 shrink-0 rounded-full px-4 text-xs shadow-sm"
            disabled={snapshot.groups.length >= 24}
            onClick={() =>
              setDialog({
                color: nextGroupColor,
                name: "",
                type: "createGroup",
              })
            }
            variant="default"
          >
            <FolderPlusIcon aria-hidden="true" className="size-4" />
            {t("createGroup")}
          </Button>
        </nav>

        {filteredItems.length === 0 ? (
          <div
            className={cn(
              "text-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center",
              "pt-13",
            )}
          >
            <span className="bg-foreground/6 text-foreground/70 grid size-11 place-items-center rounded-2xl shadow-sm/5">
              {query ? (
                <SearchIcon aria-hidden="true" className="size-5" />
              ) : (
                <ClipboardIcon aria-hidden="true" className="size-5" />
              )}
            </span>
            <p className="text-foreground/82 text-wrap-balance max-w-sm text-sm font-medium">
              {query || activeGroupId ? emptyStateTitle : t("emptyDescription")}
            </p>
          </div>
        ) : (
          <div
            aria-label={t("timeline")}
            className={cn(
              "absolute inset-0 flex snap-x scrollbar-none items-stretch gap-3 overflow-x-auto px-5 pt-13 pb-1",
            )}
            role="list"
          >
            {filteredItems.map((item, index) => {
              const group = item.groupId
                ? (groupsById.get(item.groupId) ?? null)
                : null;
              return (
                <ClipboardCard
                  active={index === activeIndex}
                  ageReferenceTime={ageReferenceTime}
                  dragging={
                    dragState.type === "dragging" &&
                    dragState.itemId === item.id
                  }
                  groupColor={group?.color ?? null}
                  groupName={group?.name ?? null}
                  index={index}
                  item={item}
                  key={item.id}
                  onOpenMenu={openContextMenu}
                  onCopy={copyItem}
                  onSelect={setSelectedIndex}
                  query={query}
                  sourceVisual={
                    item.sourceApp
                      ? (sourceAppVisuals.get(
                          item.sourceApp.identifier ?? item.sourceApp.name,
                        ) ?? null)
                      : null
                  }
                />
              );
            })}
          </div>
        )}
      </main>

      <footer className="clipboard-controls flex h-16 shrink-0 items-center gap-3 px-4">
        <div className="flex min-w-32 items-center gap-1">
          <a
            aria-label="Stella"
            className="text-foreground grid size-11 place-items-center"
            href={STELLA_WEB_APP_URL}
            onClick={(event) => {
              event.preventDefault();
              void invoke("clipboard_open_stella").catch(() => {
                reportDesktopError({
                  code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
                  operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardExternalOpen,
                  window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
                });
                setError(t("errorOpenStella"));
              });
            }}
          >
            <StellaMark className="size-6" />
          </a>
          {snapshot.persistence.status === "initializing" ? null : (
            <span
              aria-label={persistenceLabel}
              className={cn(
                "grid size-7 place-items-center rounded-full",
                snapshot.persistence.status === "encrypted"
                  ? "text-muted-foreground"
                  : "bg-warning/12 text-warning",
              )}
              role="status"
              title={persistenceLabel}
            >
              {snapshot.persistence.status === "encrypted" ? (
                <LockKeyholeIcon aria-hidden="true" className="size-3.5" />
              ) : (
                <ShieldAlertIcon aria-hidden="true" className="size-3.5" />
              )}
            </span>
          )}
        </div>

        <InputGroup className="clipboard-search mx-auto h-10 w-full max-w-[440px] rounded-full">
          <InputGroupAddon className="text-foreground/65">
            <SearchIcon aria-hidden="true" className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("search")}
            className="clipboard-search-input h-full px-0 text-sm"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            placeholder={t("searchPlaceholder")}
            ref={searchInputRef}
            role="searchbox"
            spellCheck={false}
            type="text"
            value={query}
          />
          <InputGroupAddon align="inline-end" className="pe-4 [&>kbd]:me-0">
            <kbd className="text-foreground-muted me-0 font-mono text-[10px]">
              {PRIMARY_MODIFIER_LABEL}K
            </kbd>
          </InputGroupAddon>
        </InputGroup>

        <div className="flex min-w-32 items-center justify-end gap-1">
          <Button
            aria-label={
              snapshot.captureStatus === "active" ? t("pause") : t("resume")
            }
            className="size-11 rounded-full"
            onClick={() => {
              applySnapshotCommand("clipboard_set_capture_status", {
                status: nextCaptureStatus,
              });
            }}
            size="icon"
            title={
              snapshot.captureStatus === "active" ? t("pause") : t("resume")
            }
            variant="ghost"
          >
            {snapshot.captureStatus === "active" ? (
              <PauseIcon aria-hidden="true" className="size-4" />
            ) : (
              <PlayIcon aria-hidden="true" className="size-4" />
            )}
          </Button>
          <Button
            aria-label={t("clear")}
            className="size-11 rounded-full"
            disabled={
              snapshot.items.length === 0 &&
              snapshot.persistence.status !== "deletionOnly"
            }
            onClick={() => {
              setDialog({ type: "clearHistory" });
            }}
            size="icon"
            title={t("clear")}
            variant="ghost"
          >
            <Trash2Icon aria-hidden="true" className="size-4" />
          </Button>
          <Button
            aria-label={t("close")}
            className="size-11 rounded-full"
            onClick={() => {
              invoke("clipboard_hide").catch(() =>
                setError(t("errorUpdateHistory")),
              );
            }}
            size="icon"
            title={t("close")}
            variant="ghost"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </footer>
    </div>
  );
};

export default ClipboardApp;
