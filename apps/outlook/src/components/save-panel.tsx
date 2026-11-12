import { Button } from "@stll/ui/components/button";
import { ExternalLinkIcon, SaveIcon } from "@stll/ui/icons";

import { Notice } from "@/components/notice";
import { Panel, PanelTitle } from "@/components/panel";
import type { Translate } from "@/components/panel";
import { env } from "@/env";
import { type FileEmailState, isFileEmailActive } from "@/hooks/use-file-email";
import { buildSavedEmailUrl } from "@/lib/saved-email-url";
import type { WorkspaceSummary } from "@/types";

type SavePanelProps = {
  onSave: () => void;
  saveState: FileEmailState;
  selectedWorkspace: WorkspaceSummary | null;
  t: Translate;
};

const saveButtonLabel = ({
  saveState,
  selectedWorkspace,
  t,
}: Omit<SavePanelProps, "onSave">): string => {
  if (saveState.type === "complete") {
    return t("saved");
  }
  if (saveState.type === "error" && saveState.retry !== null) {
    return t("finishSaving");
  }
  return selectedWorkspace
    ? t("saveButtonLabel", { matterName: selectedWorkspace.name })
    : t("chooseMatter");
};

export const SavePanel = ({
  onSave,
  saveState,
  selectedWorkspace,
  t,
}: SavePanelProps) => {
  const active = isFileEmailActive(saveState);

  return (
    <Panel className="pb-4">
      <PanelTitle icon={<SaveIcon />} title={t("saveEmail")} />
      <p className="text-muted-foreground text-xs/4.5">
        {t("saveDescription")}
      </p>
      <Button
        className="w-full"
        disabled={!selectedWorkspace || active || saveState.type === "complete"}
        loading={active}
        onClick={onSave}
      >
        <SaveIcon />
        {saveButtonLabel({ saveState, selectedWorkspace, t })}
      </Button>
      {saveState.type === "complete" ? (
        <Notice role="status" title={t("saveSuccess")} tone="success">
          {t("savedAsEmailFile", { fileName: saveState.result.fileName })}
          {saveState.source === "rebuilt" ? (
            <span className="mt-1 block">{t("savedRebuilt")}</span>
          ) : null}
          {saveState.skippedAttachments.length > 0 ? (
            <span className="mt-1 block">
              {t("attachmentsSkipped")}:{" "}
              {saveState.skippedAttachments.join("; ")}
            </span>
          ) : null}
          <a
            className="text-primary mt-1 inline-flex items-center gap-1 underline"
            href={buildSavedEmailUrl({
              baseUrl: env.webOrigin,
              entityId: saveState.result.entityId,
              fieldId: saveState.result.fieldId,
              workspaceId: saveState.result.workspaceId,
            })}
            rel="noreferrer"
            target="_blank"
          >
            {t("openSavedEmail")}
            <ExternalLinkIcon className="size-3" />
          </a>
        </Notice>
      ) : null}
      {saveState.type === "error" ? (
        <Notice role="alert" title={t("saveFailed")} tone="risk">
          {saveState.message}
        </Notice>
      ) : null}
    </Panel>
  );
};
