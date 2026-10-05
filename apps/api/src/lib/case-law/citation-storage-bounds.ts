import { panic, TaggedError } from "better-result";

import { caseLawCitations, caseLawDecisions } from "@/api/db/schema";

const columnWidth = ({ length }: { length: number | undefined }) => {
  if (length === undefined || length <= 0) {
    return panic("Citation storage requires an explicit column width");
  }
  return length;
};

// The schema imports citation domain values. Defer column reads until a
// parser or writer runs, after the schema's declarations have initialized.
export const CITATION_STORAGE_WIDTHS = {
  get key() {
    return columnWidth(caseLawCitations.citationKey);
  },
  get text() {
    return columnWidth(caseLawCitations.citationText);
  },
  get courtHint() {
    return columnWidth(caseLawCitations.citedCourtHint);
  },
  get normalizedIdentifier() {
    return columnWidth(caseLawCitations.normalizedIdentifierValue);
  },
  get caseNumber() {
    return columnWidth(caseLawDecisions.caseNumber);
  },
  get court() {
    return columnWidth(caseLawDecisions.court);
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
  if (
    value !== null &&
    value !== undefined &&
    !fitsCitationStorageField(field, value)
  ) {
    throw new CitationStorageFieldError({
      message: `Citation field ${field} exceeds its storage width`,
      field,
      length: Array.from(value).length,
      maximum,
    });
  }
  return value;
};
