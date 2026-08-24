import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

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
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SearchIcon,
  TagsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
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
  WEBKIT_DRAG_FALLBACK_TYPE,
  clipboardDraggedItemId,
  clipboardSourceTintIndex,
  filterClipboardItems,
  formatClipboardAge,
  highlightClipboardText,
  nextClipboardIndex,
  quickPasteIndex,
} from "./clipboard-logic";
import { isClipboardSnapshot } from "./clipboard-types";
import type {
  ClipboardCaptureStatus,
  ClipboardGroup,
  ClipboardGroupColor,
  ClipboardItem,
  ClipboardPasteOutcome,
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

type ClipboardCardProps = {
  active: boolean;
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
  onDragEnd: () => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>, itemId: string) => void;
  onPaste: (item: ClipboardItem, plainTextOnly: boolean) => void;
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
  dragging,
  groupColor,
  groupName,
  index,
  item,
  onOpenMenu,
  onDragEnd,
  onDragStart,
  onPaste,
  onSelect,
  query,
  sourceVisual,
}: ClipboardCardProps) => {
  const t = useTranslations("clipboard");
  const age = formatClipboardAge(item.copiedAt);
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
        aria-label={t("pasteItem", { number: index + 1 })}
        className="flex size-full flex-col text-start focus-visible:outline-none"
        draggable
        onClick={() => onPaste(item, false)}
        onContextMenu={(event) => onOpenMenu(event, item, index)}
        onDragEnd={onDragEnd}
        onDragStart={(event) => onDragStart(event, item.id)}
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
              ⌘{index + 1}
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
    <div className="bg-background/50 absolute inset-0 z-40 grid place-items-center p-5 backdrop-blur-xl">
      <form
        aria-label={title}
        aria-modal="true"
        className="bg-popover/92 w-full max-w-sm rounded-[26px] p-5 shadow-2xl backdrop-blur-3xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        role="dialog"
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="mt-4">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} type="button" variant="ghost">
            {t("cancel")}
          </Button>
          <Button
            disabled={submitDisabled}
            type="submit"
            variant={destructive ? "destructive" : "default"}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
};

type ClipboardDialogProps = {
  dialog: ClipboardDialogState;
  onChange: (dialog: ClipboardDialogState) => void;
  onCommand: (command: string, args?: Record<string, unknown>) => void;
};

const ClipboardDialog = ({
  dialog,
  onChange,
  onCommand,
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
            onCommand("clipboard_clear_history");
            close();
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
            onCommand("clipboard_create_group", {
              color: dialog.color,
              name: dialog.name,
            });
            close();
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
              maxLength={64}
              onChange={(event) =>
                onChange({
                  color: dialog.color,
                  name: event.target.value,
                  type: "createGroup",
                })
              }
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
            onCommand("clipboard_delete_group", { id: dialog.groupId });
            close();
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
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onEdit: (id: string) => void;
  onMove: (id: string, groupId: string | null) => void;
};

const ClipboardContextMenu = ({
  groups,
  menu,
  onChange,
  onDelete,
  onDuplicate,
  onEdit,
  onMove,
}: ClipboardContextMenuProps) => {
  const t = useTranslations("clipboard");
  const close = () => onChange({ type: "closed" });
  const itemClassName =
    "text-foreground hover:bg-foreground/8 focus-visible:bg-foreground/8 flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-sm outline-none";
  return (
    <div
      className="bg-popover ring-border fixed z-30 w-56 rounded-2xl p-1.5 shadow-2xl ring-1"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      style={{ insetInlineStart: menu.x, top: menu.y }}
      tabIndex={-1}
    >
      {menu.type === "actions" ? (
        <>
          <button
            className={itemClassName}
            onClick={() => {
              onEdit(menu.item.id);
              close();
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
              close();
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
              close();
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
          <div className="max-h-64 overflow-y-auto">
            {[{ color: null, id: null, name: t("noGroup") }, ...groups].map(
              (group) => (
                <button
                  aria-checked={menu.item.groupId === group.id}
                  className={itemClassName}
                  key={group.id ?? "none"}
                  onClick={() => {
                    onMove(menu.item.id, group.id);
                    close();
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
  const [snapshot, setSnapshot] = useState<ClipboardSnapshot>(EMPTY_SNAPSHOT);
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

  const applySnapshotCommand = (
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    setError(null);
    void invoke<unknown>(command, args)
      .then((value) => {
        if (isClipboardSnapshot(value)) {
          setSnapshot(value);
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
  };

  const pasteItem = (item: ClipboardItem, plainTextOnly: boolean) => {
    setError(null);
    void invoke<ClipboardPasteOutcome>("clipboard_paste_item", {
      id: item.id,
      plainTextOnly,
    }).catch(() => {
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardPaste,
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
    setSelectedIndex(index);
    setContextMenu({
      item,
      type: "actions",
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 232)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 224)),
    });
  };

  const startDragging = (
    event: ReactDragEvent<HTMLElement>,
    itemId: string,
  ) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(CLIPBOARD_ITEM_DRAG_TYPE, itemId);
    event.dataTransfer.setData(WEBKIT_DRAG_FALLBACK_TYPE, itemId);
    const card = event.currentTarget.parentElement;
    if (card) {
      const bounds = card.getBoundingClientRect();
      const offsetX = Math.round(
        Math.max(0, Math.min(event.clientX - bounds.left, bounds.width)),
      );
      const offsetY = Math.round(
        Math.max(0, Math.min(event.clientY - bounds.top, bounds.height)),
      );
      event.dataTransfer.setDragImage(card, offsetX, offsetY);
    }
    setDragState({
      itemId,
      target: { type: "none" },
      type: "dragging",
    });
  };

  const selectDropTarget = (
    event: ReactDragEvent<HTMLElement>,
    groupId: string | null,
  ) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragState((current) => {
      if (current.type === "idle") {
        return current;
      }
      if (
        current.target.type === "group" &&
        current.target.groupId === groupId
      ) {
        return current;
      }
      return {
        itemId: current.itemId,
        target: { groupId, type: "group" },
        type: "dragging",
      };
    });
  };

  const clearDropTarget = (event: ReactDragEvent<HTMLElement>) => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setDragState((current) => {
      if (current.type === "idle") {
        return current;
      }
      return {
        itemId: current.itemId,
        target: { type: "none" },
        type: "dragging",
      };
    });
  };

  const dropIntoGroup = (
    event: ReactDragEvent<HTMLElement>,
    groupId: string | null,
  ) => {
    event.preventDefault();
    const itemId = clipboardDraggedItemId(
      event.dataTransfer,
      new Set(snapshot.items.map((item) => item.id)),
    );
    if (itemId) {
      applySnapshotCommand("clipboard_set_item_group", {
        groupId,
        id: itemId,
      });
    }
    setDragState({ type: "idle" });
  };

  const isDropTarget = (groupId: string | null) =>
    dragState.type === "dragging" &&
    dragState.target.type === "group" &&
    dragState.target.groupId === groupId;

  const selectIndex = (index: number) => {
    setSelectedIndex(index);
    const item = filteredItems.at(index);
    if (item) {
      scrollCardIntoView(item.id);
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
    if (primaryModifier) {
      const quickIndex = quickPasteIndex(event.key, filteredItems.length);
      if (quickIndex !== null) {
        event.preventDefault();
        const item = filteredItems.at(quickIndex);
        if (item) {
          pasteItem(item, event.shiftKey);
        }
        return;
      }
    }
    if (event.target instanceof HTMLInputElement) {
      if (event.key === "Enter" && activeItem) {
        event.preventDefault();
        pasteItem(activeItem, event.shiftKey);
      }
      return;
    }
    if (
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    ) {
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
    if (event.key === "ArrowRight") {
      event.preventDefault();
      navigate("next");
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      navigate("previous");
      return;
    }
    if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      pasteItem(activeItem, event.shiftKey);
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && activeItem) {
      event.preventDefault();
      applySnapshotCommand("clipboard_delete_item", { id: activeItem.id });
    }
  };

  const handleKeyDownCapture = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (contextMenu.type !== "closed") {
      setContextMenu({ type: "closed" });
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
      />
      {contextMenu.type === "closed" ? null : (
        <>
          <button
            aria-label={t("close")}
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setContextMenu({ type: "closed" })}
            tabIndex={-1}
            type="button"
          />
          <ClipboardContextMenu
            groups={snapshot.groups}
            menu={contextMenu}
            onChange={setContextMenu}
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
        {error ? (
          <div
            className="bg-destructive text-destructive-foreground absolute inset-x-0 top-0 z-20 px-5 py-1.5 text-center text-xs"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <nav
          aria-label={t("groups")}
          className="clipboard-groups-rail absolute inset-x-0 top-0 z-10 flex h-13 scrollbar-none items-center gap-1.5 overflow-x-auto px-4"
        >
          <Button
            aria-pressed={activeGroupId === null}
            className="h-11 shrink-0 rounded-full px-4 text-xs"
            data-drop-target={isDropTarget(null) ? "" : undefined}
            onDragEnter={(event) => selectDropTarget(event, null)}
            onDragLeave={clearDropTarget}
            onDragOver={(event) => selectDropTarget(event, null)}
            onDrop={(event) => dropIntoGroup(event, null)}
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
                data-drop-target={isDropTarget(group.id) ? "" : undefined}
                data-group-chip=""
                key={group.id}
                onDragEnter={(event) => selectDropTarget(event, group.id)}
                onDragLeave={clearDropTarget}
                onDragOver={(event) => selectDropTarget(event, group.id)}
                onDrop={(event) => dropIntoGroup(event, group.id)}
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
                  setSelectedGroupId(null);
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
              {query ? emptyStateTitle : t("emptyDescription")}
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
                  onDragEnd={() => setDragState({ type: "idle" })}
                  onDragStart={startDragging}
                  onPaste={pasteItem}
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
              ⌘K
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
            disabled={snapshot.items.length === 0}
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
