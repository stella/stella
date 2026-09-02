import { useQuery } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
} from "@stll/ui/select";
import { cn } from "@stll/ui/utils";

import { DatePickerPopover as DatePickerPopoverBase } from "@/components/date-picker-popover";
import type { DatePickerPopoverProps as DatePickerPopoverBaseProps } from "@/components/date-picker-popover";
import { UserIdentity } from "@/components/user-avatar";
import {
  PRIORITY_COLORS,
  PRIORITY_ICONS,
  ITEM_TYPE_TRANSLATION_KEYS,
  LIST_ITEM_TYPES,
  STATUS_COLORS,
  STATUS_ICONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "@/components/workspaces/tasks/task-detail-constants";
import { useLocale } from "@/i18n/formatting-context";
import {
  useAddTaskAssignee,
  useRemoveTaskAssignee,
} from "@/lib/workspaces/mutations/tasks";
import { workspaceMembersOptions } from "@/lib/workspaces/queries/workspace-members";

import type {
  ListItemType,
  TaskPriority,
  TaskStatus,
} from "./task-detail-constants";

const WORK_TYPES = ["task", "deadline"] as const;

export type WorkType = (typeof WORK_TYPES)[number];

// -- Layout helper --

export const MetadataRow = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="flex items-center gap-3">
    <span className="text-muted-foreground w-24 shrink-0 text-xs">{label}</span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

// -- Icon helpers --

const StatusIcon = ({ status }: { status: TaskStatus }) => {
  const Icon = STATUS_ICONS[status];
  return <Icon className={cn("size-3.5", STATUS_COLORS[status])} />;
};

const PriorityIcon = ({ priority }: { priority: TaskPriority }) => {
  const Icon = PRIORITY_ICONS[priority];
  return <Icon className={cn("size-3.5", PRIORITY_COLORS[priority])} />;
};

// -- Status select --

type StatusSelectProps = {
  value: TaskStatus;
  onChange: (value: TaskStatus | null) => void;
};

export const StatusSelect = ({ value, onChange }: StatusSelectProps) => {
  const t = useTranslations("tasks");
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger
        className="min-h-11 min-w-0 gap-1 border-none bg-transparent px-1.5 shadow-none"
        size="sm"
      >
        <StatusIcon status={value} />
        <span className="truncate">{t(`statusValues.${value}`)}</span>
      </SelectTrigger>
      <SelectPopup>
        {TASK_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            <span className="flex items-center gap-2">
              <StatusIcon status={s} />
              {t(`statusValues.${s}`)}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

// -- Priority select --

type PrioritySelectProps = {
  value: TaskPriority;
  onChange: (value: TaskPriority | null) => void;
};

export const PrioritySelect = ({ value, onChange }: PrioritySelectProps) => {
  const t = useTranslations("tasks");
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger
        className="h-7 min-h-7 min-w-0 gap-1 border-none bg-transparent px-1.5 shadow-none"
        size="sm"
      >
        <PriorityIcon priority={value} />
        <span className="truncate">{t(`priorityValues.${value}`)}</span>
      </SelectTrigger>
      <SelectPopup>
        {TASK_PRIORITIES.map((p) => (
          <SelectItem key={p} value={p}>
            <span className="flex items-center gap-2">
              <PriorityIcon priority={p} />
              {t(`priorityValues.${p}`)}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

// -- Work type select --

type WorkTypeSelectProps = {
  value: WorkType;
  onChange: (value: WorkType | null) => void;
};

export const WorkTypeSelect = ({ value, onChange }: WorkTypeSelectProps) => {
  const t = useTranslations("tasks");

  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger
        className="h-7 min-h-7 min-w-0 gap-1 border-none bg-transparent px-1.5 shadow-none"
        size="sm"
      >
        <span className="truncate">{t(`workTypeValues.${value}`)}</span>
      </SelectTrigger>
      <SelectPopup>
        {WORK_TYPES.map((type) => (
          <SelectItem key={type} value={type}>
            {t(`workTypeValues.${type}`)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

// -- List item type select --

type ItemTypeSelectProps = {
  ariaLabel: string;
  value: ListItemType;
  onChange: (value: ListItemType | null) => void;
};

export const ItemTypeSelect = ({
  ariaLabel,
  value,
  onChange,
}: ItemTypeSelectProps) => {
  const t = useTranslations();

  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger
        aria-label={ariaLabel}
        className="h-7 min-h-7 min-w-0 border-none bg-transparent px-1.5 shadow-none"
        size="sm"
      >
        <span className="truncate">{t(ITEM_TYPE_TRANSLATION_KEYS[value])}</span>
      </SelectTrigger>
      <SelectPopup>
        {LIST_ITEM_TYPES.map((itemType) => (
          <SelectItem key={itemType} value={itemType}>
            {t(ITEM_TYPE_TRANSLATION_KEYS[itemType])}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

// -- Date picker --

type DatePickerPopoverProps = Omit<
  DatePickerPopoverBaseProps,
  "locale" | "clearLabel" | "todayLabel" | "overdueLabel"
>;

const hasDeletedAccount = (
  deletedAt: Date | string | null | undefined,
): boolean => deletedAt !== null && deletedAt !== undefined;

export const DatePickerPopover = (props: DatePickerPopoverProps) => {
  const t = useTranslations("tasks");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  return (
    <DatePickerPopoverBase
      {...props}
      clearLabel={t("clearDate")}
      locale={locale}
      overdueLabel={t("overdue")}
      // The props type omits all four labels so this wrapper owns them, but
      // `todayLabel` was never supplied: the base fell back to its own
      // Intl-derived string while its siblings came from the catalogue. An
      // omit also only rejects a literal attribute — a props object typed
      // wider stays assignable and carries a label through the spread — so
      // every pinned label sits after it.
      todayLabel={tCommon("today")}
    />
  );
};

// -- Accountable owner picker --

type OwnerPickerProps = {
  workspaceId: string;
  owner: {
    id: string;
    name: string | null;
    image: string | null;
    deletedAt?: Date | string | null;
  } | null;
  reason: string;
  disabled?: boolean;
  onChange: (userId: string) => void;
};

export const OwnerPicker = ({
  workspaceId,
  owner,
  reason,
  disabled,
  onChange,
}: OwnerPickerProps) => {
  const t = useTranslations("tasks");
  const { data: members } = useQuery(workspaceMembersOptions(workspaceId));
  const selectableMembers = members?.filter(
    (member) => member.user && member.user.id !== owner?.id,
  );

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            className="hover:bg-muted flex min-h-11 w-full items-center gap-1.5 rounded-md px-1.5 text-sm transition-colors"
            disabled={disabled}
            type="button"
          />
        }
      >
        {owner ? (
          <UserIdentity
            as="span"
            avatarClassName="size-4 shrink-0 text-[10px]"
            className="gap-1.5"
            deleted={hasDeletedAccount(owner.deletedAt)}
            image={owner.image}
            name={owner.name ?? t("deletedAccount")}
            nameClassName="text-sm font-normal"
          />
        ) : (
          <span className="text-muted-foreground">{t("noOwner")}</span>
        )}
      </PopoverTrigger>
      <PopoverPopup className="w-64 p-2" side="bottom">
        <div className="flex flex-col gap-2">
          <div className="flex max-h-56 flex-col overflow-y-auto">
            {selectableMembers?.map((member) => {
              const candidate = member.user;
              if (!candidate) {
                return null;
              }
              return (
                <button
                  className="hover:bg-muted flex min-h-11 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors disabled:opacity-50"
                  disabled={owner !== null && reason.trim().length === 0}
                  key={candidate.id}
                  onClick={() => {
                    onChange(candidate.id);
                  }}
                  type="button"
                >
                  <UserIdentity
                    as="span"
                    avatarClassName="size-5 text-[10px]"
                    image={candidate.image}
                    name={candidate.name}
                    nameClassName="text-sm font-normal"
                  />
                </button>
              );
            })}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
};

// -- Assignee picker --

type AssigneePickerProps = {
  workspaceId: string;
  taskId: string;
  assignees: {
    user: {
      id: string;
      name: string | null;
      image: string | null;
      deletedAt?: Date | string | null;
    };
  }[];
};

export const AssigneePicker = ({
  workspaceId,
  taskId,
  assignees,
}: AssigneePickerProps) => {
  const t = useTranslations("tasks");
  const tCommon = useTranslations("common");
  const { data: members } = useQuery(workspaceMembersOptions(workspaceId));

  const assignedIds = new Set(assignees.map((a) => a.user.id));

  const addAssignee = useAddTaskAssignee(workspaceId);
  const removeAssignee = useRemoveTaskAssignee(workspaceId);

  const unassignedMembers = members?.filter(
    (m) => m.user && !assignedIds.has(m.user.id),
  );

  return (
    <div className="flex flex-col gap-1">
      {assignees.map((a) => (
        <div
          className="group/assignee flex items-center gap-1.5 rounded-md px-1.5 py-0.5"
          key={a.user.id}
        >
          <UserIdentity
            avatarClassName="size-4 text-[10px]"
            className="flex-1 gap-1.5"
            deleted={hasDeletedAccount(a.user.deletedAt)}
            image={a.user.image}
            name={a.user.name?.trim() || tCommon("unknownUser")}
            nameClassName="text-sm font-normal"
          />
          {hasDeletedAccount(a.user.deletedAt) ? (
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
              {t("deletedAccount")}
            </span>
          ) : null}
          <Button
            aria-label={tCommon("remove")}
            className="size-5 opacity-0 transition-opacity group-hover/assignee:opacity-100"
            disabled={removeAssignee.isPending}
            onClick={() => removeAssignee.mutate({ taskId, userId: a.user.id })}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
      {unassignedMembers && unassignedMembers.length > 0 && (
        <Popover>
          <PopoverTrigger
            render={
              <button
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm transition-colors"
                type="button"
              />
            }
          >
            <PlusIcon className="size-3.5" />
            <span>{t("addAssignee")}</span>
          </PopoverTrigger>
          <PopoverPopup
            className="*:data-[slot=popover-viewport]:p-1!"
            side="bottom"
          >
            <div className="flex w-48 flex-col">
              {unassignedMembers.map((m) => {
                const user = m.user;
                if (!user) {
                  return null;
                }
                return (
                  <button
                    className="hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
                    key={user.id}
                    onClick={() =>
                      addAssignee.mutate({ taskId, userId: user.id })
                    }
                    type="button"
                  >
                    <UserIdentity
                      as="span"
                      avatarClassName="size-5 text-[10px]"
                      image={user.image}
                      name={user.name.trim() || tCommon("unknownUser")}
                      nameClassName="text-sm font-normal"
                    />
                  </button>
                );
              })}
            </div>
          </PopoverPopup>
        </Popover>
      )}
      {assignees.length === 0 &&
        (!unassignedMembers || unassignedMembers.length === 0) && (
          <span className="text-muted-foreground px-1.5 text-sm">
            {t("noAssignees")}
          </span>
        )}
    </div>
  );
};
