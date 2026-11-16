import { panic } from "better-result";
import * as v from "valibot";

import type { DesktopDictationSegment } from "@stll/api-contract/desktop-dictation-cleanup";

import {
  acceptDictationCleanup,
  dictationCleanupModelOutputSchema,
} from "../../src/handlers/dictation/cleanup-model";
import { dictationCleanupCases } from "./dictation-cleanup-cases";

export const dictationCleanupLocalResultSchema = v.object({
  caseId: v.string(),
  harness: v.pipe(v.string(), v.minLength(1)),
  output: dictationCleanupModelOutputSchema,
});

/** Bold the way the desktop types it: the spaces around the phrase stay
 *  outside the bold. */
const renderBold = (text: string) => {
  const phrase = text.trim();
  if (phrase.length === 0) {
    return text;
  }
  const start = text.length - text.trimStart().length;
  return `${text.slice(0, start)}**${phrase}**${text.slice(start + phrase.length)}`;
};

/** The segments as text: "\n" per line break, "\n\n" per paragraph break,
 *  bold as **text**. An asterisk the answer types is escaped, so typed
 *  asterisks never read as bold. */
export const renderDictationSegments = (
  segments: readonly DesktopDictationSegment[],
) =>
  segments
    .map((segment) => {
      switch (segment.type) {
        case "text": {
          const text = segment.text.replaceAll("*", "\\*");
          return segment.bold ? renderBold(text) : text;
        }
        case "lineBreak":
          return "\n";
        case "paragraphBreak":
          return "\n\n";
        default:
          return panic("Unknown dictation segment", segment satisfies never);
      }
    })
    .join("")
    // Spaces that meet a break or a bold edge are typed apart by the desktop.
    .replaceAll(/ *\n */gu, "\n")
    .replaceAll(/ {2,}/gu, " ");

/**
 * Each result through the production acceptance (the server's bounds), then
 * compared with the expected text. An accepted answer that reads differently
 * fails; a refused answer fails as `accepted: false`.
 */
export const scoreDictationCleanup = (
  results: v.InferOutput<typeof dictationCleanupLocalResultSchema>[],
) => {
  const expectedIds = dictationCleanupCases.map(({ id }) => id).toSorted();
  const actualIds = results.map(({ caseId }) => caseId).toSorted();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    panic("Results must cover each dictation cleanup case exactly once");
  }
  return results.map(({ caseId, output }) => {
    const scenario =
      dictationCleanupCases.find(({ id }) => id === caseId) ??
      panic("Unknown dictation cleanup case");
    const accepted = acceptDictationCleanup(output, scenario.transcript);
    const rendered = accepted.isOk()
      ? renderDictationSegments(accepted.value.segments)
      : null;
    return {
      caseId,
      accepted: accepted.isOk(),
      pass: rendered !== null && rendered.trimEnd() === scenario.expected,
      rendered,
    };
  });
};
