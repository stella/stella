import { Activity, useEffect, useRef } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  retainSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { produce } from "immer";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Accordion } from "@stella/ui/components/accordion";
import { ScrollArea } from "@stella/ui/components/scroll-area";

import { usePdfStore } from "@/lib/pdf/pdf-store";
import type { EntityField } from "@/lib/types";
import {
  EntityFileInfo,
  FieldInfo,
  skipFieldFilter,
} from "@/routes/_protected.workspaces/$workspaceId/-components/entity-info";
import PdfViewer from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/pdf-viewer";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const PDF_CONTAINER_ID = "pdf-viewer-container";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId/pdf",
)({
  component: RouteComponent,
  validateSearch: v.object({
    file: v.object({
      fieldId: v.string(),
      pageNumber: v.optional(v.number(), 1),
      scaleOffset: v.optional(v.number(), 0),
    }),
    entity: v.object({
      id: v.string(),
      visible: v.boolean(),
      activePropertyId: v.string(),
    }),
    justification: v.optional(
      v.object({
        id: v.string(),
        pageNumber: v.number(),
      }),
    ),
  }),
  search: {
    middlewares: [retainSearchParams(true)],
  },
  onLeave: () => {
    const container = document.getElementById(PDF_CONTAINER_ID);

    // for whatever reason chrome keeps detached nodes in the DOM
    // after navigation — manually remove to prevent canvas leaks
    if (container) {
      container.innerHTML = "";
    }

    return usePdfStore.getState().cleanupPdfs();
  },
});

function RouteComponent() {
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const entitySearch = Route.useSearch({
    select: (s) => s.entity,
  });
  const { data: entity } = useSuspenseQuery(
    entityOptions(workspaceId, entitySearch.id),
  );

  // Sync justification search param → workspace store
  const justificationSearch = Route.useSearch({
    select: (s) => s.justification,
  });
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );

  useEffect(() => {
    setActiveJustification(justificationSearch ?? null);
    return () => setActiveJustification(null);
  }, [justificationSearch, setActiveJustification]);

  return (
    <div
      className="relative flex h-full max-h-[calc(100vh-3rem)] flex-1 overflow-x-hidden overflow-y-auto border-t bg-secondary"
      ref={scrollContainerRef}
    >
      <Group orientation="horizontal">
        <Panel id={PDF_CONTAINER_ID}>
          <ScrollArea>
            <PdfViewer />
          </ScrollArea>
        </Panel>

        <Activity mode={entitySearch.visible && entity ? "visible" : "hidden"}>
          <Separator className="group flex w-1 shrink-0 cursor-col-resize items-center justify-center data-[separator=active]:bg-border data-[separator=hover]:bg-border">
            <div className="h-8 w-0.5 rounded-full bg-border group-data-[separator=active]:hidden group-data-[separator=hover]:hidden" />
          </Separator>
          <Panel defaultSize="28rem" maxSize="40rem" minSize="16rem">
            {entity && (
              <div className="h-full overflow-y-auto bg-background">
                <EntityFileInfo
                  entityId={entity.entityId}
                  fields={entity.fields}
                  scrollContainerRef={scrollContainerRef}
                />
                <FieldInfoList entity={entity} workspaceId={workspaceId} />
              </div>
            )}
          </Panel>
        </Activity>
      </Group>
    </div>
  );
}

type FieldInfoListProps = {
  workspaceId: string;
  entity: {
    entityId: string;
    fields: EntityField[];
  };
};

const FieldInfoList = ({ workspaceId, entity }: FieldInfoListProps) => {
  const t = useTranslations();
  const activePropertyId = Route.useSearch({
    select: (s) => s.entity.activePropertyId,
  });
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/pdf",
  });

  const visibleFields = entity.fields.filter(
    (field) => !skipFieldFilter(field.content),
  );

  if (visibleFields.length === 0) {
    return (
      <div className="mt-3 px-3 text-center text-sm font-medium text-muted-foreground">
        {t("workspaces.noFieldsToView")}
      </div>
    );
  }

  return (
    <Accordion
      key={entity.entityId}
      onValueChange={async (nextValue) => {
        const nextId = nextValue.at(0);

        await navigate({
          replace: true,
          search: (prev) =>
            produce(prev, (s) => {
              s.entity.activePropertyId =
                typeof nextId === "string" ? nextId : activePropertyId;
            }),
        });
      }}
      value={[activePropertyId]}
    >
      {visibleFields.map((field) => (
        <FieldInfo
          entityId={entity.entityId}
          field={field}
          key={field.id + field.propertyId}
          propertyId={field.propertyId}
          workspaceId={workspaceId}
        />
      ))}
    </Accordion>
  );
};
