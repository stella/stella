import { useRef, useState } from "react";
import type { CSSProperties } from "react";

import { attachClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { invoke } from "@tauri-apps/api/core";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ContextMenuActionItems } from "@stll/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { useExternalSyncEffect, useLatestCallback } from "@stll/ui/effects";
import { EntityActions } from "@stll/ui/entity-actions";
import type { EntityAction } from "@stll/ui/entity-actions";
import { Form } from "@stll/ui/form";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  GripVerticalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "@stll/ui/icons";
import type { InlineDropPosition } from "@stll/ui/inline-reorder";
import {
  ListEmpty,
  ListItem,
  ListItemActions,
  ListItemContent,
} from "@stll/ui/list";
import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import {
  SettingsPanel,
  SettingsRow,
  settingsRowIds,
  SettingsSection,
} from "@stll/ui/settings";
import { Switch } from "@stll/ui/switch";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { CLIPBOARD_GROUP_DRAG_TYPE } from "../clipboard/clipboard-logic";
import {
  canCreateClipboardGroup,
  CLIPBOARD_RETENTION_LABEL_KEYS,
  clipboardGroupDropIndex,
  clipboardGroupStepIndex,
  clipboardSettingsCommands,
  verticalDropPosition,
} from "../clipboard/clipboard-settings";
import type { ClipboardGroupDialogState } from "../clipboard/clipboard-settings";
import {
  CLIPBOARD_HISTORY_CHANGED_EVENT,
  CLIPBOARD_RETENTIONS,
  isClipboardRetention,
  isClipboardSettingsSnapshot,
} from "../clipboard/clipboard-types";
import type {
  ClipboardGroup,
  ClipboardSettingsSnapshot,
} from "../clipboard/clipboard-types";
import {
  ClipboardGroupDialogBody,
  useClipboardGroupDialogFrame,
} from "../clipboard/ClipboardGroupDialog";
import { nextClipboardGroupColor } from "../clipboard/ClipboardGroupFields";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { useNativeStatus } from "./AgentSubscriptionsSection";

const readClipboardSettings = async () =>
  invoke<unknown>("clipboard_get_settings");

/** Which section a failed change belongs to, so its error shows there. */
type ClipboardSettingsFailure = "history" | "groups" | null;

/**
 * The clipboard's settings in the Settings window: how history is kept and
 * the groups the Clips window shows. Both windows change the same settings
 * and each reads again on the change event the other's command sends.
 */
export const ClipboardSettingsSections = () => {
  const [stored, refresh] = useNativeStatus({
    event: CLIPBOARD_HISTORY_CHANGED_EVENT,
    isStatus: isClipboardSettingsSnapshot,
    read: readClipboardSettings,
  });
  // A command's answer shows at once; the read its change event starts
  // replaces it once it is as new.
  const [answered, setAnswered] = useState<ClipboardSettingsSnapshot | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ClipboardSettingsFailure>(null);
  const [dialog, setDialog] = useState<ClipboardGroupDialogState | null>(null);

  const settings =
    answered !== null &&
    (stored === null || answered.revision > stored.revision)
      ? answered
      : stored;
  if (settings === null) {
    return null;
  }

  const run = async (
    section: Exclude<ClipboardSettingsFailure, null>,
    command: () => Promise<ClipboardSettingsSnapshot | null>,
  ) => {
    setPending(true);
    setFailure(null);
    const answer = await command().catch(() => undefined);
    setPending(false);
    if (answer) {
      setAnswered(answer);
      return true;
    }
    // Fixed codes only: a settings error may name a group or an app.
    reportDesktopError({
      code:
        answer === null
          ? DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse
          : DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
      operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryUpdate,
      window: DESKTOP_TELEMETRY_WINDOWS.main,
    });
    setFailure(section);
    refresh();
    return false;
  };

  const moveGroup = (id: string, index: number | null) => {
    if (index !== null) {
      void run("groups", async () =>
        clipboardSettingsCommands.moveGroup({ id, index }),
      );
    }
  };

  return (
    <>
      <ClipboardHistorySection
        failed={failure === "history"}
        onRun={(command) => {
          void run("history", command);
        }}
        pending={pending}
        settings={settings}
      />
      <ClipboardGroupsSection
        failed={failure === "groups"}
        onCreate={() => {
          setDialog({
            color: nextClipboardGroupColor(settings.groups),
            itemId: null,
            name: "",
            type: "createGroup",
          });
        }}
        onDelete={(group) => {
          setDialog({
            groupId: group.id,
            groupName: group.name,
            mode: "keepClips",
            type: "deleteGroup",
          });
        }}
        onDrop={({ draggedId, position, targetId }) => {
          moveGroup(
            draggedId,
            clipboardGroupDropIndex({
              draggedId,
              groups: settings.groups,
              position,
              targetId,
            }),
          );
        }}
        onEdit={(group) => {
          setDialog({
            color: group.color,
            groupId: group.id,
            name: group.name,
            type: "editGroup",
          });
        }}
        onStep={(id, step) => {
          moveGroup(id, clipboardGroupStepIndex(settings.groups, id, step));
        }}
        pending={pending}
        settings={settings}
      />
      {dialog === null ? null : (
        <ClipboardSettingsGroupDialog
          dialog={dialog}
          failed={failure === "groups"}
          onChange={setDialog}
          onClose={() => {
            setDialog(null);
            setFailure(null);
          }}
          onSubmit={(submitted) => {
            void run("groups", async () =>
              clipboardSettingsCommands.submitGroupDialog(submitted),
            ).then((succeeded) => {
              if (succeeded) {
                setDialog(null);
              }
              return undefined;
            });
          }}
        />
      )}
    </>
  );
};

/** A group dialog in the Settings window's dialog style; a failed save
 *  shows inside it, where the user is looking. */
const ClipboardSettingsGroupDialog = ({
  dialog,
  failed,
  onChange,
  onClose,
  onSubmit,
}: {
  dialog: ClipboardGroupDialogState;
  failed: boolean;
  onChange: (dialog: ClipboardGroupDialogState) => void;
  onClose: () => void;
  onSubmit: (dialog: ClipboardGroupDialogState) => void;
}) => {
  const t = useTranslations("clipboardSettings");
  const tClipboard = useTranslations("clipboard");
  const frame = useClipboardGroupDialogFrame(dialog);
  return (
    <Dialog
      dirty={frame.dirty}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogPopup showCloseButton={false} size="sm">
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(dialog);
          }}
        >
          <DialogHeader>
            <DialogTitle>{frame.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <ClipboardGroupDialogBody dialog={dialog} onChange={onChange} />
            {failed ? (
              <p
                className="text-destructive-foreground mt-3 text-xs"
                role="alert"
              >
                {t("errorSave")}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              {tClipboard("cancel")}
            </DialogClose>
            <Button
              disabled={frame.submitDisabled}
              disabledReason={tClipboard("enterGroupName")}
              type="submit"
              variant={frame.destructive ? "destructive" : "default"}
            >
              {frame.submitLabel}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};

const SettingsFailure = ({ failed }: { failed: boolean }) => {
  const t = useTranslations("clipboardSettings");
  return failed ? (
    <SettingsPanel>
      <p className="text-destructive-foreground text-xs" role="alert">
        {t("errorSave")}
      </p>
    </SettingsPanel>
  ) : null;
};

const ClipboardHistorySection = ({
  failed,
  onRun,
  pending,
  settings,
}: {
  failed: boolean;
  onRun: (command: () => Promise<ClipboardSettingsSnapshot | null>) => void;
  pending: boolean;
  settings: ClipboardSettingsSnapshot;
}) => {
  const t = useTranslations("clipboardSettings");
  const tClipboard = useTranslations("clipboard");
  const captureIds = settingsRowIds("clipboard-capture");
  const retentionIds = settingsRowIds("clipboard-retention");
  const recordingsIds = settingsRowIds("clipboard-recordings");
  const exclusions = settings.sourceAppExclusions;
  return (
    <SettingsSection title={t("history")}>
      <SettingsRow
        description={t("captureDescription")}
        id="clipboard-capture"
        interaction="label"
        title={t("capture")}
      >
        <Switch
          aria-describedby={captureIds.description}
          checked={settings.captureStatus === "active"}
          disabled={pending}
          id={captureIds.control}
          onCheckedChange={(checked) => {
            onRun(async () =>
              clipboardSettingsCommands.setCaptureStatus(
                checked ? "active" : "paused",
              ),
            );
          }}
        />
      </SettingsRow>
      <SettingsRow
        description={t("retentionDescription")}
        id="clipboard-retention"
        title={tClipboard("retention")}
      >
        <Select<string>
          disabled={pending}
          onValueChange={(value) => {
            if (isClipboardRetention(value) && value !== settings.retention) {
              onRun(async () => clipboardSettingsCommands.setRetention(value));
            }
          }}
          value={settings.retention}
        >
          <SelectTrigger
            aria-describedby={retentionIds.description}
            aria-labelledby={retentionIds.label}
            className="w-40"
          >
            <SelectValue>
              {(value: unknown) =>
                isClipboardRetention(value)
                  ? tClipboard(CLIPBOARD_RETENTION_LABEL_KEYS[value])
                  : null
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {CLIPBOARD_RETENTIONS.map((retention) => (
              <SelectItem key={retention} value={retention}>
                {tClipboard(CLIPBOARD_RETENTION_LABEL_KEYS[retention])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </SettingsRow>
      <SettingsRow
        description={t("recordingsDescription")}
        id="clipboard-recordings"
        interaction="label"
        title={tClipboard("showInRecordings")}
      >
        <Switch
          aria-describedby={recordingsIds.description}
          checked={settings.screenCapture === "visible"}
          disabled={pending}
          id={recordingsIds.control}
          onCheckedChange={(checked) => {
            onRun(async () =>
              clipboardSettingsCommands.setScreenCapture(
                checked ? "visible" : "hidden",
              ),
            );
          }}
        />
      </SettingsRow>
      <SettingsRow
        description={
          exclusions.length === 0
            ? t("excludedEmpty")
            : t("excludedDescription")
        }
        id="clipboard-excluded"
        title={tClipboard("excludedApplications")}
      />
      {exclusions.map((exclusion) => {
        const removeLabel = tClipboard.markup("removeSourceAppExclusion", {
          bdi: (chunks) => chunks,
          source: exclusion.name,
        });
        return (
          <SettingsRow
            depth="nested"
            key={exclusion.identifier}
            title={<bdi>{exclusion.name}</bdi>}
          >
            <Button
              aria-label={removeLabel}
              onClick={() => {
                onRun(async () =>
                  clipboardSettingsCommands.removeSourceAppExclusion(
                    exclusion.identifier,
                  ),
                );
              }}
              size="icon"
              title={removeLabel}
              variant="ghost"
            >
              <XIcon aria-hidden="true" className="size-4" />
            </Button>
          </SettingsRow>
        );
      })}
      <SettingsFailure failed={failed} />
    </SettingsSection>
  );
};

type ClipboardGroupDrop = {
  draggedId: string;
  position: InlineDropPosition;
  targetId: string;
};

const ClipboardGroupsSection = ({
  failed,
  onCreate,
  onDelete,
  onDrop,
  onEdit,
  onStep,
  pending,
  settings,
}: {
  failed: boolean;
  onCreate: () => void;
  onDelete: (group: ClipboardGroup) => void;
  onDrop: (drop: ClipboardGroupDrop) => void;
  onEdit: (group: ClipboardGroup) => void;
  onStep: (id: string, step: -1 | 1) => void;
  pending: boolean;
  settings: ClipboardSettingsSnapshot;
}) => {
  const t = useTranslations("clipboardSettings");
  const tClipboard = useTranslations("clipboard");
  const canCreate = canCreateClipboardGroup(settings);
  const limitReached = tClipboard("groupLimitReached", {
    max: settings.groupLimit,
  });
  const { groups } = settings;
  return (
    <SettingsSection
      action={
        <Button
          disabled={pending || !canCreate}
          disabledReason={canCreate ? undefined : limitReached}
          onClick={onCreate}
          variant="ghost"
        >
          <PlusIcon aria-hidden="true" />
          {tClipboard("createGroup")}
        </Button>
      }
      description={canCreate ? t("groupsDescription") : limitReached}
      title={tClipboard("groups")}
    >
      {groups.length === 0 ? <ListEmpty>{t("groupsEmpty")}</ListEmpty> : null}
      {groups.map((group, index) => (
        <ClipboardGroupRow
          disabled={pending}
          group={group}
          isFirst={index === 0}
          isLast={index === groups.length - 1}
          key={group.id}
          onDelete={() => onDelete(group)}
          onDrop={onDrop}
          onEdit={() => onEdit(group)}
          onStep={(step) => onStep(group.id, step)}
        />
      ))}
      <SettingsFailure failed={failed} />
    </SettingsSection>
  );
};

type ClipboardGroupAccentStyle = CSSProperties & {
  "--clipboard-group-accent": string;
};

const draggedGroupId = (data: Record<string | symbol, unknown>) =>
  data["type"] === CLIPBOARD_GROUP_DRAG_TYPE &&
  typeof data["groupId"] === "string"
    ? data["groupId"]
    : null;

/** One group: its colour and name, and its actions, which also move it from
 *  the keyboard. The row itself drags. */
const ClipboardGroupRow = ({
  disabled,
  group,
  isFirst,
  isLast,
  onDelete,
  onDrop,
  onEdit,
  onStep,
}: {
  disabled: boolean;
  group: ClipboardGroup;
  isFirst: boolean;
  isLast: boolean;
  onDelete: () => void;
  onDrop: (drop: ClipboardGroupDrop) => void;
  onEdit: () => void;
  onStep: (step: -1 | 1) => void;
}) => {
  const t = useTranslations("clipboardSettings");
  const tClipboard = useTranslations("clipboard");
  const rowRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState<InlineDropPosition | null>(null);
  const drop = useLatestCallback(
    (draggedId: string, position: InlineDropPosition) =>
      onDrop({ draggedId, position, targetId: group.id }),
  );
  const canDrag = useLatestCallback(() => !disabled);

  useExternalSyncEffect(() => {
    const element = rowRef.current;
    if (element === null) {
      return undefined;
    }
    return combine(
      draggable({
        canDrag: () => canDrag(),
        element,
        getInitialData: () => ({
          groupId: group.id,
          type: CLIPBOARD_GROUP_DRAG_TYPE,
        }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        canDrop: ({ source }) => {
          const draggedId = draggedGroupId(source.data);
          return draggedId !== null && draggedId !== group.id;
        },
        element,
        getData: ({ input }) =>
          attachClosestEdge(
            {},
            { allowedEdges: ["top", "bottom"], element, input },
          ),
        onDrag: ({ self }) => {
          const position = verticalDropPosition(extractClosestEdge(self.data));
          setOver((current) => (current === position ? current : position));
        },
        onDragLeave: () => setOver(null),
        onDrop: ({ self, source }) => {
          setOver(null);
          const position = verticalDropPosition(extractClosestEdge(self.data));
          const draggedId = draggedGroupId(source.data);
          if (position !== null && draggedId !== null) {
            drop(draggedId, position);
          }
        },
      }),
    );
  }, [canDrag, drop, group.id]);

  // One list for the right-click menu and the row's "…" button.
  const actions = [
    {
      disabled,
      icon: <PencilIcon aria-hidden="true" />,
      label: tClipboard("editGroup"),
      onClick: onEdit,
    },
    {
      disabled: disabled || isFirst,
      icon: <ArrowUpIcon aria-hidden="true" />,
      label: t("moveGroupUp"),
      onClick: () => onStep(-1),
      separatorBefore: true,
    },
    {
      disabled: disabled || isLast,
      icon: <ArrowDownIcon aria-hidden="true" />,
      label: t("moveGroupDown"),
      onClick: () => onStep(1),
    },
    {
      disabled,
      icon: <Trash2Icon aria-hidden="true" />,
      label: tClipboard("deleteGroup"),
      onClick: onDelete,
      separatorBefore: true,
      variant: "destructive",
    },
  ] as const satisfies readonly EntityAction[];
  const actionsLabel = t("groupActions", { groupName: group.name });
  const accent: ClipboardGroupAccentStyle = {
    "--clipboard-group-accent": group.color,
  };
  return (
    <EntityActions actions={actions} label={actionsLabel}>
      <ListItem
        className={cn(
          "group/clipboard-group relative",
          !disabled && "cursor-grab",
          dragging && "opacity-50",
        )}
        data-clipboard-settings-group-id={group.id}
        ref={rowRef}
      >
        <GripVerticalIcon
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0 opacity-50 transition-opacity group-hover/clipboard-group:opacity-100"
        />
        <ListItemContent className="items-start">
          <span
            className="clipboard-group-chip text-foreground inline-flex h-8 max-w-full items-center gap-1.5 rounded-full px-3 text-xs font-medium"
            data-group-chip=""
            style={accent}
          >
            <span
              aria-hidden="true"
              className="clipboard-group-chip-dot size-2 shrink-0 rounded-full"
            />
            <TruncatedText>{group.name}</TruncatedText>
          </span>
        </ListItemContent>
        <ListItemActions>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={actionsLabel}
                  size="icon"
                  title={actionsLabel}
                  variant="ghost"
                />
              }
            >
              <EllipsisIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <ContextMenuActionItems actions={actions} />
            </MenuPopup>
          </Menu>
        </ListItemActions>
        {over === null ? null : (
          <span
            aria-hidden="true"
            className={cn(
              "bg-primary pointer-events-none absolute inset-x-3 z-20 h-0.5 rounded-full",
              over === "before" ? "top-0" : "bottom-0",
            )}
          />
        )}
      </ListItem>
    </EntityActions>
  );
};
