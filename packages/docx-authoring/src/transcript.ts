import { Result } from "better-result";

import type { Paragraph, Run } from "@stll/docx-core/model";

import { documentToDocx, DocxAuthoringError } from "./document";
import { markdownToStellaDocument, markdownToStellaDocx } from "./markdown";

/** A transcribed paragraph and where it starts in the recording. */
export type TranscriptParagraph = { startMs: number; text: string };

/** `m:ss`, or `h:mm:ss` from an hour on, as the desktop shows it. */
export const transcriptTimestamp = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${minutes}:${twoDigits(seconds)}`;
};

/**
 * Spoken words as literal Markdown text, escaped the way the document
 * renderer reads escapes back: emphasis, code, link and strike markers
 * always, an underscore outside a word, and an angle bracket that would
 * open a tag. The text stays on one line.
 */
export const markdownText = (text: string): string =>
  text
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/[\\`*[\]~]/gu, "\\$&")
    .replaceAll(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\_")
    .replaceAll(/<(?=\/?[A-Za-z])/gu, "\\<");

type TranscriptDocument = {
  title: string;
  paragraphs: readonly TranscriptParagraph[];
};

/**
 * The transcript as Markdown in stella's house style: the title, then each
 * paragraph led by the time it starts at in the recording.
 */
export const transcriptMarkdown = ({
  title,
  paragraphs,
}: TranscriptDocument): string =>
  [
    `# ${markdownText(title)}`,
    ...paragraphs
      .map(({ startMs, text }) => ({ startMs, text: markdownText(text) }))
      .filter(({ text }) => text.length > 0)
      .map(
        ({ startMs, text }) => `**${transcriptTimestamp(startMs)}** ${text}`,
      ),
  ].join("\n\n");

/** The transcript as a Word document in stella's house style. */
export const transcriptDocx = async (
  transcript: TranscriptDocument,
): Promise<Result<ArrayBuffer, DocxAuthoringError>> =>
  await markdownToStellaDocx(transcriptMarkdown(transcript));

/** The grey the instructions note is set in: secondary text that still
 *  prints legibly. */
const NOTE_COLOR = "737373";

const noteRun = (text: string, bold: boolean): Run => ({
  type: "run",
  formatting: {
    italic: true,
    ...(bold ? { bold: true } : {}),
    color: { rgb: NOTE_COLOR },
  },
  content: [{ type: "text", text }],
});

/**
 * The instructions the speaker gave in the dictation, as a note set apart
 * from the text: the label, then each instruction on its own line, all in
 * grey italics.
 */
const instructionsNote = (
  label: string,
  instructions: readonly string[],
): Paragraph => ({
  type: "paragraph",
  content: [
    noteRun(label, true),
    ...instructions.flatMap((instruction): Run[] => [
      { type: "run", content: [{ type: "break" }] },
      noteRun(instruction.replaceAll(/\s+/gu, " ").trim(), false),
    ]),
  ],
});

/**
 * The cleaned-up text as a Word document in stella's house style: its
 * Markdown headings, emphasis and lists become Word headings, emphasis and
 * lists, with the dictation's instructions noted above when it had any.
 */
export const cleanedTranscriptDocx = async ({
  markdown,
  instructions,
  instructionsLabel,
}: {
  markdown: string;
  instructions: readonly string[];
  instructionsLabel: string;
}): Promise<Result<ArrayBuffer, DocxAuthoringError>> =>
  await Result.tryPromise({
    try: async () => {
      const document = markdownToStellaDocument(markdown);
      if (instructions.length > 0) {
        document.package.document.content.unshift(
          instructionsNote(instructionsLabel, instructions),
        );
      }
      return await documentToDocx(document);
    },
    catch: (cause) =>
      new DocxAuthoringError({
        message: "The cleaned-up text could not be rendered to DOCX.",
        cause,
      }),
  });
