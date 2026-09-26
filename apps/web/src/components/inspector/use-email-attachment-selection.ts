import { useState } from "react";

import { FILE_CHAT_OVERLAY_ACTIVATION } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import { getEmailAttachmentPreviewId } from "@/components/inspector/email-attachments-facet.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";

type GetEmailAttachmentStateOptions = {
  isActive: boolean;
  scaleOffsets: ReadonlyMap<string, number>;
  selectedEmailAttachmentId: string | null;
  tab: FileTab;
};

const getEmailAttachmentState = ({
  isActive,
  scaleOffsets,
  selectedEmailAttachmentId,
  tab,
}: GetEmailAttachmentStateOptions) => {
  const selectedEmailAttachmentPreviewId = selectedEmailAttachmentId
    ? getEmailAttachmentPreviewId({
        attachmentId: selectedEmailAttachmentId,
        fieldId: tab.id,
        workspaceId: tab.workspaceId,
      })
    : null;
  const facet = tab.facet ?? "preview";
  const isPreviewActive = isActive && facet === "preview";
  return {
    emailAttachmentOverlayActivation:
      isActive && tab.facet === "attachments"
        ? FILE_CHAT_OVERLAY_ACTIVATION.active
        : FILE_CHAT_OVERLAY_ACTIVATION.deferred,
    emailAttachmentScaleOffset: selectedEmailAttachmentPreviewId
      ? (scaleOffsets.get(selectedEmailAttachmentPreviewId) ?? 0)
      : 0,
    emailPreviewOverlayActivation: isPreviewActive
      ? FILE_CHAT_OVERLAY_ACTIVATION.active
      : FILE_CHAT_OVERLAY_ACTIVATION.deferred,
    emailSidepeekOverlayActivation:
      isPreviewActive || (isActive && tab.facet === "attachments")
        ? FILE_CHAT_OVERLAY_ACTIVATION.active
        : FILE_CHAT_OVERLAY_ACTIVATION.deferred,
    selectedEmailAttachmentPreviewId,
  };
};

type UseEmailAttachmentSelectionOptions = {
  handleResetZoom: (tabId: string) => void;
  handleZoom: (tabId: string, direction: "in" | "out") => void;
  isActive: boolean;
  scaleOffsets: ReadonlyMap<string, number>;
  tab: FileTab;
};

/**
 * The attachment an email tab previews, the zoom that preview keeps under its
 * own id, and when each email chat overlay activates.
 */
export const useEmailAttachmentSelection = ({
  handleResetZoom,
  handleZoom,
  isActive,
  scaleOffsets,
  tab,
}: UseEmailAttachmentSelectionOptions) => {
  const setFileFacet = useInspectorTabsStore((s) => s.setFileFacet);
  const [selectedEmailAttachmentId, setSelectedEmailAttachmentId] = useState<
    string | null
  >(null);
  const {
    emailAttachmentOverlayActivation,
    emailAttachmentScaleOffset,
    emailPreviewOverlayActivation,
    emailSidepeekOverlayActivation,
    selectedEmailAttachmentPreviewId,
  } = getEmailAttachmentState({
    isActive,
    scaleOffsets,
    selectedEmailAttachmentId,
    tab,
  });
  const openEmailAttachment = (attachmentId: string | null) => {
    setSelectedEmailAttachmentId(attachmentId);
    setFileFacet(tab.id, "attachments");
  };
  const resetEmailAttachmentZoom = () => {
    if (selectedEmailAttachmentPreviewId) {
      handleResetZoom(selectedEmailAttachmentPreviewId);
    }
  };
  const zoomEmailAttachment = (direction: "in" | "out") => {
    if (selectedEmailAttachmentPreviewId) {
      handleZoom(selectedEmailAttachmentPreviewId, direction);
    }
  };

  return {
    emailAttachmentOverlayActivation,
    emailAttachmentScaleOffset,
    emailPreviewOverlayActivation,
    emailSidepeekOverlayActivation,
    openEmailAttachment,
    resetEmailAttachmentZoom,
    selectedEmailAttachmentId,
    setSelectedEmailAttachmentId,
    zoomEmailAttachment,
  };
};

export type EmailAttachmentSelection = ReturnType<
  typeof useEmailAttachmentSelection
>;
