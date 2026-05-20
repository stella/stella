import {
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import { EyeOffIcon, PencilLineIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { Separator } from "@stll/ui/components/separator";
import { stellaToast } from "@stll/ui/components/toast";

import type { PropertyDependency, WorkspaceProperty } from "@/lib/types";
import { CreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/create-property";
import { DeleteProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/delete-property";
import { PinProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/pin-property";
import { PropertyConditions } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-conditions";
import { PropertyPopoverTrigger } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import {
  SortProperty,
  toSortHint,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/sort-property";
import type { TableHeader } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import { useUpdateProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";

type PropertyPopoverProps = {
  property: WorkspaceProperty;
  header: TableHeader;
};

type ReplaceAction = {
  index: number;
  next: PropertyDependency;
};

export const PropertyPopover = ({ property, header }: PropertyPopoverProps) => {
  const t = useTranslations();
  const { workspaceId, id, name } = property;
  const [isOpen, setIsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const updateProperty = useUpdateProperty();
  const startWorkflow = useStartWorkflow(workspaceId);

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
  const dependencyGenerationRef = useRef(0);
  const [, startDepsTransition] = useTransition();

  useEffect(() => {
    latestDependenciesRef.current = displayedDependencies;
  }, [displayedDependencies]);

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
                    className="justify-start gap-1.5"
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
                className="justify-start gap-1.5"
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
