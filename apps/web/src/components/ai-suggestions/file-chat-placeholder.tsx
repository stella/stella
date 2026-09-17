/**
 * What the composer floating over a document says while it is empty.
 *
 * One owner, because two bars ask: the live one the chat runtime mounts, and
 * the gated one a visitor without an account gets in its place. A visitor must
 * read exactly what a member reads, so neither bar may word this for itself.
 * Kept out of the overlay's own module so the gated bar can have the copy
 * without the editor bundle behind it.
 */

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { COMPOSER_TEXT_CLASS } from "@stll/ui/composer";
import { cn } from "@stll/ui/utils";

import { activeLegalDocumentRef } from "@/components/ai-suggestions/active-legal-document";
import type { FileViewerWithAIProps } from "@/components/ai-suggestions/file-viewer-with-ai.impl";

export type FileChatPlaceholderSource = Pick<
  FileViewerWithAIProps,
  "activeDraft" | "activeExternal" | "activeFile" | "activeLegal"
> & { docxEditSafety?: FileViewerWithAIProps["docxEditSafety"] };

type FileChatPlaceholder = {
  /** The editor's own placeholder text, which names the document. */
  placeholder: string | undefined;
  /** The verb half of the empty row, drawn beside the document's name. */
  placeholderAction: string | undefined;
  sourceLabel: string | undefined;
};

export const useFileChatPlaceholder = ({
  activeDraft,
  activeExternal,
  activeFile,
  activeLegal,
  docxEditSafety,
}: FileChatPlaceholderSource): FileChatPlaceholder => {
  const t = useTranslations();
  if (activeDraft !== undefined) {
    return {
      placeholder: t("chat.editableFilePlaceholder", {
        title: activeDraft.fileName,
      }),
      placeholderAction: t("chat.editableFilePlaceholderAction"),
      sourceLabel: activeDraft.fileName,
    };
  }
  if (activeFile !== undefined) {
    const canOfferEdit =
      activeFile.editable === true && docxEditSafety !== "unsafe";
    return {
      placeholder: t(
        canOfferEdit
          ? "chat.editableFilePlaceholder"
          : "chat.sourcePlaceholder",
        { title: activeFile.fileName },
      ),
      placeholderAction: t(
        canOfferEdit
          ? "chat.editableFilePlaceholderAction"
          : "chat.sourcePlaceholderAction",
      ),
      sourceLabel: activeFile.fileName,
    };
  }
  if (activeExternal !== undefined) {
    return {
      placeholder: t("chat.sourcePlaceholder", { title: activeExternal.title }),
      placeholderAction: t("chat.sourcePlaceholderAction"),
      sourceLabel: activeExternal.title,
    };
  }
  if (activeLegal !== undefined) {
    const { label } = activeLegalDocumentRef(activeLegal);
    return {
      placeholder: t("chat.sourcePlaceholder", { title: label }),
      placeholderAction: t("chat.sourcePlaceholderAction"),
      sourceLabel: label,
    };
  }
  return {
    placeholder: undefined,
    placeholderAction: undefined,
    sourceLabel: undefined,
  };
};

/**
 * The empty row itself: the verb, then the document it acts on. Returns null
 * where the surface names no document, which is the bar's own empty state.
 */
export const FileChatEmptyPlaceholder = ({
  placeholderAction,
  sourceLabel,
}: Pick<FileChatPlaceholder, "placeholderAction" | "sourceLabel">) => {
  if (placeholderAction === undefined) {
    return null;
  }

  return (
    <span
      className={cn(
        "text-foreground-ghost flex min-w-0 items-center gap-1.5",
        COMPOSER_TEXT_CLASS,
      )}
    >
      <span className="shrink-0">{placeholderAction}</span>
      <BidiText as="span" className="text-foreground-label max-w-64 truncate">
        {sourceLabel}
      </BidiText>
    </span>
  );
};
