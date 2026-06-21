import { useOptimistic, useRef, useState, useTransition } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  EyeOffIcon,
  PencilLineIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { Separator } from "@stll/ui/components/separator";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { type SafeId, toSafeId } from "@/lib/safe-id";
import type {
  ConditionNode,
  PropertyDependency,
  WorkspaceProperty,
} from "@/lib/types";
import { CreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/create-property";
import { DeleteProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/delete-property";
import { PinProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/pin-property";
import { PropertyConditions } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-conditions";
import { PropertyPopoverTrigger } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import {
  SortProperty,
  toSortHint,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/sort-property";
import { useGroupScope } from "@/routes/_protected.workspaces/$workspaceId/-components/table/group-scope";
import type { TableHeader } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import { useUpdateProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

type PropertyPopoverProps = {
  property: WorkspaceProperty;
  header: TableHeader;
  filters: ConditionNode[];
};

type ReplaceAction = {
  index: number;
  next: PropertyDependency;
};

const VERIFIED_FLAG = "verified";

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

  // `scoped` narrows the batch to the current grouped-view subtable (only
  // meaningful when a group scope is present); `set: false` removes the flag,
  // which powers the toast's Undo.
  const markReviewed = useMutation({
    mutationFn: async ({ scoped, set }: { scoped: boolean; set: boolean }) => {
      // The annotation keeps the narrowed grouping id from widening back to
      // `string` (an un-annotated object literal would); mirrors the
      // kanban-group / group-counts query builders.
      const groupParams:
        | {
            groupByPropertyId: "_status" | "_kind" | SafeId<"property">;
            groupValue: string | null;
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
            }
          : {};
      const response = await api
        .fields({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["metadata-batch"].patch({
          queryKey: entitiesKeys.all(workspaceId),
          propertyId: toSafeId<"property">(id),
          flag: VERIFIED_FLAG,
          filters,
          set,
          ...groupParams,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: (data, { scoped, set }) => {
      void queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
      setIsOpen(false);
      if (set && data.updatedCount > 0) {
        stellaToast.add({
          title: t("workspaces.properties.markedAsReviewed", {
            count: data.updatedCount,
          }),
          type: "success",
          action: {
            label: t("common.undo"),
            onClick: () => {
              markReviewed.mutate({ scoped, set: false });
            },
          },
        });
      }
    },
    onError: (error) => {
      stellaToast.add({
        title: t("errors.actionFailed"),
        description:
          error instanceof Error ? error.message : t("common.unexpectedError"),
        type: "error",
      });
    },
  });

  // The composer's CreatableContentType union excludes "file" by
  // design — file columns are created by upload, not by user choice,
  // and the composer has no UI for them. Hiding the entry here keeps
  // a save from silently rewriting the file column as text/manual.
  const canEditViaComposer = property.content.type !== "file";

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
  const latestDependenciesRef = useRef(displayedDependencies);
  // Mirror the latest render value into the ref during render. Read
  // only from event handlers (replaceDependency), so this is the
  // sanctioned latest-value pattern.
  latestDependenciesRef.current = displayedDependencies;
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
        void startWorkflow();
      } catch {
        stellaToast.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
      } finally {
        if (dependencyGenerationRef.current === generation) {
          setImmediateDeps(null);
        }
      }
    });
  };

  return (
    <>
      <Popover modal onOpenChange={setIsOpen} open={isOpen}>
        <PropertyPopoverTrigger
          disabled={updateProperty.isPending}
          name={name}
          property={property}
        />
        <PopoverPopup
          align="start"
          className="min-w-64 overflow-clip *:data-[slot=popover-viewport]:p-0!"
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
              {property.tool.type === "ai-model" && (
                <Button
                  className="justify-start gap-1.5 font-normal"
                  onClick={() => {
                    setIsOpen(false);
                    void startWorkflow({ propertyIds: [id] });
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <RefreshCwIcon />
                  {t("workspaces.properties.rerunColumn")}
                </Button>
              )}
              {groupScope && (
                <Button
                  className="justify-start gap-1.5 font-normal"
                  disabled={markReviewed.isPending}
                  onClick={() => {
                    markReviewed.mutate({ scoped: true, set: true });
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
                disabled={markReviewed.isPending}
                onClick={() => {
                  markReviewed.mutate({ scoped: false, set: true });
                }}
                size="sm"
                variant="ghost"
              >
                <CheckCircle2Icon />
                {t("workspaces.properties.markAllAsReviewed")}
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
