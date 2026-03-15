import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stella/ui/components/accordion";
import { Button } from "@stella/ui/components/button";

import type { EntityField } from "@/lib/types";
import { CellResult } from "@/routes/_protected.workspaces/$workspaceId/-components/cell-result";
import { Justification } from "@/routes/_protected.workspaces/$workspaceId/-components/justification";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { useActiveView } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-active-view";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type EntityFileInfoProps = {
  entityId: string;
  fields: EntityField[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
};

export const EntityFileInfo = ({
  entityId,
  fields,
  scrollContainerRef,
}: EntityFileInfoProps) => {
  const field = fields.find((f) => f.content.type === "file");
  const activeView = useActiveView();
  const { data: navData } = useSuspenseQuery({
    ...entitiesOptions(activeView),
    select: (data) => {
      const currentIndex = data.entities.findIndex(
        (e) => e.entityId === entityId,
      );
      if (currentIndex === -1) {
        return { prevEntity: undefined, nextEntity: undefined };
      }
      const prevEntity = data.entities[currentIndex - 1];
      const nextEntity = data.entities[currentIndex + 1];
      return { prevEntity, nextEntity };
    },
  });
  const prevFile = navData.prevEntity ? getFirstFile(navData.prevEntity) : null;
  const nextFile = navData.nextEntity ? getFirstFile(navData.nextEntity) : null;

  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/pdf",
  });

  if (field?.content.type !== "file") {
    return null;
  }

  return (
    <div className="bg-popover mb-1.5 grid min-h-10 grid-cols-[1fr_auto] items-center gap-0.5 border-b ps-3 pe-1">
      <span className="truncate font-medium">{field.content.fileName}</span>
      <div>
        <Button
          disabled={!prevFile}
          // eslint-disable-next-line typescript/no-misused-promises
          onClick={async () => {
            await navigate({
              resetScroll: true,
              search: (prev) =>
                produce(prev, (s) => {
                  if (!prevFile) {
                    return;
                  }

                  s.file = {
                    fieldId: prevFile.fieldId,
                    pageNumber: 1,
                    scaleOffset: 0,
                  };
                  s.justification = undefined;
                  s.entity.id = prevFile.entityId;
                  // keep the active property id
                }),
            });

            scrollContainerRef.current?.scrollTo({ top: 0 });
          }}
          size="icon"
          variant="ghost"
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          disabled={!nextFile}
          // eslint-disable-next-line typescript/no-misused-promises
          onClick={async () => {
            await navigate({
              replace: true,
              search: (prev) =>
                produce(prev, (s) => {
                  if (!nextFile) {
                    return;
                  }

                  s.file = {
                    fieldId: nextFile.fieldId,
                    pageNumber: 1,
                    scaleOffset: 0,
                  };
                  s.justification = undefined;
                  s.entity.id = nextFile.entityId;
                  // keep the active property id
                }),
            });

            scrollContainerRef.current?.scrollTo({ top: 0 });
          }}
          size="icon"
          variant="ghost"
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
};

export const skipFieldFilter = (content: EntityField["content"]) =>
  content.type === "error" ||
  content.type === "pending" ||
  content.type === "file";

type FieldInfoProps = {
  workspaceId: string;
  propertyId: string;
  field: EntityField;
  entityId: string;
};

export const FieldInfo = ({
  workspaceId,
  propertyId,
  field,
  entityId,
}: FieldInfoProps) => {
  const t = useTranslations();
  const { data: property } = useSuspenseQuery({
    ...propertiesOptions(workspaceId),
    select: (data) => data.find((p) => p.id === propertyId),
  });
  const content = field?.content;
  const justification = useWorkspaceStore((s) =>
    s.justifications.find((j) => j.fieldId === field.id),
  );

  if (
    property === undefined ||
    property === null ||
    content === undefined ||
    content === null ||
    property.content.type === "file" ||
    skipFieldFilter(content) ||
    property.tool.type !== "ai-model"
  ) {
    return null;
  }

  return (
    <AccordionItem value={propertyId}>
      <AccordionTrigger className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <PropertyIcon className="size-4" type={property.content.type} />
          <span className="truncate font-medium">{property.name}</span>
        </div>
      </AccordionTrigger>
      <AccordionPanel className="px-3 pb-2">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5 text-sm">
            <h1 className="text-muted-foreground text-sm font-medium">
              {t("workspaces.answer")}
            </h1>
            <CellResult field={{ ...field, entityId }} property={property} />
          </div>
          {justification && (
            <div className="flex flex-col gap-0.5 text-sm">
              <h1 className="text-muted-foreground text-sm font-medium">
                {t("workspaces.justification")}
              </h1>
              <Justification justification={justification} />
            </div>
          )}
        </div>
      </AccordionPanel>
    </AccordionItem>
  );
};
