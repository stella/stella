import { Suspense } from "react";

import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";

import { AnonymizationFacet } from "@/components/inspector/anonymization-facet";
import { EmailAttachmentsFacet } from "@/components/inspector/email-attachments-facet";
import {
  EMAIL_CHAT_HOST,
  type EmailChatMode,
} from "@/components/inspector/email-html-viewer.logic";
import { EntityMetadataPanel } from "@/components/inspector/entity-metadata-panel";
import { MetadataPanelSkeleton } from "@/components/inspector/file-facets";
import type { Facet } from "@/components/inspector/file-facets";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { PlaybookFacet } from "@/components/inspector/playbook-facet";
import type { EmailAttachmentSelection } from "@/components/inspector/use-email-attachment-selection";
import { VersionsFacet } from "@/components/inspector/versions-facet";
import { detached } from "@/lib/detached";

/**
 * Which rendering of the file tab hosts the facet. Full view has the document
 * open in the main pane; sidepeek has no interactive editor underneath.
 */
type FileTabFacetPersona =
  | { type: "fullView"; isActive: boolean }
  | { type: "sidepeek"; onOpenFullView: () => void };

type FileTabFacetContentProps = {
  /** `null` when the tab is not an email, which has no attachments facet. */
  emailAttachments: EmailAttachmentSelection | null;
  emailChatMode: EmailChatMode;
  facet: Facet;
  filePropertyId: string | undefined;
  pdfRouteJustification: string | null;
  peekPdfViewId: string;
  persona: FileTabFacetPersona;
  tab: FileTab;
};

/** Every facet but the preview, shared by the full-view and sidepeek tabs. */
export const FileTabFacetContent = ({
  emailAttachments,
  emailChatMode,
  facet,
  filePropertyId,
  pdfRouteJustification,
  peekPdfViewId,
  persona,
  tab,
}: FileTabFacetContentProps) => {
  const navigate = useNavigate();
  const openFile = useInspectorTabsStore((s) => s.openFile);

  switch (facet) {
    case "preview": {
      return null;
    }
    case "metadata": {
      return (
        <Suspense fallback={<MetadataPanelSkeleton />}>
          <EntityMetadataPanel
            activeJustificationFieldId={pdfRouteJustification}
            currentFilePropertyId={filePropertyId ?? null}
            entityId={tab.entityId}
            fileFieldId={tab.id}
            onAiFieldClick={({ fieldId, propertyId }) => {
              // Keep the inspector tab in sync so
              // peek-back lands on the same selection.
              openFile({
                ...tab,
                justificationFieldId: fieldId,
                propertyId,
              });
              detached(
                navigate({
                  to: "/workspaces/$workspaceId/$viewId/document",
                  params: {
                    workspaceId: tab.workspaceId,
                    viewId: peekPdfViewId,
                  },
                  replace: true,
                  search: (prev) => ({
                    ...prev,
                    entity: tab.entityId,
                    field: tab.id,
                    justification: fieldId,
                    justificationPage: 1,
                  }),
                }),
                "file-tab-panel.navigate",
              );
            }}
            workspaceId={tab.workspaceId}
          />
        </Suspense>
      );
    }
    case "attachments": {
      if (emailAttachments === null) {
        return null;
      }
      return (
        <EmailAttachmentsFacet
          chatMode={emailChatMode}
          entityId={tab.entityId}
          fieldId={tab.id}
          fileName={tab.fileName}
          onResetZoom={emailAttachments.resetEmailAttachmentZoom}
          onSelectedIdChange={emailAttachments.setSelectedEmailAttachmentId}
          onZoom={emailAttachments.zoomEmailAttachment}
          overlayActivation={emailAttachments.emailAttachmentOverlayActivation}
          scaleOffset={emailAttachments.emailAttachmentScaleOffset}
          selectedId={emailAttachments.selectedEmailAttachmentId}
          // Sidepeek wraps the whole tab in the email chat host; full view
          // hosts the attachment chat in the facet itself.
          chatHost={
            persona.type === "sidepeek"
              ? EMAIL_CHAT_HOST.parent
              : EMAIL_CHAT_HOST.self
          }
          workspaceId={tab.workspaceId}
        />
      );
    }
    case "versions": {
      return (
        <VersionsFacet
          currentFieldId={tab.id}
          currentFilePropertyId={filePropertyId}
          entityId={tab.entityId}
          workspaceId={tab.workspaceId}
        />
      );
    }
    case "playbook": {
      return (
        <PlaybookFacet
          entityId={tab.entityId}
          fileFieldId={tab.id}
          workspaceId={tab.workspaceId}
        />
      );
    }
    case "anonymization": {
      return <FileTabAnonymizationFacet persona={persona} tab={tab} />;
    }
    default: {
      facet satisfies never;
      return panic(`Unhandled file facet: ${String(facet)}`);
    }
  }
};

const FileTabAnonymizationFacet = ({
  persona,
  tab,
}: {
  persona: FileTabFacetPersona;
  tab: FileTab;
}) => {
  switch (persona.type) {
    case "fullView": {
      return (
        <AnonymizationFacet
          activeFieldId={tab.id}
          entityId={tab.entityId}
          isVisible={persona.isActive}
          workspaceId={tab.workspaceId}
        />
      );
    }
    case "sidepeek": {
      // Sidepeek shows the file as a thumbnail-sized preview
      // without an interactive Folio editor underneath, so
      // there's no per-document match data to display. Pass
      // `activeFieldId={null}` so the facet renders the
      // "open full view first" hint instead of a zero count
      // that the user can't act on from here.
      return (
        <AnonymizationFacet
          activeFieldId={null}
          entityId={tab.entityId}
          onOpenFullView={persona.onOpenFullView}
          workspaceId={tab.workspaceId}
        />
      );
    }
    default: {
      persona satisfies never;
      return panic("Unhandled file facet persona");
    }
  }
};
