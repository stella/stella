import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckIcon, XIcon } from "@stll/ui/icons";

import { TextFileQueryState } from "@/components/inspector/text-file-query-state";
import type { MarkdownFileDraft } from "@/components/inspector/use-markdown-file-draft";
import { MarkdownHybridEditor } from "@/components/markdown/markdown-hybrid-editor";

type MarkdownFileViewerProps = {
  draft: MarkdownFileDraft;
  readOnly: boolean;
  tabId: string;
};

// Workspace .md edits use the same hybrid editor as skills. Edits feed the
// draft; the existing Save button uploads a new file version.
export const MarkdownFileViewer = ({
  draft: { editorRef, isSaving, setDraft, text, textQuery },
  readOnly,
  tabId,
}: MarkdownFileViewerProps) => (
  <TextFileQueryState textQuery={textQuery}>
    {() => (
      <MarkdownHybridEditor
        imagePolicy="data-only"
        key={tabId}
        markdown={text}
        onMarkdownChange={setDraft}
        readOnly={readOnly || isSaving}
        ref={editorRef}
      />
    )}
  </TextFileQueryState>
);

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
