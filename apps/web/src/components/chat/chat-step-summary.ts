import type {
  ProcessSummaryPhrase,
  ProcessSummaryPiece,
} from "@stll/api-contract/chat-tool-activity";
import type { ChatElapsedReading } from "@stll/api-contract/chat-turn-duration";

import type { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";

/**
 * Where the web keeps each phrase of a run's summary
 * (`summarizeProcessRun`). The phone keeps the same words under the same
 * names (`apps/mobile/src/i18n/chat-steps.test.ts`).
 */
const PROCESS_SUMMARY_KEYS = {
  searchedLegislation: "chat.processSummary.searchedLegislation",
  searchedCaseLaw: "chat.processSummary.searchedCaseLaw",
  searchedLegislationAndCaseLaw:
    "chat.processSummary.searchedLegislationAndCaseLaw",
  readDocument: "chat.processSummary.readDocument",
  readDocuments: "chat.processSummary.readDocuments",
  searchedMatters: "chat.processSummary.searchedMatters",
  checkedRegisters: "chat.processSummary.checkedRegisters",
  searchedWeb: "chat.processSummary.searchedWeb",
  searchedChats: "chat.processSummary.searchedChats",
  sourcesChecked: "chat.processSummary.sourcesChecked",
  lookups: "chat.toolCall.lookupCount",
  documentEdits: "chat.processSummary.documentEdits",
  changesSaved: "chat.processSummary.changesSaved",
  steps: "common.stepCount",
} as const satisfies Record<ProcessSummaryPhrase, TranslationKey>;

type ProcessSummaryKey =
  (typeof PROCESS_SUMMARY_KEYS)[keyof typeof PROCESS_SUMMARY_KEYS];

/** A settled run's summary as one line: its phrases, in order. */
export const processSummaryText = (
  pieces: readonly ProcessSummaryPiece[],
  t: (key: ProcessSummaryKey, values: { count: number }) => string,
): string =>
  pieces
    .map(({ phrase, count }) => t(PROCESS_SUMMARY_KEYS[phrase], { count }))
    .join(" · ");

/**
 * Elapsed time as a run's line shows it: narrow seconds ("16s"), then
 * whole minutes in the locale's short unit ("2 min").
 */
export const formatChatElapsed = (
  format: ReturnType<typeof useFormatter>,
  reading: ChatElapsedReading,
): string =>
  format.number(reading.value, {
    style: "unit",
    unit: reading.unit,
    unitDisplay: reading.unit === "second" ? "narrow" : "short",
  });
