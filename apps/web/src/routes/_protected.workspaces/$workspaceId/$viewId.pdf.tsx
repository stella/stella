import { Activity, useEffect, useLayoutEffect, useRef } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
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

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId/pdf",
)({
  component: RouteComponent,
  // v.object: validateSearch receives the full URL search params
  // including params from parent routes; strictObject would reject them.
  validateSearch: v.object({
    entity: v.string(),
    field: v.string(),
    justification: v.optional(v.string()),
    justificationPage: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1)),
    ),
    pdfPage: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  }),
  search: {
    middlewares: [stripSearchParams({ pdfPage: 1 })],
  },
});

const AnonymizeScrollSync = () => {
  const pageNumber = Route.useSearch({ select: (s) => s.pdfPage ?? 1 });
  const setScrollTo = usePDFStore((s) => s.setScrollTo);
  const pages = usePDFStore((s) => s.pages);
  const pendingAnonymizeEntityId = useWorkspaceStore(
    (s) => s.pdfViewer.pendingAnonymizeEntityId,
  );
  const setPendingAnonymizeEntityId = useWorkspaceStore(
    (s) => s.setPendingAnonymizeEntityId,
  );

  useEffect(() => {
    if (pendingAnonymizeEntityId === null || pages.size === 0) {
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
        entityId: pendingAnonymizeEntityId,
      },
    });
    setPendingAnonymizeEntityId(null);
  }, [
    pageNumber,
    pages,
    pendingAnonymizeEntityId,
    setPendingAnonymizeEntityId,
    setScrollTo,
  ]);

  return null;
};

function RouteComponent() {
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fieldId = Route.useSearch({ select: (s) => s.field });
  const entityId = Route.useSearch({ select: (s) => s.entity });
  useSyncJustifications([entityId]);
  const sidebar = useWorkspaceStore((s) => s.pdfViewer.sidebar);
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const justificationId = Route.useSearch({
    select: (s) => s.justification,
  });
  const justificationPage = Route.useSearch({
    select: (s) => s.justificationPage,
  });
  const pageNumber = Route.useSearch({ select: (s) => s.pdfPage ?? 1 });
  const { data: entity } = useSuspenseQuery(
    entityOptions(workspaceId, entityId),
  );
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );
  const resetPdfViewerState = useWorkspaceStore((s) => s.resetPdfViewerState);

  useLayoutEffect(() => {
    if (!justificationId || justificationPage === undefined) {
      setActiveJustification(null);
      return;
    }

    setActiveJustification({
      id: justificationId,
      pageNumber: justificationPage,
    });
  }, [justificationId, justificationPage, setActiveJustification]);

  useEffect(
    () => () => {
      setActiveJustification(null);
      resetPdfViewerState();
    },
    [resetPdfViewerState, setActiveJustification],
  );

  const sidebarOpen = sidebar !== "none";

  return (
    <div
      className="bg-secondary relative flex h-full max-h-[calc(100vh-3rem)] flex-1 overflow-x-hidden overflow-y-auto border-t"
      ref={scrollContainerRef}
    >
      <PDFProvider
        fieldId={fieldId}
        initialScaleOffset={scaleOffset}
        startPage={pageNumber}
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
                {sidebar === "entity" && (
                  <>
                    <EntityFileInfo
                      entityId={entity.entityId}
                      fields={entity.fields}
                      scrollContainerRef={scrollContainerRef}
                    />
                    <FieldInfoList entity={entity} workspaceId={workspaceId} />
                  </>
                )}
                {sidebar === "anonymize" && (
                  <AnonymizeSidebar fieldId={fieldId} />
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
  const activePropertyId = useWorkspaceStore(
    (s) => s.pdfViewer.activePropertyId,
  );
  const setPdfActivePropertyId = useWorkspaceStore(
    (s) => s.setPdfActivePropertyId,
  );

  const visibleFields = entity.fields.filter(
    (field) => !skipFieldFilter(field.content),
  );

  useEffect(() => {
    const nextPropertyId = visibleFields.at(0)?.propertyId ?? null;

    if (!nextPropertyId) {
      if (activePropertyId !== null) {
        setPdfActivePropertyId(null);
      }
      return;
    }

    if (
      activePropertyId === null ||
      !visibleFields.some((field) => field.propertyId === activePropertyId)
    ) {
      setPdfActivePropertyId(nextPropertyId);
    }
  }, [activePropertyId, setPdfActivePropertyId, visibleFields]);

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
        setPdfActivePropertyId(nextId ?? activePropertyId);
      }}
      value={activePropertyId ? [activePropertyId] : []}
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
