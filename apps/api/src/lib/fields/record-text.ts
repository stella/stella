import { recordCellText } from "@stll/api-contract/record-cell";
import type { RecordCellState } from "@stll/api-contract/record-cell";
import { formatMoneyCents } from "@stll/money";

/**
 * The plain text of a record cell, with money read in major units of its
 * currency (`amountMinor` 12345 EUR reads as €123.45, never 12345 EUR).
 */
export const recordText = (state: RecordCellState, locale = "en"): string =>
  recordCellText(state, ({ amountMinor, currency }) =>
    formatMoneyCents({ amountCents: amountMinor, currency, locale }),
  );
