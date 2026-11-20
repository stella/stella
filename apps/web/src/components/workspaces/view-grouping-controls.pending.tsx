import type { ReactNode } from "react";

import { ButtonFace, SelectTriggerFace } from "@stll/ui/control-face";
import { Settings2Icon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";
import { getInternalPropertyId } from "@/components/workspaces/internal-ids.logic";

/** The group-by choice that groups nothing, where a control allows it. */
export const GROUP_BY_NONE_VALUE = "_none";

type GroupByChoiceLabelKey =
  | "common.assignee"
  | "common.author"
  | "common.kind"
  | "common.none"
  | "tasks.status";

/**
 * The words a group-by choice reads as when it is not a property of the
 * matter's (no grouping, or one of the entity's own fields); `null` for a
 * property, whose name only the properties know.
 */
export const groupByChoiceLabelKey = (
  choiceId: string,
): GroupByChoiceLabelKey | null => {
  switch (choiceId) {
    case GROUP_BY_NONE_VALUE:
      return "common.none";
    case getInternalPropertyId("kind"):
      return "common.kind";
    case getInternalPropertyId("status"):
      return "tasks.status";
    case getInternalPropertyId("created-by"):
      return "common.author";
    case getInternalPropertyId("assignee"):
      return "common.assignee";
    default:
      return null;
  }
};

/** The group-by select's box: narrow on a phone, sized to its value from sm. */
export const GROUP_BY_TRIGGER_CLASS =
  "h-7 min-h-0 w-28 sm:h-6 sm:w-auto sm:min-w-24";

/**
 * The group-by control's row: its label (from `sm`, or none) and the select.
 */
export const GroupByControlRow = ({
  children,
  label,
}: {
  children: ReactNode;
  label: ReactNode;
}) => (
  <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap">
    {label !== null && (
      <span className="text-muted-foreground hidden shrink-0 sm:inline">
        {label}
      </span>
    )}
    {children}
  </span>
);

/** The board's settings button: its size and variant. */
export const KANBAN_SETTINGS_BUTTON = {
  size: "xs",
  variant: "outline",
} as const;

/** The board's settings button's content: the glyph, and its name from sm. */
export const KanbanSettingsTriggerContent = ({
  label,
}: {
  label: ReactNode;
}) => (
  <>
    <Settings2Icon className="size-3.5" />
    <span className="hidden sm:inline">{label}</span>
  </>
);

/**
 * `GroupByControl` (./view-grouping-controls.tsx) before the properties are
 * read, with its label: `value` is the choice's words, or a bar where they
 * name a property.
 */
export const GroupByControlFace = ({ value }: { value: ReactNode }) => (
  <GroupByControlRow
    label={<PendingText barClassName="w-14" id="workspaces.views.groupBy" />}
  >
    <SelectTriggerFace className={GROUP_BY_TRIGGER_CLASS} size="sm">
      {value}
    </SelectTriggerFace>
  </GroupByControlRow>
);

/** `KanbanGroupingSettings`'s trigger before the page has loaded. */
export const KanbanGroupingSettingsFace = () => (
  <ButtonFace
    size={KANBAN_SETTINGS_BUTTON.size}
    variant={KANBAN_SETTINGS_BUTTON.variant}
  >
    <KanbanSettingsTriggerContent
      label={<PendingText barClassName="w-12" id="common.settings" />}
    />
  </ButtonFace>
);
