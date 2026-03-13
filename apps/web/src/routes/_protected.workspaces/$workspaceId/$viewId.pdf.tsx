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
  // eslint-disable-next-line typescript/no-misused-promises
  onLeave: async () => {
    const container = document.querySelector(`#${PDF_CONTAINER_ID}`);

    // for whatever reason chrome keeps detached nodes in the DOM
    // after navigation — manually remove to prevent canvas leaks
    if (container) {
      container.innerHTML = "";
    }

    return await usePdfStore.getState().cleanupPdfs();
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
      className="bg-secondary relative flex h-full max-h-[calc(100vh-3rem)] flex-1 overflow-x-hidden overflow-y-auto border-t"
      ref={scrollContainerRef}
    >
      <Group orientation="horizontal">
        <Panel id={PDF_CONTAINER_ID}>
          <ScrollArea>
            <PdfViewer />
          </ScrollArea>
        </Panel>

        <Activity mode={entitySearch.visible ? "visible" : "hidden"}>
          <Separator className="group data-[separator=active]:bg-border data-[separator=hover]:bg-border flex w-1 shrink-0 cursor-col-resize items-center justify-center">
            <div className="bg-border h-8 w-0.5 rounded-full group-data-[separator=active]:hidden group-data-[separator=hover]:hidden" />
          </Separator>
          <Panel defaultSize="28rem" maxSize="40rem" minSize="16rem">
            <div className="bg-background h-full overflow-y-auto">
              <EntityFileInfo
                entityId={entity.entityId}
                fields={entity.fields}
                scrollContainerRef={scrollContainerRef}
              />
              <FieldInfoList entity={entity} workspaceId={workspaceId} />
            </div>
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
      <div className="text-muted-foreground mt-3 px-3 text-center text-sm font-medium">
        {t("workspaces.noFieldsToView")}
      </div>
    );
  }

  return (
    <Accordion
      key={entity.entityId}
      onValueChange={(nextValue) => {
        const nextId = nextValue.at(0);

        // oxlint-disable-next-line typescript/no-floating-promises
        navigate({
          replace: true,
          search: (prev) =>
            produce(prev, (s) => {
              s.entity.activePropertyId = nextId ?? activePropertyId;
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
