import { panic } from "better-result";

import type {
  RecordFieldRecord,
  RecordFieldScalar,
  RecordFieldState,
} from "./types";

export const getClipFieldValueLabel = ({
  citation,
  url,
}: {
  citation: string | null | undefined;
  url: string;
}) => {
  const trimmedCitation = citation?.trim();

  if (trimmedCitation) {
    return trimmedCitation;
  }

  return url;
};

/** Renders a money value; minor units are not a readable amount. */
export type RecordFieldMoneyFormat = (money: {
  amountMinor: number;
  currency: string;
}) => string;

const recordText = (
  record: RecordFieldRecord,
  formatMoney: RecordFieldMoneyFormat,
): string =>
  Object.values(record)
    .flatMap((value: RecordFieldScalar) => {
      if (value === null) {
        return [];
      }
      return [typeof value === "object" ? formatMoney(value) : String(value)];
    })
    .join(" · ");

export type RecordFieldSummary =
  | { type: "text"; text: string }
  | { type: "records"; count: number }
  | { type: "choose"; count: number }
  | { type: "needs-review" }
  | { type: "not-found" };

/**
 * What a record cell shows at a glance. A candidate list nobody has chosen
 * from asks for a choice; it never shows the first candidate as the answer.
 */
export const summarizeRecordField = (
  state: RecordFieldState,
  formatMoney: RecordFieldMoneyFormat,
): RecordFieldSummary => {
  switch (state.status) {
    case "input-needs-review":
      return { type: "needs-review" };
    case "not-found":
      return { type: "not-found" };
    case "resolved":
      break;
    default:
      state satisfies never;
      return panic("Unknown record field status");
  }
  const { result } = state;
  if (result.kind === "one") {
    return { type: "text", text: recordText(result.record, formatMoney) };
  }
  const selected =
    result.selected === null ? undefined : result.records.at(result.selected);
  if (selected !== undefined) {
    return { type: "text", text: recordText(selected, formatMoney) };
  }
  return result.kind === "candidates"
    ? { type: "choose", count: result.records.length }
    : { type: "records", count: result.records.length };
};
