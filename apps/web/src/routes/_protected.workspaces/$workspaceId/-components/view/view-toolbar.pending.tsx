import type { ComponentType, ReactNode } from "react";

import {
  ButtonFace,
  FaceLabelPending,
  SegmentedIconToggleFace,
  SelectTriggerFace,
} from "@stll/ui/control-face";
import {
  AlignJustifyIcon,
  CalendarIcon,
  DownloadIcon,
  EyeIcon,
  Rows3Icon,
  SearchIcon,
  WrapTextIcon,
} from "@stll/ui/icons";
import { SortChipsFace } from "@stll/workspace-ui/sorts-face";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import {
  GROUP_BY_NONE_VALUE,
  groupByChoiceLabelKey,
  GroupByControlFace,
  KanbanGroupingSettingsFace,
} from "@/components/workspaces/view-grouping-controls.pending";
import { FilterChipsFace } from "@/components/workspaces/view-toolbar-filters.pending";
import type { TranslationKey } from "@/i18n/types";
import type { ViewLayout, WorkspaceView } from "@/lib/types";
import type { TableContentMode } from "@/lib/workspaces/table-store";

/*
 * The matter view toolbar's faces and the pieces its controls share with
 * them. `ViewToolbar` (./view-toolbar.tsx) builds each trigger from the
 * constants here, and `ViewToolbarFace` draws the same triggers unavailable,
 * so the loading view's row and the loaded one cannot drift.
 */

/** The rule between the toolbar's groups of controls. */
export const ViewToolbarDivider = () => (
  <span aria-hidden="true" className="bg-border mx-1 h-4 w-px" />
);

/** A label beside the select it names (a calendar's or timeline's dates). */
export const TOOLBAR_FIELD_ROW_CLASS = "flex items-center gap-1 text-xs";

/** "Show by", before the calendar's date select. */
export const CALENDAR_SHOW_BY_LABEL_CLASS = "text-muted-foreground shrink-0";

/** "Start date" and "End date", before the timeline's selects. */
export const TIMELINE_DATE_LABEL_CLASS = "text-muted-foreground";

/** The select of a calendar's or timeline's date property. */
export const DATE_PROPERTY_TRIGGER_CLASS = "h-6 min-h-0 min-w-24";

/** A row of buttons that pick one value (the calendar's mode, the zoom). */
export const TOOLBAR_CHOICE_ROW_CLASS = "flex items-center gap-0.5 text-xs";

/** One button of such a row: raised while it is the chosen value. */
export const toolbarChoiceButton = (chosen: boolean) =>
  ({
    size: "xs",
    variant: chosen ? "secondary" : "ghost",
  }) as const;

export const CALENDAR_MODE_LABEL_KEYS = {
  year: "workspaces.views.calendar.year",
  month: "workspaces.views.calendar.month",
  week: "workspaces.views.calendar.week",
} as const satisfies Record<
  NonNullable<WorkspaceView<"calendar">["layout"]["mode"]>,
  PendingTextKey
>;

export const TIMELINE_ZOOM_LABEL_KEYS = {
  day: "workspaces.views.timeline.day",
  week: "workspaces.views.timeline.week",
  month: "workspaces.views.timeline.month",
  quarter: "workspaces.views.timeline.quarter",
} as const satisfies Record<
  NonNullable<WorkspaceView<"timeline">["layout"]["zoom"]>,
  PendingTextKey
>;

/** The entity's own dates a calendar or timeline can lay items out by. */
export const INTERNAL_DATE_OPTIONS = [
  {
    id: "_created-at",
    labelKey: "workspaces.views.calendar.createdAt",
  },
  {
    id: "_updated-at",
    labelKey: "common.lastUpdated",
  },
] as const satisfies readonly { id: string; labelKey: PendingTextKey }[];

/** A task's own dates, offered first. */
export const TASK_DATE_OPTIONS = [
  { id: "_due-date", labelKey: "tasks.dueDate" },
  { id: "_start-date", labelKey: "workspaces.views.timeline.startDate" },
] as const satisfies readonly { id: string; labelKey: PendingTextKey }[];

/**
 * The words a date choice reads as when it is one of the entity's own dates;
 * `null` for a date property, whose name only the properties know.
 */
export const ownDateLabelKey = (id: string) => {
  const option = [...INTERNAL_DATE_OPTIONS, ...TASK_DATE_OPTIONS].find(
    (candidate) => candidate.id === id,
  );
  return option === undefined ? null : option.labelKey;
};

/** "Add dates" on a calendar: its button and glyph. */
export const ADDITIONAL_DATES_BUTTON = {
  size: "xs",
  variant: "ghost",
} as const;
export const ADDITIONAL_DATES_ICON_CLASS = "me-1 size-3";

/** "Organize files" on a file view: its button and content. */
export const FILE_ORGANIZER_BUTTON = {
  size: "xs",
  variant: "outline",
} as const;

export const FileOrganizerActionContent = ({ label }: { label: ReactNode }) => (
  <>
    <Rows3Icon />
    <span className="hidden sm:inline">{label}</span>
  </>
);

/** How a table lays out its cells' content, in the toggle's order. */
export const TABLE_CONTENT_MODE_OPTIONS = [
  {
    mode: "tight",
    icon: AlignJustifyIcon,
    labelKey: "workspaces.table.tightContent",
  },
  {
    mode: "fit-content",
    icon: WrapTextIcon,
    labelKey: "workspaces.table.wrapContent",
  },
] as const satisfies readonly {
  mode: TableContentMode;
  icon: ComponentType<{ className?: string }>;
  labelKey: TranslationKey;
}[];

/** The table's export menu trigger, and its glyph (or the spinner's box). */
export const TABLE_EXPORT_BUTTON = {
  size: "icon-xs",
  variant: "ghost",
} as const;
export const TABLE_EXPORT_ICON_CLASS = "size-3.5";

/** A glyph-only trigger, as the table's find and the columns menu draw. */
const IconTriggerFace = ({ children }: { children: ReactNode }) => (
  <ButtonFace size="icon-xs" variant="ghost">
    {children}
  </ButtonFace>
);

/** The words of a date choice, or a bar where they name a property. */
const DateChoiceFace = ({ id }: { id: string }) => {
  const key = ownDateLabelKey(id);
  return key === null ? (
    <FaceLabelPending className="w-16" />
  ) : (
    <PendingText barClassName="w-16" id={key} />
  );
};

const DatePropertySelectFace = ({ id }: { id: string }) => (
  <SelectTriggerFace className={DATE_PROPERTY_TRIGGER_CLASS} size="sm">
    <DateChoiceFace id={id} />
  </SelectTriggerFace>
);

// One button per choice, in the label map's order, which is the order the
// control draws its choices in.
const ChoiceRowFace = <T extends string>({
  chosen,
  labelKeys,
}: {
  chosen: T;
  labelKeys: Record<T, PendingTextKey>;
}) => (
  <span className={TOOLBAR_CHOICE_ROW_CLASS}>
    {Object.values<PendingTextKey>(labelKeys).map((labelKey) => {
      const button = toolbarChoiceButton(labelKey === labelKeys[chosen]);
      return (
        <ButtonFace key={labelKey} size={button.size} variant={button.variant}>
          <PendingText barClassName="w-10" id={labelKey} />
        </ButtonFace>
      );
    })}
  </span>
);

/** The words the table's group-by select reads as, or a bar for a property. */
const TableGroupByValueFace = ({
  groupByPropertyId,
}: {
  groupByPropertyId: string | undefined;
}) => {
  const key = groupByChoiceLabelKey(
    groupByPropertyId === undefined || groupByPropertyId === ""
      ? GROUP_BY_NONE_VALUE
      : groupByPropertyId,
  );
  return key === null ? (
    <FaceLabelPending className="w-16" />
  ) : (
    <PendingText barClassName="w-16" id={key} />
  );
};

/** The controls a layout adds after the shared ones, each behind its rule. */
const LayoutControlsFace = ({ layout }: { layout: ViewLayout }) => {
  switch (layout.type) {
    case "kanban":
      return (
        <>
          <ViewToolbarDivider />
          <KanbanGroupingSettingsFace />
        </>
      );
    case "calendar": {
      const additionalDates = layout.additionalDatePropertyIds?.length ?? 0;
      return (
        <>
          <ViewToolbarDivider />
          <span className={TOOLBAR_FIELD_ROW_CLASS}>
            <span className={CALENDAR_SHOW_BY_LABEL_CLASS}>
              <PendingText
                barClassName="w-12"
                id="workspaces.views.calendar.showBy"
              />
            </span>
            <DatePropertySelectFace id={layout.datePropertyId} />
          </span>
          <ButtonFace
            size={ADDITIONAL_DATES_BUTTON.size}
            variant={ADDITIONAL_DATES_BUTTON.variant}
          >
            <CalendarIcon className={ADDITIONAL_DATES_ICON_CLASS} />
            {additionalDates > 0 ? (
              <FaceLabelPending className="w-12" />
            ) : (
              <PendingText
                barClassName="w-12"
                id="workspaces.views.calendar.addDates"
              />
            )}
          </ButtonFace>
          <ChoiceRowFace
            chosen={layout.mode}
            labelKeys={CALENDAR_MODE_LABEL_KEYS}
          />
        </>
      );
    }
    case "timeline":
      return (
        <>
          <ViewToolbarDivider />
          <span className={TOOLBAR_FIELD_ROW_CLASS}>
            <span className={TIMELINE_DATE_LABEL_CLASS}>
              <PendingText
                barClassName="w-14"
                id="workspaces.views.timeline.startDate"
              />
            </span>
            <DatePropertySelectFace id={layout.startDatePropertyId} />
            <span className={TIMELINE_DATE_LABEL_CLASS}>
              <PendingText
                barClassName="w-14"
                id="workspaces.views.timeline.endDate"
              />
            </span>
            <DatePropertySelectFace id={layout.endDatePropertyId} />
          </span>
          <ChoiceRowFace
            chosen={layout.zoom}
            labelKeys={TIMELINE_ZOOM_LABEL_KEYS}
          />
        </>
      );
    case "filesystem":
      return (
        <>
          <ViewToolbarDivider />
          <ButtonFace
            size={FILE_ORGANIZER_BUTTON.size}
            variant={FILE_ORGANIZER_BUTTON.variant}
          >
            <FileOrganizerActionContent
              label={
                <PendingText
                  barClassName="w-20"
                  id="workspaces.importOrganizer.action"
                />
              }
            />
          </ButtonFace>
        </>
      );
    case "table":
      // The playbook runner and "New column" follow these, behind what the
      // member may use and how many columns the matter has: the face leaves
      // them out, at the row's end, where their arrival moves nothing before.
      return (
        <>
          <ViewToolbarDivider />
          <GroupByControlFace
            value={
              <TableGroupByValueFace
                groupByPropertyId={layout.groupByPropertyId}
              />
            }
          />
          <SegmentedIconToggleFace
            options={TABLE_CONTENT_MODE_OPTIONS.map((option) => ({
              value: option.mode,
              icon: option.icon,
            }))}
          />
          <ButtonFace
            size={TABLE_EXPORT_BUTTON.size}
            variant={TABLE_EXPORT_BUTTON.variant}
          >
            <DownloadIcon className={TABLE_EXPORT_ICON_CLASS} />
          </ButtonFace>
        </>
      );
    case "overview":
    case "avt":
    case "correspondence":
      return null;
  }
};

/**
 * The matter view's toolbar before the page has loaded, for the view the
 * cache holds: every control the loaded toolbar always shows for that view,
 * in its order and box, unavailable. What waits on data (a property's name,
 * a filter's summary) is a bar; what only data can decide (the selection's
 * actions, the controls behind the member's access) is left out, after the
 * rest.
 */
export const ViewToolbarFace = ({ view }: { view: WorkspaceView }) => (
  <>
    {view.layout.type === "table" && (
      // The find bar's trigger (table-find-bar.tsx), inside its chip's box.
      <span aria-hidden="true" className="flex items-center">
        <IconTriggerFace>
          <SearchIcon className="size-3.5" />
        </IconTriggerFace>
      </span>
    )}
    <FilterChipsFace filters={view.layout.filters} />
    <SortChipsFace sorts={view.layout.sorts} />
    {/* The columns menu's trigger (column-toggle.tsx). */}
    <IconTriggerFace>
      <EyeIcon className="size-3.5" />
    </IconTriggerFace>
    <LayoutControlsFace layout={view.layout} />
  </>
);
