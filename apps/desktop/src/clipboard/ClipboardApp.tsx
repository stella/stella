import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { flushSync } from "react-dom";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { preserveOffsetOnSource } from "@atlaskit/pragmatic-drag-and-drop/utils/preserve-offset-on-source";
import { invoke } from "@tauri-apps/api/core";
import {
  ClipboardIcon,
  CircleHelpIcon,
  CopyPlusIcon,
  CheckIcon,
  ClockIcon,
  EllipsisIcon,
  FileTextIcon,
  FolderInputIcon,
  FolderPlusIcon,
  KeyboardIcon,
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
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Input } from "@stll/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";
import { Label } from "@stll/ui/label";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/menu";
import { StellaMark } from "@stll/ui/stella-mark";
import { cn } from "@stll/ui/utils";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import {
  adjacentClipboardIndex,
  CLIPBOARD_CARD_PREVIEW_MAX_CHARACTERS,
  CLIPBOARD_ITEM_DRAG_TYPE,
  clipboardDraggedItemId,
  clipboardPointerMoved,
  clipboardRailScrollDelta,
  clipboardRailWindow,
  clipboardSearchPreviewText,
  clipboardSourceTintIndex,
  clipboardTimelineKeyAction,
  filterClipboardItems,
  formatClipboardAge,
  highlightClipboardText,
  isClipboardCopyShortcut,
  isClipboardNameInput,
  quickCopyIndex,
  shouldCopyFromClipboardInput,
  shouldReturnToTimelineFromInput,
} from "./clipboard-logic";
import type { ClipboardPointerPosition } from "./clipboard-logic";
import {
  markClipboardShellCommit,
  markClipboardSnapshotApplied,
  measureClipboardSnapshotRequest,
  observeClipboardReopens,
} from "./clipboard-startup-timing";
import {
  CLIPBOARD_RETENTIONS,
  isClipboardCopyError,
  isClipboardSnapshot,
} from "./clipboard-types";
import type {
  ClipboardCaptureStatus,
  ClipboardCopyErrorKind,
  ClipboardRetention,
  ClipboardGroup,
  ClipboardGroupColor,
  ClipboardItem,
  ClipboardSnapshot,
  ClipboardSourceAppVisual,
} from "./clipboard-types";
import { useRailViewport } from "./use-rail-viewport";

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
const MAX_ITEM_NAME_CHARACTERS = 80;
const RETENTION_LABEL_KEYS = {
  week: "retentionWeek",
  month: "retentionMonth",
  year: "retentionYear",
} as const satisfies Record<ClipboardRetention, string>;
const CLIPBOARD_CARD_SELECTOR = "[data-clipboard-id]";
// Which step of a copy failed decides what the user is told: only a `copy`
// failure means the clip never reached the system clipboard.
const COPY_FAILURE_FEEDBACK = {
  copy: {
    messageKey: "errorPaste",
    operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardCopy,
  },
  hide: {
    messageKey: "errorUpdateHistory",
    operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardWindowHide,
  },
  history: {
    messageKey: "errorUpdateHistory",
    operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryUpdate,
  },
} as const satisfies Record<
  ClipboardCopyErrorKind,
  {
    messageKey: "errorPaste" | "errorUpdateHistory";
    operation: (typeof DESKTOP_TELEMETRY_OPERATIONS)[keyof typeof DESKTOP_TELEMETRY_OPERATIONS];
  }
>;
// Must match the card's `w-[246px]` and the rail's `gap-3 px-5`.
const CLIPBOARD_CARD_WIDTH = 246;
const CLIPBOARD_CARD_GAP = 12;
const CLIPBOARD_CARD_STRIDE = CLIPBOARD_CARD_WIDTH + CLIPBOARD_CARD_GAP;
const CLIPBOARD_RAIL_OVERSCAN = 3;
const CLIPBOARD_RAIL_PADDING = 20;
const CLIPBOARD_GROUP_DROP_SELECTOR = "[data-clipboard-group-id]";
const CLIPBOARD_NO_GROUP_DROP_ID = "__no_group__";
const PRIMARY_MODIFIER_LABEL = navigator.userAgent.includes("Mac")
  ? "⌘"
  : "Ctrl+";
const CLIPBOARD_SHORTCUT_LABEL = navigator.userAgent.includes("Mac")
  ? "⌘⇧V"
  : "Ctrl+Shift+V";

const EMPTY_SNAPSHOT = {
  captureStatus: "active",
  groups: [],
  items: [],
  persistence: { status: "initializing" },
  retention: "month",
  sourceAppVisuals: [],
  welcomeStatus: "initializing",
} satisfies ClipboardSnapshot;

type ClipboardAppError = {
  message: string;
  source: "operation" | "read";
};

const focusTimeline = (node: HTMLDivElement | null) => {
  if (node && document.activeElement === document.body) {
    node.focus();
  }
};

const focusCard = (rail: HTMLDivElement | null, id: string) => {
  requestAnimationFrame(() => {
    if (!rail) {
      return;
    }
    const card = rail.querySelector<HTMLElement>(
      `[data-clipboard-id="${CSS.escape(id)}"]`,
    );
    if (!card) {
      return;
    }
    card
      .querySelector<HTMLElement>("[data-clipboard-card-trigger]")
      ?.focus({ preventScroll: true });

    const railBounds = rail.getBoundingClientRect();
    const cardBounds = card.getBoundingClientRect();
    const left = clipboardRailScrollDelta({
      cardEnd: cardBounds.right,
      cardStart: cardBounds.left,
      viewportEnd: railBounds.right - CLIPBOARD_RAIL_PADDING,
      viewportStart: railBounds.left + CLIPBOARD_RAIL_PADDING,
    });
    if (left === 0) {
      return;
    }
    rail.scrollBy({
      behavior: "auto",
      left,
    });
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
  onRename: (id: string, name: string) => void;
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
  onRename,
  onSelect,
  query,
  sourceVisual,
}: ClipboardCardProps) => {
  const t = useTranslations("clipboard");
  const format = useFormatter();
  const cancelNameEditRef = useRef(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(item.name ?? "");
  const age = formatClipboardAge(item.copiedAt, ageReferenceTime);
  const formattedAge = new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: age.unit,
    unitDisplay: "narrow",
  }).format(age.value);
  const relativeTime =
    age.type === "lessThan" ? `<${formattedAge}` : formattedAge;
  const copiedAtLabel = format.dateTime(new Date(item.copiedAt), {
    dateStyle: "full",
    timeStyle: "medium",
  });
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
  const rendersHtml = item.type === "formattedText" && !query;
  const previewClassName = cn(
    "text-foreground line-clamp-[8] text-sm leading-5 text-pretty break-words",
    // HTML collapses its source whitespace; only plain text (and <pre>) keeps it.
    rendersHtml
      ? "[&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_code]:font-mono [&_li]:ms-4 [&_ol]:list-decimal [&_pre]:whitespace-pre-wrap [&_strong]:font-semibold [&_ul]:list-disc"
      : "whitespace-pre-wrap",
  );
  let previewContent: ReactNode = (
    <div className={previewClassName} dir="auto">
      {item.plainText.slice(0, CLIPBOARD_CARD_PREVIEW_MAX_CHARACTERS)}
    </div>
  );
  if (rendersHtml) {
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
    const searchPreview = clipboardSearchPreviewText(item, query);
    const highlightedText = highlightClipboardText(searchPreview.text, query);
    previewContent = (
      <div className={previewClassName} dir="auto">
        {searchPreview.truncated ? (
          <span aria-hidden="true" className="text-muted-foreground">
            {"… "}
          </span>
        ) : null}
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

  const beginNameEdit = () => {
    cancelNameEditRef.current = false;
    setNameDraft(item.name ?? "");
    setEditingName(true);
    onSelect(index);
  };

  const finishNameEdit = () => {
    setEditingName(false);
    if (cancelNameEditRef.current) {
      cancelNameEditRef.current = false;
      setNameDraft(item.name ?? "");
      return;
    }
    const nextName = nameDraft.trim();
    if (nextName !== (item.name ?? "")) {
      onRename(item.id, nextName);
    }
  };

  return (
    <article
      aria-current={active ? "true" : undefined}
      className={cn(
        "clipboard-card group relative flex w-[246px] shrink-0 flex-col self-stretch overflow-hidden rounded-[24px]",
        "motion-safe:transition-opacity motion-safe:duration-150",
        active ? "opacity-100" : "opacity-86 hover:opacity-100",
      )}
      data-clipboard-id={item.id}
      data-clipboard-index={index}
      data-dragging={dragging ? "" : undefined}
      data-source-tint={sourceTintIndex ?? undefined}
      role="listitem"
      style={sourceStyle}
    >
      <button
        aria-label={t("copyItem", { number: index + 1 })}
        className="flex min-h-0 flex-1 flex-col self-stretch text-start focus-visible:outline-none"
        data-clipboard-card-trigger=""
        onClick={() => onCopy(item)}
        onContextMenu={(event) => onOpenMenu(event, item, index)}
        onFocus={() => onSelect(index)}
        type="button"
      >
        <div className="relative min-h-0 flex-1 self-stretch overflow-hidden p-5">
          {previewContent}
        </div>
      </button>

      <footer className="clipboard-card-footer flex h-12 shrink-0 items-center gap-2 px-4">
        <span
          className="relative flex shrink-0 items-center"
          title={
            sourceAppName ??
            groupName ??
            (item.type === "formattedText"
              ? t("formattedText")
              : t("plainText"))
          }
        >
          {metadataIcon}
        </span>
        {editingName ? (
          <Input
            aria-label={t("editItem")}
            autoFocus
            className="h-8 min-w-0 flex-1 rounded-lg px-2 text-sm font-semibold"
            data-clipboard-name-input=""
            maxLength={MAX_ITEM_NAME_CHARACTERS}
            onBlur={finishNameEdit}
            onChange={(event) => setNameDraft(event.target.value)}
            onFocus={() => onSelect(index)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelNameEditRef.current = true;
                event.currentTarget.blur();
              }
            }}
            value={nameDraft}
          />
        ) : (
          <button
            className={cn(
              "text-foreground focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-start text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none",
              !item.name && "text-muted-foreground",
            )}
            onClick={beginNameEdit}
            onFocus={() => onSelect(index)}
            title={t("editItem")}
            type="button"
          >
            <span className="truncate" dir="auto">
              {item.name ?? t("unnamedClip")}
            </span>
            <PencilIcon
              aria-hidden="true"
              className="size-3 shrink-0 opacity-0 transition-opacity group-focus-within:opacity-60 group-hover:opacity-60"
            />
          </button>
        )}
        <time
          className="text-muted-foreground shrink-0 text-xs tabular-nums"
          dateTime={item.copiedAt}
          title={copiedAtLabel}
        >
          <span aria-hidden="true">{relativeTime}</span>
          <span className="sr-only">{copiedAtLabel}</span>
        </time>
        {index < 9 ? (
          <kbd className="bg-muted text-muted-foreground shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
            {PRIMARY_MODIFIER_LABEL}
            {index + 1}
          </kbd>
        ) : null}
      </footer>
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
  | { item: ClipboardItem; type: "open"; x: number; y: number };

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
  onClose: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onEdit: (id: string) => void;
  onMove: (id: string, groupId: string | null) => void;
};

const ClipboardContextMenu = ({
  groups,
  menu,
  onClose,
  onDelete,
  onDuplicate,
  onEdit,
  onMove,
}: ClipboardContextMenuProps) => {
  const t = useTranslations("clipboard");
  const anchor = {
    getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0),
  };

  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <MenuTrigger nativeButton={false} render={<span className="sr-only" />} />
      <MenuPopup anchor={anchor} className="w-56">
        <MenuItem
          className="min-h-11 rounded-xl"
          onClick={() => {
            onEdit(menu.item.id);
            onClose();
          }}
        >
          <PencilIcon />
          {t("editItem")}
        </MenuItem>
        <MenuItem
          className="min-h-11 rounded-xl"
          onClick={() => {
            onDuplicate(menu.item.id);
            onClose();
          }}
        >
          <CopyPlusIcon />
          {t("duplicateItem")}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger className="min-h-11 rounded-xl">
            <FolderInputIcon />
            {t("moveToGroup")}
          </MenuSubTrigger>
          <MenuSubPopup className="max-h-72 w-56">
            <MenuRadioGroup
              value={menu.item.groupId ?? CLIPBOARD_NO_GROUP_DROP_ID}
            >
              {[{ color: null, id: null, name: t("noGroup") }, ...groups].map(
                (group) => (
                  <MenuRadioItem
                    className="min-h-11 rounded-xl"
                    key={group.id ?? CLIPBOARD_NO_GROUP_DROP_ID}
                    onClick={() => {
                      onMove(menu.item.id, group.id);
                      onClose();
                    }}
                    value={group.id ?? CLIPBOARD_NO_GROUP_DROP_ID}
                  >
                    <span className="flex min-w-0 items-center gap-2">
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
                    </span>
                  </MenuRadioItem>
                ),
              )}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem
          className="min-h-11 rounded-xl"
          onClick={() => {
            onDelete(menu.item.id);
            onClose();
          }}
          variant="destructive"
        >
          <Trash2Icon />
          {t("deleteItem")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
};

type ClipboardWelcomeDialogProps = {
  onClose: () => void;
};

const AUTOSTART_ERROR = {
  read: "read",
  update: "update",
} as const;

type AutostartError = (typeof AUTOSTART_ERROR)[keyof typeof AUTOSTART_ERROR];

type AutostartChoiceState =
  | { status: "loading" }
  | {
      enabled: boolean;
      error: AutostartError | null;
      initialEnabled: boolean | null;
      status: "ready";
    }
  | {
      enabled: boolean;
      initialEnabled: boolean | null;
      status: "saving";
    };

const ClipboardWelcomeDialog = ({ onClose }: ClipboardWelcomeDialogProps) => {
  const t = useTranslations("clipboard");
  const settingsT = useTranslations("settings");
  const [autostartChoice, setAutostartChoice] = useState<AutostartChoiceState>({
    status: "loading",
  });
  const features = [
    {
      description: t("welcomeCaptureDescription"),
      icon: ClipboardIcon,
      title: t("welcomeCaptureTitle"),
    },
    {
      description: t("welcomeShortcutDescription", {
        shortcut: CLIPBOARD_SHORTCUT_LABEL,
      }),
      icon: KeyboardIcon,
      title: t("welcomeShortcutTitle"),
    },
    {
      description: t("welcomeLocalDescription"),
      icon: LockKeyholeIcon,
      title: t("welcomeLocalTitle"),
    },
  ];

  useEffect(() => {
    let mounted = true;
    void invoke<boolean>("is_autostart_enabled")
      .then((enabled) => {
        if (!mounted) {
          return undefined;
        }
        setAutostartChoice({
          enabled,
          error: null,
          initialEnabled: enabled,
          status: "ready",
        });
        return undefined;
      })
      .catch(() => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          operation: DESKTOP_TELEMETRY_OPERATIONS.autostartRead,
          window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
        });
        if (!mounted) {
          return;
        }
        setAutostartChoice({
          enabled: false,
          error: AUTOSTART_ERROR.read,
          initialEnabled: null,
          status: "ready",
        });
      });
    return () => {
      mounted = false;
    };
  }, []);

  const completeWelcome = () => {
    if (autostartChoice.status === "loading") {
      return;
    }
    if (autostartChoice.status === "saving") {
      return;
    }
    const { enabled, initialEnabled } = autostartChoice;
    if (enabled === initialEnabled || (initialEnabled === null && !enabled)) {
      onClose();
      return;
    }
    setAutostartChoice({ enabled, initialEnabled, status: "saving" });
    void invoke<boolean>("set_autostart", { enabled })
      .then((updatedEnabled) => {
        if (updatedEnabled === enabled) {
          onClose();
          return undefined;
        }
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
          operation: DESKTOP_TELEMETRY_OPERATIONS.autostartUpdate,
          window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
        });
        setAutostartChoice({
          enabled,
          error: AUTOSTART_ERROR.update,
          initialEnabled,
          status: "ready",
        });
        return undefined;
      })
      .catch(() => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          operation: DESKTOP_TELEMETRY_OPERATIONS.autostartUpdate,
          window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
        });
        setAutostartChoice({
          enabled,
          error: AUTOSTART_ERROR.update,
          initialEnabled,
          status: "ready",
        });
      });
  };

  const autostartEnabled =
    autostartChoice.status === "loading" ? false : autostartChoice.enabled;
  const autostartError =
    autostartChoice.status === "ready" ? autostartChoice.error : null;
  const autostartErrorMessage =
    autostartError === AUTOSTART_ERROR.read
      ? settingsT("errorReadState")
      : settingsT("errorUpdateAutostart");

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          completeWelcome();
        }
      }}
      open
    >
      <DialogPopup
        backdropClassName="bg-background/54 backdrop-blur-xl"
        bottomStickOnMobile={false}
        className="bg-popover/94 max-w-xl rounded-[28px] border-0 shadow-2xl backdrop-blur-3xl"
        showCloseButton={false}
        viewportClassName="grid-rows-[1fr_auto_1fr] p-4"
      >
        <DialogHeader className="flex-row items-start gap-4 px-5 pt-5 pb-2 text-start">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--option-blue-bg)] text-[var(--option-blue-fg)] shadow-sm">
            <ClipboardIcon aria-hidden="true" className="size-5" />
          </span>
          <span className="min-w-0">
            <DialogTitle className="text-wrap-balance text-lg leading-tight">
              {t("welcomeTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1 leading-relaxed text-pretty">
              {t("welcomeDescription")}
            </DialogDescription>
          </span>
        </DialogHeader>
        <DialogPanel className="px-5 pt-2 pb-1" scrollFade={false}>
          <div className="bg-muted/48 divide-border/70 divide-y rounded-2xl px-4 shadow-sm">
            {features.map(({ description, icon: Icon, title }) => (
              <div
                className="flex min-h-14 items-center gap-3 py-2"
                key={title}
              >
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-[var(--option-blue)]"
                />
                <p className="min-w-0 text-sm leading-snug text-pretty">
                  <span className="text-foreground font-semibold">{title}</span>{" "}
                  <span className="text-muted-foreground">{description}</span>
                </p>
              </div>
            ))}
          </div>
          <Label
            className="bg-muted/48 mt-3 min-h-14 w-full cursor-pointer items-start gap-3 rounded-2xl px-4 py-3"
            htmlFor="clipboard-welcome-autostart"
          >
            <Checkbox
              checked={autostartEnabled}
              className="mt-0.5"
              disabled={autostartChoice.status !== "ready"}
              id="clipboard-welcome-autostart"
              onCheckedChange={(enabled) => {
                if (autostartChoice.status !== "ready") {
                  return;
                }
                setAutostartChoice({
                  enabled,
                  error: null,
                  initialEnabled: autostartChoice.initialEnabled,
                  status: "ready",
                });
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                {settingsT("startOnLogin")}
              </span>
              <span className="text-muted-foreground mt-1 block text-sm leading-relaxed">
                {settingsT("startOnLoginDescription")}
              </span>
              {autostartError ? (
                <span
                  className="text-destructive mt-1 block text-xs leading-relaxed"
                  role="alert"
                >
                  {autostartErrorMessage}
                </span>
              ) : null}
            </span>
          </Label>
        </DialogPanel>
        <DialogFooter className="px-5 pb-5" variant="bare">
          <Button
            className="min-h-11 rounded-xl"
            disabled={autostartChoice.status !== "ready"}
            onClick={completeWelcome}
            type="button"
          >
            {t("welcomeStart")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

const ClipboardApp = () => {
  const t = useTranslations("clipboard");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineRailRef = useRef<HTMLDivElement>(null);
  const railPointerRef = useRef<ClipboardPointerPosition | null>(null);
  const contextMenuTriggerRef = useRef<HTMLElement>(null);
  const snapshotRequestIdRef = useRef(0);
  const [snapshot, setSnapshot] = useState<ClipboardSnapshot>(EMPTY_SNAPSHOT);
  const [ageReferenceTime, setAgeReferenceTime] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [appError, setError] = useState<ClipboardAppError | null>(null);
  const [dialog, setDialog] = useState<ClipboardDialogState>({
    type: "closed",
  });
  const [contextMenu, setContextMenu] = useState<ClipboardContextMenuState>({
    type: "closed",
  });
  const [dragState, setDragState] = useState<ClipboardDragState>({
    type: "idle",
  });
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [welcomeRequested, setWelcomeRequested] = useState(false);
  const errorReadHistory = t("errorReadHistory");
  const welcomeOpen =
    welcomeRequested ||
    (snapshot.welcomeStatus === "pending" && !welcomeDismissed);

  useEffect(() => {
    if (snapshot === EMPTY_SNAPSHOT) {
      return;
    }
    markClipboardSnapshotApplied(snapshot);
  }, [snapshot]);

  useEffect(() => {
    markClipboardShellCommit();
    const stopObservingReopens = observeClipboardReopens();
    let disposed = false;
    const readSnapshot = () => {
      const requestId = snapshotRequestIdRef.current + 1;
      snapshotRequestIdRef.current = requestId;
      void measureClipboardSnapshotRequest(
        invoke<unknown>("clipboard_get_snapshot"),
      )
        .then((value) => {
          if (disposed || requestId !== snapshotRequestIdRef.current) {
            return undefined;
          }
          if (!isClipboardSnapshot(value)) {
            reportDesktopError({
              code: DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
              operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryRead,
              window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
            });
            setError({ message: errorReadHistory, source: "read" });
            return undefined;
          }
          setSnapshot(value);
          setError((current) => (current?.source === "read" ? null : current));
          return undefined;
        })
        .catch(() => {
          if (disposed || requestId !== snapshotRequestIdRef.current) {
            return;
          }
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
            operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryRead,
            window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
          });
          setError({ message: errorReadHistory, source: "read" });
        });
    };
    readSnapshot();
    const stopListening = subscribeDesktopEvent({
      event: "clipboard-history-changed",
      handler: readSnapshot,
      onError: () => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
          operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistorySubscribe,
          window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
        });
        setError({ message: errorReadHistory, source: "read" });
      },
      // Re-read once the subscription exists: the off-mutex initialization
      // may have installed history and emitted its one-shot change event
      // between the first read and this listener, which would otherwise
      // leave the window stuck on the empty initializing snapshot.
      onSubscribed: readSnapshot,
    });
    return () => {
      stopObservingReopens();
      disposed = true;
      stopListening();
    };
  }, [errorReadHistory]);

  const activeGroupId = snapshot.groups.some(
    (group) => group.id === selectedGroupId,
  )
    ? selectedGroupId
    : null;
  // Typing must never wait on filtering and card re-render: the rail catches
  // up in a deferred render that further keystrokes interrupt. Clearing stays
  // synchronous (the empty filter is free) so the reopen reset can focus the
  // newest card in the same flushSync commit.
  const deferredQuery = useDeferredValue(query);
  const filterQuery = query === "" ? query : deferredQuery;
  const filteredItems = filterClipboardItems(
    snapshot.items,
    filterQuery,
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
  // Copy and delete act on the list the current query produces: while the
  // deferred render is pending the rail still shows the previous query's
  // list, and acting on it would hand over the wrong clip. Resolved on
  // demand inside the key handlers so the keystroke render itself never
  // pays for a filter; identical to the rendered list once settled.
  const resolveActionItems = () =>
    query === filterQuery
      ? filteredItems
      : filterClipboardItems(snapshot.items, query, activeGroupId);
  const resolveActionItem = () => {
    const items = resolveActionItems();
    return items.at(Math.min(selectedIndex, Math.max(0, items.length - 1)));
  };
  const railViewport = useRailViewport(
    timelineRailRef,
    filteredItems.length > 0,
  );
  const railWindow = clipboardRailWindow({
    activeIndex,
    itemCount: filteredItems.length,
    overscan: CLIPBOARD_RAIL_OVERSCAN,
    scrollLeft: railViewport.scrollLeft,
    stride: CLIPBOARD_CARD_STRIDE,
    viewportWidth: railViewport.width,
  });

  const requestHide = () => {
    void invoke("clipboard_hide").catch(() => {
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardWindowHide,
        window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
      });
      setError({ message: t("errorUpdateHistory"), source: "operation" });
    });
  };

  useEffect(() => {
    const focusActiveCard = () => {
      if (activeItemId) {
        focusCard(timelineRailRef.current, activeItemId);
        return;
      }
      timelineRef.current?.focus();
    };
    // The window hides on blur, so a focus event is always an open, and every
    // open starts on the newest clip. flushSync commits the reset first so the
    // newest card is in the DOM (the rail is virtualized) before it is focused.
    const handleWindowFocus = () => {
      setAgeReferenceTime(Date.now());
      // The pointer may have moved while the window was hidden; the next
      // pointer move only seeds the position.
      railPointerRef.current = null;
      if (welcomeOpen) {
        return;
      }
      flushSync(() => {
        setQuery("");
        setSelectedIndex(0);
      });
      const newestItem = filterClipboardItems(
        snapshot.items,
        "",
        activeGroupId,
      ).at(0);
      if (newestItem) {
        focusCard(timelineRailRef.current, newestItem.id);
        return;
      }
      timelineRef.current?.focus();
    };
    window.addEventListener("focus", handleWindowFocus);
    // A card other than the active one holds focus when a snapshot landed
    // after an open (a clip copied right before it slid in at the front);
    // focus follows the selection.
    const focusedCardId =
      document.activeElement?.closest<HTMLElement>("[data-clipboard-id]")
        ?.dataset["clipboardId"] ?? null;
    if (
      !welcomeOpen &&
      document.hasFocus() &&
      (document.activeElement === document.body ||
        document.activeElement === timelineRef.current ||
        (focusedCardId !== null && focusedCardId !== activeItemId))
    ) {
      focusActiveCard();
    }
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [activeGroupId, activeItemId, snapshot.items, welcomeOpen]);

  const nextGroupColor =
    CLIPBOARD_GROUP_COLORS.at(
      snapshot.groups.length % CLIPBOARD_GROUP_COLORS.length,
    ) ?? "gray";
  let emptyStateTitle = t("emptyTitle");
  if (filterQuery) {
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
      setError((current) => (current?.source === "operation" ? null : current));
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
          setError({
            message: t("errorUpdateHistory"),
            source: "operation",
          });
          return undefined;
        })
        .catch(() => {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
            operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryUpdate,
            window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
          });
          setError({
            message: t("errorUpdateHistory"),
            source: "operation",
          });
        });
    },
    [t],
  );

  const closeWelcome = () => {
    setWelcomeDismissed(true);
    setWelcomeRequested(false);
    if (snapshot.welcomeStatus === "pending") {
      applySnapshotCommand("clipboard_complete_welcome");
    }
  };

  const copyItem = (item: ClipboardItem) => {
    setError((current) => (current?.source === "operation" ? null : current));
    void invoke("clipboard_copy_item", { id: item.id }).catch(
      (error: unknown) => {
        // An unrecognised rejection means the clip never left the window.
        const kind = isClipboardCopyError(error) ? error.kind : "copy";
        const feedback = COPY_FAILURE_FEEDBACK[kind];
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          operation: feedback.operation,
          window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
        });
        setError({ message: t(feedback.messageKey), source: "operation" });
      },
    );
  };

  const openEditor = (id: string) => {
    setError((current) => (current?.source === "operation" ? null : current));
    void invoke("clipboard_open_editor", { id }).catch(() => {
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryUpdate,
        window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
      });
      setError({ message: t("errorUpdateHistory"), source: "operation" });
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
      type: "open",
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
    filterQuery,
    railWindow.end,
    railWindow.start,
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
      focusCard(timelineRailRef.current, item.id);
    }
  };

  const handleRailPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse") {
      return;
    }
    const position = { x: event.screenX, y: event.screenY };
    const moved = clipboardPointerMoved(railPointerRef.current, position);
    railPointerRef.current = position;
    if (!moved || !(event.target instanceof Element)) {
      return;
    }
    const index = event.target.closest<HTMLElement>("[data-clipboard-index]")
      ?.dataset["clipboardIndex"];
    if (index !== undefined) {
      setSelectedIndex(Number(index));
    }
  };

  const navigate = (direction: "next" | "previous") => {
    const nextIndex = adjacentClipboardIndex(
      activeIndex,
      direction,
      filteredItems.length,
    );
    if (nextIndex === null) {
      return;
    }
    selectIndex(nextIndex);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (dialog.type !== "closed" || welcomeOpen) {
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
      const actionItems = resolveActionItems();
      const quickIndex = quickCopyIndex(event.key, actionItems.length);
      if (quickIndex !== null) {
        event.preventDefault();
        const item = actionItems.at(quickIndex);
        if (item) {
          copyItem(item);
        }
        return;
      }
    }
    if (event.target instanceof HTMLInputElement) {
      const inputKey = {
        dataset: event.target.dataset,
        isComposing: event.isComposing,
        key: event.key,
      };
      if (shouldCopyFromClipboardInput(inputKey)) {
        const item = resolveActionItem();
        if (item) {
          event.preventDefault();
          copyItem(item);
        }
      } else if (activeItem && shouldReturnToTimelineFromInput(inputKey)) {
        event.preventDefault();
        selectIndex(activeIndex);
      }
      return;
    }
    if (isClipboardCopyShortcut(event)) {
      const item = resolveActionItem();
      if (item) {
        event.preventDefault();
        copyItem(item);
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
    const keyAction = clipboardTimelineKeyAction(event.key);
    if (keyAction === "focusSearch") {
      event.preventDefault();
      searchInputRef.current?.focus();
      return;
    }
    if (keyAction) {
      event.preventDefault();
      navigate(keyAction);
      return;
    }
    if (event.key === "Enter") {
      const item = resolveActionItem();
      if (item) {
        event.preventDefault();
        copyItem(item);
      }
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      const item = resolveActionItem();
      if (item) {
        event.preventDefault();
        applySnapshotCommand("clipboard_delete_item", { id: item.id });
      }
    }
  };

  const handleKeyDownCapture = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) {
      return;
    }
    if (
      event.target instanceof HTMLInputElement &&
      isClipboardNameInput(event.target.dataset)
    ) {
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
    requestHide();
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

  const captureActive = snapshot.captureStatus === "active";
  const nextCaptureStatus: ClipboardCaptureStatus = captureActive
    ? "paused"
    : "active";
  const captureActionLabel = captureActive ? t("pause") : t("resume");
  let persistenceWarningLabel = t("memoryOnly");
  if (snapshot.persistence.status === "deletionOnly") {
    persistenceWarningLabel = t("errorReadHistory");
  }
  let feedback: ReactNode = null;
  if (appError) {
    feedback = (
      <div
        className="bg-destructive text-destructive-foreground absolute inset-x-0 top-0 z-20 px-5 py-1.5 text-center text-xs"
        role="alert"
      >
        {appError.message}
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
      {welcomeOpen ? <ClipboardWelcomeDialog onClose={closeWelcome} /> : null}
      {contextMenu.type === "closed" ? null : (
        <ClipboardContextMenu
          groups={snapshot.groups}
          menu={contextMenu}
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
      )}
      <main className="relative min-h-0 flex-1">
        {feedback}

        {filteredItems.length === 0 ? (
          <div className="text-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="bg-foreground/6 text-foreground/70 grid size-11 place-items-center rounded-2xl shadow-sm/5">
              {filterQuery ? (
                <SearchIcon aria-hidden="true" className="size-5" />
              ) : (
                <ClipboardIcon aria-hidden="true" className="size-5" />
              )}
            </span>
            <p className="text-foreground/82 text-wrap-balance max-w-sm text-sm font-medium">
              {filterQuery || activeGroupId
                ? emptyStateTitle
                : t("emptyDescription")}
            </p>
          </div>
        ) : (
          <div
            aria-label={t("timeline")}
            className="absolute inset-0 flex scrollbar-none items-stretch gap-3 overflow-x-auto overscroll-x-none px-5 py-1"
            onPointerMove={handleRailPointerMove}
            ref={timelineRailRef}
            role="list"
          >
            {railWindow.start > 0 ? (
              <div
                aria-hidden="true"
                className="shrink-0"
                style={{
                  width:
                    railWindow.start * CLIPBOARD_CARD_STRIDE -
                    CLIPBOARD_CARD_GAP,
                }}
              />
            ) : null}
            {filteredItems
              // Index-based filtering keeps the callback shape the React
              // Compiler can memoize; slicing and re-deriving the index here
              // made it drop the component's manual memoization.
              .map((item, index) => {
                if (index < railWindow.start || index >= railWindow.end) {
                  return null;
                }
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
                    onRename={(id, name) =>
                      applySnapshotCommand("clipboard_set_item_name", {
                        id,
                        name,
                      })
                    }
                    onSelect={setSelectedIndex}
                    query={filterQuery}
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
            {railWindow.end < filteredItems.length ? (
              <div
                aria-hidden="true"
                className="shrink-0"
                style={{
                  width:
                    (filteredItems.length - railWindow.end) *
                      CLIPBOARD_CARD_STRIDE -
                    CLIPBOARD_CARD_GAP,
                }}
              />
            ) : null}
          </div>
        )}
      </main>

      <footer className="clipboard-controls grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_minmax(12rem,22rem)_minmax(0,1fr)] items-center gap-2 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 items-center gap-0.5">
            <a
              aria-label="Stella"
              className="text-foreground grid size-11 place-items-center"
              href={STELLA_WEB_APP_URL}
              onClick={(event) => {
                event.preventDefault();
                void invoke("clipboard_open_stella").catch(() => {
                  reportDesktopError({
                    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
                    operation:
                      DESKTOP_TELEMETRY_OPERATIONS.clipboardExternalOpen,
                    window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
                  });
                  setError({
                    message: t("errorOpenStella"),
                    source: "operation",
                  });
                });
              }}
              title="Stella"
            >
              <StellaMark className="size-5" />
            </a>
            {snapshot.persistence.status === "memoryOnly" ||
            snapshot.persistence.status === "deletionOnly" ? (
              <span
                aria-label={persistenceWarningLabel}
                className="bg-warning/12 text-warning grid size-7 place-items-center rounded-full"
                role="status"
                title={persistenceWarningLabel}
              >
                <ShieldAlertIcon aria-hidden="true" className="size-3.5" />
              </span>
            ) : null}
            <Button
              aria-label={t("createGroup")}
              className="size-11 shrink-0 rounded-full"
              disabled={snapshot.groups.length >= 24}
              onClick={() =>
                setDialog({
                  color: nextGroupColor,
                  name: "",
                  type: "createGroup",
                })
              }
              size="icon"
              title={t("createGroup")}
              variant="ghost"
            >
              <FolderPlusIcon aria-hidden="true" className="size-4" />
            </Button>
          </div>

          <nav
            aria-label={t("groups")}
            className="clipboard-groups-rail flex min-w-0 flex-1 scrollbar-none items-center gap-1 overflow-x-auto"
          >
            <Button
              aria-pressed={activeGroupId === null}
              className="h-11 shrink-0 rounded-full px-3 text-xs"
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
                "--clipboard-group-accent":
                  CLIPBOARD_GROUP_ACCENTS[group.color],
              };
              return (
                <Button
                  aria-pressed={activeGroupId === group.id}
                  className="clipboard-group-chip h-11 shrink-0 rounded-full px-3 text-xs"
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
          </nav>
        </div>

        <InputGroup className="clipboard-search h-11 w-full rounded-full">
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

        <div className="flex shrink-0 items-center gap-0.5 justify-self-end">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={t("moreOptions")}
                  className="size-11 rounded-full"
                  size="icon"
                  title={t("moreOptions")}
                  variant="ghost"
                />
              }
            >
              <EllipsisIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-60" side="top">
              <MenuItem
                className="min-h-11 rounded-xl"
                onClick={() => {
                  applySnapshotCommand("clipboard_set_capture_status", {
                    status: nextCaptureStatus,
                  });
                }}
              >
                {captureActive ? <PauseIcon /> : <PlayIcon />}
                {captureActionLabel}
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger className="min-h-11 rounded-xl">
                  <ClockIcon />
                  {t("retention")}
                </MenuSubTrigger>
                <MenuSubPopup className="w-56">
                  <MenuRadioGroup value={snapshot.retention}>
                    {CLIPBOARD_RETENTIONS.map((retention) => (
                      <MenuRadioItem
                        className="min-h-11 rounded-xl"
                        key={retention}
                        onClick={() => {
                          applySnapshotCommand("clipboard_set_retention", {
                            retention,
                          });
                        }}
                        value={retention}
                      >
                        {t(RETENTION_LABEL_KEYS[retention])}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuSubPopup>
              </MenuSub>
              <MenuItem
                className="min-h-11 rounded-xl"
                disabled={
                  snapshot.items.length === 0 &&
                  snapshot.persistence.status !== "deletionOnly"
                }
                onClick={() => {
                  setDialog({ type: "clearHistory" });
                }}
                variant="destructive"
              >
                <Trash2Icon />
                {t("clear")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                className="min-h-11 rounded-xl"
                onClick={() => {
                  setWelcomeDismissed(false);
                  setWelcomeRequested(true);
                }}
              >
                <CircleHelpIcon />
                {t("welcomeHelp")}
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Button
            aria-label={t("close")}
            className="size-11 rounded-full"
            onClick={requestHide}
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
