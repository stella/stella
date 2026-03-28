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

import { PDFProvider, usePDFStore } from "@/lib/pdf/pdf-context";
import type { EntityField } from "@/lib/types";
import {
  EntityFileInfo,
  FieldInfo,
  skipFieldFilter,
} from "@/routes/_protected.workspaces/$workspaceId/-components/entity-info";
import { AnonymizeSidebar } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymize-sidebar";
import PdfViewer, {
  PDFSuspenseFallback,
} from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/pdf-viewer";
import { useSyncJustifications } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const sidebarSchema = v.variant("type", [
  v.object({ type: v.literal("none") }),
  v.object({ type: v.literal("entity") }),
  v.object({ type: v.literal("anonymize") }),
]);

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
    entityId: v.string(),
    activePropertyId: v.string(),
    sidebar: sidebarSchema,
    justification: v.optional(
      v.object({
        id: v.string(),
        pageNumber: v.number(),
      }),
    ),
    anonymizeScroll: v.optional(
      v.object({
        entityId: v.number(),
      }),
    ),
  }),
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

const AnonymizeScrollSync = () => {
  const anonymizeScroll = Route.useSearch({
    select: (s) => s.anonymizeScroll,
  });
  const pageNumber = Route.useSearch({
    select: (s) => s.file.pageNumber ?? 1,
  });
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/pdf",
  });
  const setScrollTo = usePDFStore((s) => s.setScrollTo);
  const pages = usePDFStore((s) => s.pages);

  useEffect(() => {
    if (!anonymizeScroll || pages.size === 0) {
      return;
    }

    const pageIds = [...pages.keys()];
    const pageId = pageIds[pageNumber - 1];
    if (pageId === undefined) {
      return;
    }

    setScrollTo({
      pageId,
      target: {
        kind: "anonymizeEntity",
        entityId: anonymizeScroll.entityId,
      },
    });

    // eslint-disable-next-line typescript/no-floating-promises
    navigate({
      replace: true,
      search: (prev) =>
        produce(prev, (s) => {
          s.anonymizeScroll = undefined;
        }),
    });
  }, [anonymizeScroll, pages, pageNumber, navigate, setScrollTo]);

  return null;
};

function RouteComponent() {
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileSearch = Route.useSearch({
    select: (s) => s.file,
  });
  const entityId = Route.useSearch({
    select: (s) => s.entityId,
  });
  useSyncJustifications([entityId]);
  const sidebar = Route.useSearch({
    select: (s) => s.sidebar,
  });
  const { data: entity } = useSuspenseQuery(
    entityOptions(workspaceId, entityId),
  );

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

  const sidebarOpen = sidebar.type !== "none";

  return (
    <div
      className="bg-secondary relative flex h-full max-h-[calc(100vh-3rem)] flex-1 overflow-x-hidden overflow-y-auto border-t"
      ref={scrollContainerRef}
    >
      <PDFProvider
        fieldId={fileSearch.fieldId}
        initialScaleOffset={fileSearch.scaleOffset}
        startPage={fileSearch.pageNumber}
        fallback={{ suspense: <PDFSuspenseFallback /> }}
      >
        <AnonymizeScrollSync />
        <Group orientation="horizontal">
          <Panel>
            <PdfViewer />
          </Panel>
          <Activity mode={sidebarOpen ? "visible" : "hidden"}>
            <Separator className="group data-[separator=active]:bg-border data-[separator=hover]:bg-border flex w-1 shrink-0 cursor-col-resize items-center justify-center">
              <div className="bg-border h-8 w-0.5 rounded-full group-data-[separator=active]:hidden group-data-[separator=hover]:hidden" />
            </Separator>
            <Panel defaultSize="28rem" maxSize="40rem" minSize="16rem">
              <div className="bg-background h-full overflow-y-auto">
                {sidebar.type === "entity" && (
                  <>
                    <EntityFileInfo
                      entityId={entity.entityId}
                      fields={entity.fields}
                      scrollContainerRef={scrollContainerRef}
                    />
                    <FieldInfoList entity={entity} workspaceId={workspaceId} />
                  </>
                )}
                {sidebar.type === "anonymize" && (
                  <AnonymizeSidebar fieldId={fileSearch.fieldId} />
                )}
              </div>
            </Panel>
          </Activity>
        </Group>
      </PDFProvider>
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
    select: (s) => s.activePropertyId,
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
              s.activePropertyId = nextId ?? activePropertyId;
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
