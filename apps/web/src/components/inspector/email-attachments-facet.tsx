import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { AlertTriangleIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import type { FileChatOverlayActivation } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import {
  FilePartList,
  FilePartViewer,
} from "@/components/file-parts/file-parts";
import { useFilePartActions } from "@/components/file-parts/use-file-part-actions";
import { EmailViewerWithAI } from "@/components/inspector/email-html-viewer";
import {
  EMAIL_CHAT_HOST,
  EMAIL_CHAT_MODE,
  type EmailChatHost,
  type EmailChatMode,
} from "@/components/inspector/email-html-viewer.logic";
import type { ZoomDirection } from "@/components/inspector/zoom-controls";
import { emailHtmlPreviewOptions } from "@/lib/files/queries";

type EmailAttachmentsFacetProps = {
  chatMode: EmailChatMode;
  entityId: string;
  fieldId: string;
  fileName: string;
  onResetZoom: () => void;
  /** Opens a part (`attachment:2`) in place, or goes back to the list. */
  onSelectedIdChange: (part: string | null) => void;
  onZoom: (direction: ZoomDirection) => void;
  overlayActivation: FileChatOverlayActivation;
  scaleOffset: number;
  selectedId: string | null;
  chatHost?: EmailChatHost;
  workspaceId: string;
};

/**
 * An email's attachments: the shared part list, and the part opened in
 * place through the file's part link, as every other container shows them.
 */
export const EmailAttachmentsFacet = ({
  chatMode,
  entityId,
  fieldId,
  fileName,
  onResetZoom,
  onSelectedIdChange,
  onZoom,
  overlayActivation,
  scaleOffset,
  selectedId,
  chatHost = EMAIL_CHAT_HOST.self,
  workspaceId,
}: EmailAttachmentsFacetProps) => {
  const t = useTranslations();
  const actions = useFilePartActions({ fieldId, workspaceId });
  const previewQuery = useQuery(
    emailHtmlPreviewOptions({ fieldId, workspaceId }),
  );

  if (previewQuery.isPending) {
    return <Skeleton className="m-3 h-24 rounded-sm" />;
  }
  if (previewQuery.isError) {
    return (
      <div
        className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm"
        role="alert"
      >
        <AlertTriangleIcon aria-hidden="true" className="size-5" />
        <p>{t("common.somethingWentWrong")}</p>
      </div>
    );
  }

  const { attachments } = previewQuery.data;
  const selected = attachments.find(({ part }) => part === selectedId);
  const contextual = chatMode === EMAIL_CHAT_MODE.contextual;
  const facet = (
    <>
      {selected === undefined ? (
        <ScrollArea axis="vertical" className="min-h-0 flex-1">
          <div className={cn("p-3", contextual && "pb-40")}>
            {attachments.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t("common.noResults")}
              </p>
            ) : (
              <FilePartList
                actions={actions}
                onOpen={onSelectedIdChange}
                parts={attachments}
                title={t("emailViewer.attachments")}
              />
            )}
          </div>
        </ScrollArea>
      ) : (
        <FilePartViewer
          actions={actions}
          bottomClearance={contextual}
          key={selected.part}
          onBack={() => onSelectedIdChange(null)}
          row={selected}
          source={{ fieldId, workspaceId }}
          zoom={{ onResetZoom, onZoom, scaleOffset }}
        />
      )}
      {actions.dialog}
    </>
  );

  if (chatHost === EMAIL_CHAT_HOST.parent) {
    return facet;
  }

  return (
    <EmailViewerWithAI
      chatMode={chatMode}
      entityId={entityId}
      fieldId={fieldId}
      fileName={fileName}
      overlayActivation={overlayActivation}
      workspaceId={workspaceId}
    >
      {facet}
    </EmailViewerWithAI>
  );
};
