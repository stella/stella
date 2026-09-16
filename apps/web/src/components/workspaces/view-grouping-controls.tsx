import {
  Columns3Icon,
  Rows3Icon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import {
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/components/workspaces/entity-utils";
import { isGroupableProperty } from "@/components/workspaces/kanban/kanban-view.logic";
import { resolveDocumentTypeClassifier } from "@/components/workspaces/table/group-columns";
import type { WorkspaceProperty } from "@/lib/types";
import { isPlaybookVerdictProperty } from "@/lib/workspaces/playbook-verdicts";

const GROUP_BY_NONE_VALUE = "_none";

export type AdditionalViewGroup = { id: string; label: string };

type GroupByControlProps = {
  additionalGroups?: readonly AdditionalViewGroup[] | undefined;
  properties: WorkspaceProperty[];
  groupByPropertyId: string | undefined;
  onChange: (propertyId: string) => void;
  // When true, an explicit "None" option is offered and an unset
  // grouping resolves to None instead of falling back to a property.
  // Table views default to flat (no grouping); kanban always groups.
  allowNone?: boolean;
  // Multi-select grouping is valid for the table (a row can appear in several
  // sections) but not the kanban board (a card belongs to one column).
  allowMultiSelectGrouping?: boolean;
  allowPersonGrouping?: boolean;
  allowCreatedByGrouping?: boolean;
  // Sub-group only: server paging and counts do not support a top-level
  // Group by Assignee, so only the sub-group picker sets this.
  allowAssigneeGrouping?: boolean;
  ariaLabel?: string | undefined;
  excludedPropertyId?: string | undefined;
  label?: string | undefined;
  showLabel?: boolean | undefined;
};

export const GroupByControl = ({
  additionalGroups = [],
  properties,
  groupByPropertyId,
  onChange,
  allowNone = false,
  allowMultiSelectGrouping = false,
  allowPersonGrouping = false,
  allowCreatedByGrouping = false,
  allowAssigneeGrouping = false,
  ariaLabel,
  excludedPropertyId,
  label,
  showLabel = true,
}: GroupByControlProps) => {
  const t = useTranslations();
  // The table groups by single- or multi-select (the counts query unnests
  // multi-select arrays); the kanban board stays single-select only.
  const eligible = properties.filter(
    (property) =>
      property.id !== excludedPropertyId &&
      (allowMultiSelectGrouping
        ? isGroupableProperty(property)
        : property.content.type === "single-select" ||
          (allowPersonGrouping && property.content.type === "person")),
  );

  // Grouping by "Document Type" is the primary action — it drives per-type
  // playbook review — so it leads the menu, marked, above the basic groupings.
  // The playbook verdict groupings are collected into their own section below so
  // they don't drown the important choices.
  const documentTypeProp = resolveDocumentTypeClassifier(eligible);
  const verdictProps = eligible.filter((property) =>
    isPlaybookVerdictProperty(property),
  );
  const basicProps = eligible.filter(
    (property) =>
      property !== documentTypeProp && !isPlaybookVerdictProperty(property),
  );

  const resolvedId =
    allowNone && !groupByPropertyId
      ? GROUP_BY_NONE_VALUE
      : resolveKanbanGroupBy(groupByPropertyId ?? "", properties);

  const resolvedLabel = (() => {
    if (resolvedId === GROUP_BY_NONE_VALUE) {
      return t("common.none");
    }
    if (resolvedId === getInternalPropertyId("kind")) {
      return t("common.kind");
    }
    if (resolvedId === getInternalPropertyId("status")) {
      return t("tasks.status");
    }
    if (resolvedId === getInternalPropertyId("created-by")) {
      return t("common.author");
    }
    if (resolvedId === getInternalPropertyId("assignee")) {
      return t("common.assignee");
    }
    return (
      additionalGroups.find((group) => group.id === resolvedId)?.label ??
      eligible.find((p) => p.id === resolvedId)?.name ??
      t("workspaces.views.selectProperty")
    );
  })();

  return (
    <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap">
      {showLabel && (
        <span className="text-muted-foreground hidden shrink-0 sm:inline">
          {label ?? t("workspaces.views.groupBy")}
        </span>
      )}
      <Select
        onValueChange={(v) => {
          if (v === null) {
            return;
          }
          onChange(v === GROUP_BY_NONE_VALUE ? "" : v);
        }}
        value={resolvedId}
      >
        <SelectTrigger
          aria-label={ariaLabel ?? label ?? t("workspaces.views.groupBy")}
          className="h-7 min-h-0 w-28 text-xs sm:h-6 sm:w-auto sm:min-w-24"
          size="sm"
        >
          <SelectValue placeholder={resolvedLabel}>{resolvedLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {documentTypeProp && (
            <>
              <SelectItem value={documentTypeProp.id}>
                <span className="flex items-center gap-1.5 font-medium">
                  <SparklesIcon className="text-primary size-3.5" />
                  {documentTypeProp.name}
                </span>
              </SelectItem>
              <SelectSeparator />
            </>
          )}
          {allowNone && (
            <SelectItem value={GROUP_BY_NONE_VALUE}>
              {t("common.none")}
            </SelectItem>
          )}
          {excludedPropertyId !== getInternalPropertyId("status") && (
            <SelectItem value={getInternalPropertyId("status")}>
              {t("tasks.status")}
            </SelectItem>
          )}
          {excludedPropertyId !== getInternalPropertyId("kind") && (
            <SelectItem value={getInternalPropertyId("kind")}>
              {t("common.kind")}
            </SelectItem>
          )}
          {allowCreatedByGrouping &&
            excludedPropertyId !== getInternalPropertyId("created-by") && (
              <SelectItem value={getInternalPropertyId("created-by")}>
                {t("common.author")}
              </SelectItem>
            )}
          {allowAssigneeGrouping &&
            excludedPropertyId !== getInternalPropertyId("assignee") && (
              <SelectItem value={getInternalPropertyId("assignee")}>
                {t("common.assignee")}
              </SelectItem>
            )}
          {additionalGroups
            .filter((group) => group.id !== excludedPropertyId)
            .map((group) => (
              <SelectItem key={group.id} value={group.id}>
                {group.label}
              </SelectItem>
            ))}
          {basicProps.map((prop) => (
            <SelectItem key={prop.id} value={prop.id}>
              {prop.name}
            </SelectItem>
          ))}
          {verdictProps.length > 0 && (
            <>
              <SelectSeparator />
              {verdictProps.map((prop) => (
                <SelectItem key={prop.id} value={prop.id}>
                  {prop.name}
                </SelectItem>
              ))}
            </>
          )}
        </SelectPopup>
      </Select>
    </span>
  );
};

type KanbanGroupingSettingsProps = {
  additionalSubgroups?: readonly AdditionalViewGroup[] | undefined;
  groupByPropertyId: string | undefined;
  subgroupByPropertyId: string | undefined;
  onChange: (
    groupByPropertyId: string,
    subgroupByPropertyId: string | undefined,
  ) => void;
  properties: WorkspaceProperty[];
  // Server paging and counts for the assignee sub-group only support a board
  // scoped to tasks alone (see kanban-view.logic.ts's `assigneeGroup`); a
  // view that also admits documents/folders, or that does not provably
  // restrict its kinds at all, does not offer it.
  allowAssigneeGrouping: boolean;
};

export const KanbanGroupingSettings = ({
  additionalSubgroups,
  groupByPropertyId,
  subgroupByPropertyId,
  onChange,
  properties,
  allowAssigneeGrouping,
}: KanbanGroupingSettingsProps) => {
  const t = useTranslations();
  const resolvedGroupBy = resolveKanbanGroupBy(
    groupByPropertyId ?? "",
    properties,
  );

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("workspaces.views.viewSettings")}
            size="xs"
            type="button"
            variant="outline"
          />
        }
      >
        <Settings2Icon className="size-3.5" />
        <span className="hidden sm:inline">{t("common.settings")}</span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80 p-2" side="bottom">
        <div className="px-2 py-1.5 text-sm font-medium">
          {t("workspaces.views.viewSettings")}
        </div>
        <div className="space-y-1">
          <div className="hover:bg-muted/60 flex min-h-11 items-center gap-3 rounded-lg px-2">
            <Columns3Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1 text-sm">
              {t("workspaces.views.group")}
            </span>
            <GroupByControl
              ariaLabel={t("workspaces.views.group")}
              groupByPropertyId={resolvedGroupBy}
              onChange={(nextGroupBy) =>
                onChange(
                  nextGroupBy,
                  nextGroupBy === subgroupByPropertyId
                    ? undefined
                    : subgroupByPropertyId,
                )
              }
              properties={properties}
              showLabel={false}
            />
          </div>
          <div className="hover:bg-muted/60 flex min-h-11 items-center gap-3 rounded-lg px-2">
            <Rows3Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1 text-sm">
              {t("workspaces.views.subgroup")}
            </span>
            <GroupByControl
              additionalGroups={additionalSubgroups}
              allowNone
              allowCreatedByGrouping
              allowAssigneeGrouping={allowAssigneeGrouping}
              allowPersonGrouping
              ariaLabel={t("workspaces.views.subgroup")}
              excludedPropertyId={resolvedGroupBy}
              groupByPropertyId={subgroupByPropertyId}
              onChange={(nextSubgroupBy) =>
                onChange(resolvedGroupBy, nextSubgroupBy || undefined)
              }
              properties={properties}
              showLabel={false}
            />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
};
