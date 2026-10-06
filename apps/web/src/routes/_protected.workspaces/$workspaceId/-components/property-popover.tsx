import { useOptimistic, useRef, useState, useTransition } from "react";

import { useSelector } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  CheckCircle2Icon,
  EyeOffIcon,
  LockIcon,
  PencilLineIcon,
  PlayIcon,
  RefreshCwIcon,
} from "@stll/ui/icons";
import { Popover, PopoverPopup } from "@stll/ui/popover";
import { Separator } from "@stll/ui/separator";
import { stellaToast } from "@stll/ui/toast";
import { useLatest } from "@stll/ui/use-latest";

import { propertyAiCellState } from "@/components/workspaces/ai-cell-state.logic";
import { AiColumnRunButton } from "@/components/workspaces/ai-column-run-controls";
import {
  aiColumnRunMenu,
  aiColumnRunScope,
} from "@/components/workspaces/ai-column-run.logic";
import { CreateProperty } from "@/components/workspaces/create-property";
import { useStartWorkflow } from "@/components/workspaces/hooks/use-start-workflow";
import { DeleteProperty } from "@/components/workspaces/properties/delete-property";
import { PinProperty } from "@/components/workspaces/properties/pin-property";
import { PropertyConditions } from "@/components/workspaces/properties/property-conditions";
import { PropertyPopoverTrigger } from "@/components/workspaces/properties/shared";
import { SortProperty } from "@/components/workspaces/properties/sort-property";
import { toSortHint } from "@/components/workspaces/property-utils";
import type { TableHeader } from "@/components/workspaces/table/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { type SafeId, toSafeId } from "@/lib/safe-id";
import type {
  ConditionNode,
  PropertyDependency,
  WorkspaceProperty,
} from "@/lib/types";
import { useUpdateProperty } from "@/lib/workspaces/mutations/properties";
import { isPlaybookVerdictProperty } from "@/lib/workspaces/playbook-verdicts";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import { useGroupScope } from "@/routes/_protected.workspaces/$workspaceId/-components/table/group-scope";

import {
  canEditPropertyViaComposer,
  getPropertyRunTargetIds,
} from "./property-popover.logic";

type PropertyPopoverProps = {
  property: WorkspaceProperty;
  header: TableHeader;
  filters: ConditionNode[];
};

type ReplaceAction = {
  index: number;
  next: PropertyDependency;
};

const COLUMN_METADATA_ACTION = {
  lock: "locked",
  markReviewed: "verified",
} as const;

type ColumnMetadataBatchArgs = {
  action: (typeof COLUMN_METADATA_ACTION)[keyof typeof COLUMN_METADATA_ACTION];
  scoped: boolean;
  set: boolean;
  onlyAddedAt?: string;
};

export const PropertyPopover = ({
  property,
  header,
  filters,
}: PropertyPopoverProps) => {
  const t = useTranslations();
  const { workspaceId, id, name } = property;
  const groupScope = useGroupScope();
  const [isOpen, setIsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const updateProperty = useUpdateProperty();
  const startWorkflow = useStartWorkflow(workspaceId);
  const queryClient = useQueryClient();
  const table = header.getContext().table;
  const rowSelection = useSelector(table.store, (state) => state.rowSelection);
  const tableRows = table.getRowModel().flatRows;
  const pageRowIds = tableRows
    .filter((row) => row.original.kind !== "folder")
    .map((row) => row.original.entityId);
  const availablePageRowIds = getPropertyRunTargetIds({
    action: "available",
    propertyId: id,
    rows: tableRows,
  });
  const availablePageRowIdSet = new Set(availablePageRowIds);
  const pageRows = tableRows.filter((row) =>
    availablePageRowIdSet.has(row.original.entityId),
  );
  const pageStates = pageRows.map((row) =>
    propertyAiCellState(row.original.fields[id]?.content),
  );
  const runMenuItems = aiColumnRunMenu(pageStates);
  const selectedRowIds = Object.keys(rowSelection);
  const runScope = aiColumnRunScope({ pageRowIds, selectedRowIds });
  const availableScopeRowIds = new Set(
    getPropertyRunTargetIds({
      action: "available",
      propertyId: id,
      rowIds: runScope.rowIds,
      rows: tableRows,
    }),
  );
  const hasNotRunScopeRows = tableRows.some(
    (row) =>
      availableScopeRowIds.has(row.original.entityId) &&
      propertyAiCellState(row.original.fields[id]?.content).type === "not_run",
  );
  const scopedStates = tableRows
    .filter((row) => availableScopeRowIds.has(row.original.entityId))
    .map((row) => propertyAiCellState(row.original.fields[id]?.content));
  const headerRunAction = aiColumnRunMenu(scopedStates).at(0);
  const headerRunTargetIds =
    headerRunAction === undefined
      ? []
      : getPropertyRunTargetIds({
          action: headerRunAction.type,
          propertyId: id,
          rowIds: runScope.rowIds,
          rows: tableRows,
        });

  // `scoped` narrows the batch to the current grouped-view subtable (only
  // meaningful when a group scope is present); `set: false` removes the flag,
  // which powers the toast's Undo. `onlyAddedAt` (set on undo) reverts just the
  // cells this operation changed, never metadata a human set earlier.
  const updateColumnMetadata = useMutation({
    mutationFn: async ({
      action,
      scoped,
      set,
      onlyAddedAt,
    }: ColumnMetadataBatchArgs) => {
      // The annotation keeps the narrowed grouping id from widening back to
      // `string` (an un-annotated object literal would); mirrors the
      // kanban-group / group-counts query builders.
      const groupParams:
        | {
            groupByPropertyId: "_status" | "_kind" | SafeId<"property">;
            groupValue: string | null;
            optionValues?: string[];
          }
        | Record<never, never> =
        scoped && groupScope
          ? {
              groupByPropertyId:
                groupScope.groupByPropertyId === "_status" ||
                groupScope.groupByPropertyId === "_kind"
                  ? groupScope.groupByPropertyId
                  : toSafeId<"property">(groupScope.groupByPropertyId),
              groupValue: groupScope.groupValue,
              ...(groupScope.optionValues !== undefined && {
                optionValues: groupScope.optionValues,
              }),
            }
          : {};
      const response = await api
        .fields({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["metadata-batch"].patch({
          propertyId: toSafeId<"property">(id),
          flag: action,
          filters,
          set,
          ...(onlyAddedAt !== undefined && { onlyAddedAt }),
          ...groupParams,
        });

      return unwrapEden(response);
    },
    onSuccess: (data, { action, scoped, set }) => {
      detached(
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        "property-popover.invalidate",
      );
      setIsOpen(false);
      if (!set || data.updatedCount === 0) {
        return;
      }
      const title =
        action === COLUMN_METADATA_ACTION.lock
          ? t("workspaces.properties.markedAsLocked", {
              count: data.updatedCount,
            })
          : t("workspaces.properties.markedAsReviewed", {
              count: data.updatedCount,
            });
      stellaToast.add({
        title,
        type: "success",
        action: {
          label: t("common.undo"),
          onClick: () => {
            updateColumnMetadata.mutate({
              action,
              scoped,
              set: false,
              onlyAddedAt: data.addedAt,
            });
          },
        },
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"), {
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      });
    },
  });

  // The composer supports custom content types; file and computed verdict
  // columns retain their dedicated editing controls.
  const canEditViaComposer = canEditPropertyViaComposer(
    property.content,
    isPlaybookVerdictProperty(property),
  );

  // `useOptimistic` mirrors the server `dependencies` while a save is
  // in flight so rapid successive edits compose against the latest
  // user intent. Once the transition settles, React reverts to the
  // passthrough server value — no manual resync effect needed.
  const serverDependencies =
    property.tool.type === "ai-model" ? property.tool.dependencies : [];
  const [optimisticDeps, applyDependencyReplacement] = useOptimistic(
    serverDependencies,
    (current, action: ReplaceAction) =>
      current.map((dependency, index) =>
        index === action.index ? action.next : dependency,
      ),
  );
  const [immediateDeps, setImmediateDeps] = useState<
    PropertyDependency[] | null
  >(null);
  const displayedDependencies = immediateDeps ?? optimisticDeps;
  const latestDependenciesRef = useLatest(displayedDependencies);
  const dependencyGenerationRef = useRef(0);
  const [, startDepsTransition] = useTransition();

  // Conditions are editable from the popover without opening the full
  // composer: replaceValue swaps a dependency in place and we save by
  // round-tripping the whole property through updateProperty.
  // The mutation payload composes against the latest optimistic
  // dependencies (not the server snapshot) so two edits fired before
  // the query refetches don't drop one another's in-flight changes.
  const replaceDependency = (index: number, next: PropertyDependency) => {
    if (property.tool.type !== "ai-model") {
      return;
    }
    const tool = property.tool;
    const nextDependencies = latestDependenciesRef.current.map(
      (dependency, i) => (i === index ? next : dependency),
    );
    const generation = dependencyGenerationRef.current + 1;
    dependencyGenerationRef.current = generation;
    latestDependenciesRef.current = nextDependencies;
    setImmediateDeps(nextDependencies);
    startDepsTransition(async () => {
      applyDependencyReplacement({ index, next });
      try {
        await updateProperty.mutateAsync({
          workspaceId,
          propertyId: id,
          name,
          content: property.content,
          tool: { ...tool, dependencies: nextDependencies },
        });
        detached(startWorkflow(), "property-popover.start-workflow");
      } catch (error) {
        getAnalytics().captureError(error);
        notifyUserError(error, t("errors.actionFailed"));
      } finally {
        if (dependencyGenerationRef.current === generation) {
          setImmediateDeps(null);
        }
      }
    });
  };

  const runPropertyRows = async (entityIds: readonly string[]) => {
    if (entityIds.length === 0) {
      return;
    }
    setIsOpen(false);
    const result = await startWorkflow({
      entityIds: [...entityIds],
      propertyIds: [id],
    });
    if (!result) {
      return;
    }
    const { status } = result;
    switch (status) {
      case "started":
        stellaToast.add({
          title: t("workspaces.workflow.startedSuccessfully"),
          type: "success",
        });
        return;
      case "already-running":
        stellaToast.add({
          title: t("common.running"),
          type: "info",
        });
        return;
      case "skipped":
        stellaToast.add({
          title: t("workspaces.workflow.noFieldsToProcess"),
          type: "info",
        });
        return;
      case "ai-unavailable":
        // Running a column is an explicit request, so say why nothing
        // happened; the side-effect call sites stay quiet on this one.
        notifyUserError(undefined, t("errors.failedToStartWorkflow"));
        return;
      case "failed":
        // Already reported by `useStartWorkflow`, error included.
        return;
      default: {
        status satisfies never;
        panic(`Unhandled workflow start status: ${String(status)}`);
      }
    }
  };

  return (
    <>
      <Popover modal onOpenChange={setIsOpen} open={isOpen}>
        <div className="flex min-w-0 items-center">
          <span className="min-w-0 flex-1">
            <PropertyPopoverTrigger
              disabled={updateProperty.isPending}
              name={name}
              property={property}
            />
          </span>
          {property.tool.type === "ai-model" && (
            <AiColumnRunButton
              scope={runScope}
              hasNotRun={hasNotRunScopeRows}
              disabled={headerRunTargetIds.length === 0}
              onRun={() => {
                detached(
                  runPropertyRows(headerRunTargetIds),
                  "property-popover.run-column-scope",
                );
              }}
            />
          )}
        </div>
        <PopoverPopup
          align="start"
          className="min-w-64 overflow-clip"
          padding="none"
        >
          <div className="bg-popover flex flex-col">
            {canEditViaComposer && (
              <>
                <div className="flex flex-col p-1">
                  <Button
                    className="justify-start gap-1.5 font-normal"
                    onClick={() => {
                      setIsOpen(false);
                      setEditorOpen(true);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    <PencilLineIcon />
                    {t("workspaces.properties.editColumn")}
                  </Button>
                </div>
                <Separator />
              </>
            )}
            <SortProperty
              column={header.column}
              sortHint={toSortHint(property.content.type)}
            />
            <Separator />
            <div className="flex flex-col p-1">
              <PropertyConditions
                dependencies={displayedDependencies}
                replaceValue={replaceDependency}
                workspaceId={workspaceId}
              />
              <PinProperty column={header.column} />
              <Button
                className="justify-start gap-1.5 font-normal"
                onClick={() => {
                  header.column.toggleVisibility(false);
                  setIsOpen(false);
                }}
                size="sm"
                variant="ghost"
              >
                <EyeOffIcon />
                {t("workspaces.kanban.hideColumn")}
              </Button>
            </div>
            <Separator />
            <div className="flex flex-col p-1">
              {property.tool.type === "ai-model" &&
                runMenuItems.map(({ type: action, label }) => {
                  const targetIds = getPropertyRunTargetIds({
                    action,
                    propertyId: id,
                    rows: tableRows,
                  });
                  return (
                    <Button
                      className="justify-start gap-1.5 font-normal"
                      disabled={targetIds.length === 0}
                      key={action}
                      onClick={() => {
                        detached(
                          runPropertyRows(targetIds),
                          "property-popover.run-property-page",
                        );
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      {action === "remaining" ? (
                        <PlayIcon />
                      ) : (
                        <RefreshCwIcon />
                      )}
                      {t(label)}
                    </Button>
                  );
                })}
              {groupScope && (
                <Button
                  className="justify-start gap-1.5 font-normal"
                  disabled={updateColumnMetadata.isPending}
                  onClick={() => {
                    updateColumnMetadata.mutate({
                      action: COLUMN_METADATA_ACTION.markReviewed,
                      scoped: true,
                      set: true,
                    });
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <CheckCircle2Icon />
                  {t("workspaces.properties.markThisGroupAsReviewed")}
                </Button>
              )}
              <Button
                className="justify-start gap-1.5 font-normal"
                disabled={updateColumnMetadata.isPending}
                onClick={() => {
                  updateColumnMetadata.mutate({
                    action: COLUMN_METADATA_ACTION.markReviewed,
                    scoped: false,
                    set: true,
                  });
                }}
                size="sm"
                variant="ghost"
              >
                <CheckCircle2Icon />
                {t("workspaces.properties.markAllAsReviewed")}
              </Button>
              {groupScope && (
                <Button
                  className="justify-start gap-1.5 font-normal"
                  disabled={updateColumnMetadata.isPending}
                  onClick={() => {
                    updateColumnMetadata.mutate({
                      action: COLUMN_METADATA_ACTION.lock,
                      scoped: true,
                      set: true,
                    });
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <LockIcon />
                  {t("workspaces.properties.markThisGroupAsLocked")}
                </Button>
              )}
              <Button
                className="justify-start gap-1.5 font-normal"
                disabled={updateColumnMetadata.isPending}
                onClick={() => {
                  updateColumnMetadata.mutate({
                    action: COLUMN_METADATA_ACTION.lock,
                    scoped: false,
                    set: true,
                  });
                }}
                size="sm"
                variant="ghost"
              >
                <LockIcon />
                {t("workspaces.properties.markAllAsLocked")}
              </Button>
            </div>
            <Separator />
            <div className="flex flex-col p-1">
              <DeleteProperty property={property} workspaceId={workspaceId} />
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      <CreateProperty
        onOpenChange={setEditorOpen}
        open={editorOpen}
        propertyId={id}
        triggerVariant="none"
        workspaceId={workspaceId}
      />
    </>
  );
};
