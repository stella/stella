import { ExternalLinkIcon, SaveIcon } from "lucide-react";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";

import { Notice } from "@/components/notice";
import { Panel, PanelTitle } from "@/components/panel";
import type { Translate } from "@/components/panel";
import { env } from "@/env";
import { isIngestActive, type IngestState } from "@/ingestion-state";
import { buildSavedEmailUrl } from "@/lib/saved-email-url";
import type { OutlookAttachment, WorkspaceSummary } from "@/types";

type SavePanelProps = {
  attachments: OutlookAttachment[];
  onSave: () => void;
  onToggleAttachment: (attachmentId: string) => void;
  saveState: IngestState;
  selectedAttachmentIds: Set<string>;
  selectedWorkspace: WorkspaceSummary | null;
  t: Translate;
};

export const SavePanel = ({
  attachments,
  onSave,
  onToggleAttachment,
  saveState,
  selectedAttachmentIds,
  selectedWorkspace,
  t,
}: SavePanelProps) => {
  const visibleAttachments = attachments.filter(
    (attachment) => !attachment.isInline,
  );
  const saveLabel = selectedWorkspace
    ? t("saveButtonLabel", { matterName: selectedWorkspace.name })
    : t("chooseMatter");
  const savedEmailUrl =
    saveState.type === "complete"
      ? buildSavedEmailUrl({
          baseUrl: env.stellaWebUrl,
          entityId: saveState.entityId,
          fieldId: saveState.fieldId,
          workspaceId: saveState.workspaceId,
        })
      : null;

  return (
    <Panel className="pb-4">
      <PanelTitle icon={<SaveIcon />} title={t("saveEmail")} />
      <div className="grid gap-2">
        <p className="text-muted-foreground text-xs/4.5">
          {t("attachmentSelection")}
        </p>
        {visibleAttachments.length === 0 ? (
          <p className="text-muted-foreground text-xs/4.5">
            {t("noAttachments")}
          </p>
        ) : null}
        {visibleAttachments.map((attachment) => (
          <AttachmentRow
            attachment={attachment}
            isSelected={selectedAttachmentIds.has(attachment.id)}
            key={attachment.id}
            onToggle={onToggleAttachment}
          />
        ))}
      </div>
      <Button
        className="w-full"
        disabled={
          !selectedWorkspace ||
          isIngestActive(saveState) ||
          saveState.type === "complete"
        }
        loading={isIngestActive(saveState)}
        onClick={onSave}
      >
        <SaveIcon />
        {saveState.type === "complete" ? t("saved") : saveLabel}
      </Button>
      {saveState.type === "complete" ? (
        <Notice title={t("saveSuccess")} tone="success">
          {t("attachmentsSaved", { count: saveState.attachmentCount })}
          {saveState.skippedAttachments.length > 0 ? (
            <span className="mt-1 block">
              {t("attachmentsSkipped")}:{" "}
              {saveState.skippedAttachments.join("; ")}
            </span>
          ) : null}
          {savedEmailUrl ? (
            <a
              className="text-primary mt-1 inline-flex items-center gap-1 underline"
              href={savedEmailUrl}
              rel="noreferrer"
              target="_blank"
            >
              {t("openSavedEmail")}
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </Notice>
      ) : null}
      {saveState.type === "error" ? (
        <Notice title={t("saveFailed")} tone="risk">
          {saveState.message}
        </Notice>
      ) : null}
    </Panel>
  );
};

const AttachmentRow = ({
  attachment,
  isSelected,
  onToggle,
}: {
  attachment: OutlookAttachment;
  isSelected: boolean;
  onToggle: (attachmentId: string) => void;
}) => (
  <label className="border-input bg-popover flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2">
    <Checkbox
      checked={isSelected}
      onCheckedChange={() => onToggle(attachment.id)}
    />
    <span className="min-w-0 flex-1 truncate text-xs/4.5">
      {attachment.name}
    </span>
    <span className="text-muted-foreground shrink-0 text-xs/4.5">
      {formatBytes(attachment.size)}
    </span>
  </label>
);

const formatBytes = (value: number | null): string => {
  if (value === null) {
    return "";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};
