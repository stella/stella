import { CheckIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { MarkdownFileDraft } from "@/components/inspector/use-markdown-file-draft";
import { MarkdownHybridEditor } from "@/components/markdown/markdown-hybrid-editor";
import { detached } from "@/lib/detached";

type MarkdownFileViewerProps = {
  draft: MarkdownFileDraft;
  readOnly: boolean;
  tabId: string;
};

export const MarkdownFileViewer = ({
  draft: { setDraft, text, textQuery },
  readOnly,
  tabId,
}: MarkdownFileViewerProps) => {
  const t = useTranslations();
  if (textQuery.isPending) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-sm">
        {t("common.loading")}
      </div>
    );
  }
  if (textQuery.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground max-w-sm text-sm">
          {textQuery.error.message || t("errors.actionFailed")}
        </p>
        <Button
          onClick={() => {
            detached(textQuery.refetch(), "file-tab-panel.refetch");
          }}
          size="xs"
          variant="secondary"
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  // Workspace .md edits use the same hybrid editor as skills. Edits feed
  // the draft; the existing Save button uploads a new file version.
  return (
    <MarkdownHybridEditor
      imagePolicy="data-only"
      key={tabId}
      markdown={text}
      onMarkdownChange={setDraft}
      readOnly={readOnly}
    />
  );
};

/** Cancel and Save for an unsaved Markdown draft; nothing while it is clean. */
export const MarkdownDraftActions = ({
  draft: { discard, isDirty, isSaving, save },
}: {
  draft: MarkdownFileDraft;
}) => {
  const t = useTranslations();
  if (!isDirty) {
    return null;
  }
  return (
    <>
      <Button disabled={isSaving} onClick={discard} size="xs" variant="ghost">
        <XIcon className="size-3.5" />
        {t("common.cancel")}
      </Button>
      <Button disabled={isSaving} onClick={save} size="xs">
        <CheckIcon className="size-3.5" />
        {t("common.save")}
      </Button>
    </>
  );
};
