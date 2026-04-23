import { useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { produce } from "immer";
import { ChevronLeftIcon, ChevronRightIcon, LaptopIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stella/ui/components/accordion";
import { Button } from "@stella/ui/components/button";
import { toastManager } from "@stella/ui/components/toast";

import { env } from "@/env";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import { DOCX_MIME } from "@/lib/consts";
import {
  DesktopBridgeUnavailableError,
  openDocxInDesktop,
} from "@/lib/desktop-bridge";
import { isUnauthorizedError } from "@/lib/errors";
import type { EntityField, EntityKind } from "@/lib/types";
import { EditableField } from "@/routes/_protected.workspaces/$workspaceId/-components/editable-field";
import { Justification } from "@/routes/_protected.workspaces/$workspaceId/-components/justification";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { useActiveView } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-active-view";
import { useEntitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
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
  const t = useTranslations();
  const [isOpeningInDesktop, setIsOpeningInDesktop] = useState(false);
  const field = fields.find((f) => f.content.type === "file");
  const activeView = useActiveView();
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (params) => params.workspaceId,
  });
  const { data: navData } = useSuspenseQuery({
    ...useEntitiesOptions(activeView),
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
  const setPdfViewerState = useWorkspaceStore((s) => s.setPdfViewerState);

  if (field?.content.type !== "file") {
    return null;
  }

  const isDocx = field.content.mimeType === DOCX_MIME;

  return (
    <div className="bg-popover mb-1.5 grid min-h-10 grid-cols-[1fr_auto] items-center gap-0.5 border-b ps-3 pe-1">
      <span className="truncate font-medium">{field.content.fileName}</span>
      <div className="flex items-center gap-1">
        {isDocx ? (
          <Button
            // eslint-disable-next-line typescript/no-misused-promises
            onClick={async () => {
              setIsOpeningInDesktop(true);
              try {
                const linkedAccount = await getFreshLinkedAccount();

                await openDocxInDesktop({
                  apiBaseUrl: env.VITE_API_URL,
                  entityId,
                  linkedAccount,
                  propertyId: field.propertyId,
                  workspaceId,
                });

                toastManager.add({
                  description: t(
                    "workspaces.files.desktopEdit.openedDescription",
                  ),
                  title: t("workspaces.files.desktopEdit.openedTitle"),
                  type: "success",
                });
              } catch (error) {
                if (error instanceof Error && isUnauthorizedError(error)) {
                  toastManager.add({
                    description: t(
                      "workspaces.files.desktopEdit.authRequiredDescription",
                    ),
                    title: t("workspaces.files.desktopEdit.authRequiredTitle"),
                    type: "error",
                  });
                  return;
                }

                toastManager.add({
                  description: t(
                    "workspaces.files.desktopEdit.unavailableDescription",
                  ),
                  title:
                    error instanceof DesktopBridgeUnavailableError
                      ? t("workspaces.files.desktopEdit.unavailableTitle")
                      : error instanceof Error
                        ? error.message
                        : t("workspaces.files.desktopEdit.unavailableTitle"),
                  type: "error",
                });
              } finally {
                setIsOpeningInDesktop(false);
              }
            }}
            disabled={isOpeningInDesktop}
            size="sm"
            variant="outline"
          >
            <LaptopIcon />
            {isOpeningInDesktop
              ? t("workspaces.files.desktopEdit.opening")
              : t("workspaces.files.desktopEdit.action")}
          </Button>
        ) : null}
        <Button
          disabled={!prevFile}
          // eslint-disable-next-line typescript/no-misused-promises
          onClick={async () => {
            const previousPdfViewer = {
              ...useWorkspaceStore.getState().pdfViewer,
            };
            try {
              setPdfViewerState({ scaleOffset: 0 });
              await navigate({
                resetScroll: true,
                search: (prev) =>
                  produce(prev, (s) => {
                    if (!prevFile) {
                      return;
                    }

                    s.field = prevFile.fieldId;
                    s.pdfPage = undefined;
                    s.entity = prevFile.entityId;
                    s.justification = undefined;
                    s.justificationPage = undefined;
                  }),
              });
            } catch (error) {
              setPdfViewerState(previousPdfViewer);
              throw error;
            }

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
            const previousPdfViewer = {
              ...useWorkspaceStore.getState().pdfViewer,
            };
            try {
              setPdfViewerState({ scaleOffset: 0 });
              await navigate({
                replace: true,
                search: (prev) =>
                  produce(prev, (s) => {
                    if (!nextFile) {
                      return;
                    }

                    s.field = nextFile.fieldId;
                    s.pdfPage = undefined;
                    s.entity = nextFile.entityId;
                    s.justification = undefined;
                    s.justificationPage = undefined;
                  }),
              });
            } catch (error) {
              setPdfViewerState(previousPdfViewer);
              throw error;
            }

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
  entityKind: EntityKind;
  workspaceId: string;
  propertyId: string;
  field: EntityField;
  entityId: string;
};

export const FieldInfo = ({
  entityKind,
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
    skipFieldFilter(content)
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
          <EditableField
            content={field?.content}
            entityId={entityId}
            entityKind={entityKind}
            property={property}
            propertyId={propertyId}
            readonly={property.tool.type === "ai-model"}
            workspaceId={workspaceId}
          />
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
