import { panic, Result, TaggedError } from "better-result";
import { getColumns } from "drizzle-orm";

import { caseLawCitations, caseLawDecisions } from "@/api/db/schema";

const columnWidth = (length: number | undefined) => {
  if (length === undefined || length <= 0) {
    return panic("Citation storage requires an explicit column width");
  }
  return length;
};

// The schema imports citation domain values. Defer column reads until a
// parser or writer runs, after the schema's declarations have initialized.
export const CITATION_STORAGE_WIDTHS = {
  get key() {
    return columnWidth(getColumns(caseLawCitations).citationKey.length);
  },
  get text() {
    return columnWidth(getColumns(caseLawCitations).citationText.length);
  },
  get courtHint() {
    return columnWidth(getColumns(caseLawCitations).citedCourtHint.length);
  },
  get normalizedIdentifier() {
    return columnWidth(
      getColumns(caseLawCitations).normalizedIdentifierValue.length,
    );
  },
  get caseNumber() {
    return columnWidth(getColumns(caseLawDecisions).caseNumber.length);
  },
  get court() {
    return columnWidth(getColumns(caseLawDecisions).court.length);
  },
} as const;

export class CitationStorageFieldError extends TaggedError(
  "CitationStorageFieldError",
)<{
  message: string;
  field: keyof typeof CITATION_STORAGE_WIDTHS;
  length: number;
  maximum: number;
}> {}

/** PostgreSQL varchar widths count characters, including supplementary code points. */
export const fitsCitationStorageField = (
  field: keyof typeof CITATION_STORAGE_WIDTHS,
  value: string,
) => Array.from(value).length <= CITATION_STORAGE_WIDTHS[field];

/** A key is either exact and searchable, or absent; never a truncated identity. */
export const boundedCitationKey = (value: string): string | null =>
  value.length > 0 && fitsCitationStorageField("key", value) ? value : null;

/** Reject an unrepresentable field before constructing a database statement. */
export const assertCitationStorageField = <T extends string | null | undefined>(
  field: keyof typeof CITATION_STORAGE_WIDTHS,
  value: T,
) => {
  const maximum = CITATION_STORAGE_WIDTHS[field];
  if (typeof value === "string" && !fitsCitationStorageField(field, value)) {
    return Result.err(
      new CitationStorageFieldError({
        message: `Citation field ${field} exceeds its storage width`,
        field,
        length: Array.from(value).length,
        maximum,
      }),
    );
  }
  return Result.ok(value);
};
