import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { cleanedMarkdown } from "@stll/transcript/cleanup";

import type { Paragraph } from "./transcribe-logic";
import { transcriptText } from "./transcribe-logic";
import type { SaveOption } from "./TranscribeCleanup";
import { saveTranscriptDocx } from "./transcript-docx";
import type { TranscriptDocx } from "./transcript-docx";

/**
 * The Save as entries of both panes: the transcript as a Word document or
 * as text with or without timestamps, and the cleaned-up text as a Word
 * document, formatted text or plain text. `onResult` hears whether a save
 * failed; a cancelled save is not a failure.
 */
export const useTranscriptSaveOptions = ({
  title,
  paragraphs,
  cleanup,
  cleanedPlain,
  onResult,
}: {
  title: string;
  paragraphs: readonly Paragraph[];
  cleanup: { instructions: readonly string[]; markdown: string };
  cleanedPlain: string;
  onResult: (failed: boolean) => void;
}): { transcript: SaveOption[]; cleaned: SaveOption[] } => {
  const t = useTranslations("transcribe");
  const saveText = async (
    text: string,
    fileName: string,
    format: "text" | "markdown",
  ) => {
    onResult(false);
    const result = await Result.tryPromise(async () =>
      invoke<boolean>("transcribe_save_text", {
        request: { text, fileName, format },
      }),
    );
    onResult(Result.isError(result));
  };
  const saveDocx = async (document: TranscriptDocx, fileName: string) => {
    onResult(false);
    const result = await saveTranscriptDocx(document, fileName);
    onResult(Result.isError(result));
  };
  return {
    transcript: [
      {
        id: "docx",
        file: "docx",
        label: t("matterFolder.saveDocx"),
        onSave: () => {
          void saveDocx(
            {
              kind: "raw",
              title: t("result.documentTitle", { title }),
              paragraphs,
            },
            t("matterFolder.docxFileName", { title }),
          );
        },
      },
      {
        id: "timestamps",
        file: "text",
        label: t("result.saveWithTimestamps"),
        onSave: () => {
          void saveText(
            transcriptText(paragraphs, { timestamps: true }),
            t("result.fileName", { title }),
            "text",
          );
        },
      },
      {
        id: "plain",
        file: "text",
        label: t("result.saveWithoutTimestamps"),
        onSave: () => {
          void saveText(
            transcriptText(paragraphs, { timestamps: false }),
            t("result.fileName", { title }),
            "text",
          );
        },
      },
    ],
    cleaned: [
      {
        id: "docx",
        file: "docx",
        label: t("matterFolder.saveDocx"),
        onSave: () => {
          void saveDocx(
            {
              kind: "cleaned",
              markdown: cleanup.markdown,
              instructions: cleanup.instructions,
              instructionsLabel: t("matterFolder.instructionsLabel"),
            },
            t("matterFolder.cleanedDocxFileName", { title }),
          );
        },
      },
      {
        id: "markdown",
        file: "text",
        label: t("cleaned.saveMarkdown"),
        onSave: () => {
          void saveText(
            cleanedMarkdown(
              cleanup.instructions,
              cleanup.markdown,
              t("cleaned.instructionsLabel"),
            ),
            t("cleaned.fileNameMarkdown", { title }),
            "markdown",
          );
        },
      },
      {
        id: "text",
        file: "text",
        label: t("cleaned.saveText"),
        onSave: () => {
          void saveText(
            cleanedPlain,
            t("cleaned.fileNameText", { title }),
            "text",
          );
        },
      },
    ],
  };
};
