import { useEffect, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { Separator } from "@stll/ui/components/separator";
import { toastManager } from "@stll/ui/components/toast";
import { EyeOffIcon, PencilLineIcon } from "lucide-react";
import { useTranslations } from "use-intl";

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

  // Local optimistic copy of the dependencies. The conditions sub-modal
  // can fire several edits in quick succession; rebuilding from
  // `property.tool.dependencies` each time would clobber an in-flight
  // change with the snapshot from the previous render. We keep the
  // local copy authoritative while a mutation is pending and only
  // re-sync from the prop when it settles.
  const initialDeps =
    property.tool.type === "ai-model" ? property.tool.dependencies : [];
  const [localDeps, setLocalDeps] = useState<PropertyDependency[]>(initialDeps);
  const isUpdatePending = updateProperty.isPending;

  useEffect(() => {
    if (isUpdatePending) {
      return;
    }
    if (property.tool.type !== "ai-model") {
      setLocalDeps([]);
      return;
    }
    setLocalDeps(property.tool.dependencies);
  }, [property, isUpdatePending]);

  // Conditions are editable from the popover without opening the full
  // composer: replaceValue swaps a dependency in place and we save by
  // round-tripping the whole property through updateProperty.
  const replaceDependency = (index: number, next: PropertyDependency) => {
    if (property.tool.type !== "ai-model") {
      return;
    }
    const nextDependencies = localDeps.map((d, i) => (i === index ? next : d));
    setLocalDeps(nextDependencies);
    updateProperty.mutate(
      {
        workspaceId,
        propertyId: id,
        name,
        content: property.content,
        tool: { ...property.tool, dependencies: nextDependencies },
      },
      {
        onSuccess: () => {
          void startWorkflow();
        },
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
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
                dependencies={localDeps}
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
