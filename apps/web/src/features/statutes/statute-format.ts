import type { createFormatter } from "use-intl/core";

import { parseDeterministicDate } from "@/lib/deterministic-date";

type IntlFormatter = ReturnType<typeof createFormatter>;

export const EM_DASH = "—";

/** Date-only validity boundary, rendered in the reader's locale. */
export const formatValidityDate = (
  value: Date | string | null,
  format: IntlFormatter,
): string | null => {
  if (value === null) {
    return null;
  }

  const date = parseDeterministicDate(value);

  return date === null
    ? null
    : format.dateTime(date, { dateStyle: "medium", timeZone: "UTC" });
};

type FormatValidityRangeOptions = {
  format: IntlFormatter;
  openEnded: string;
  validFrom: Date | string | null;
  validTo: Date | string | null;
};

type StatuteCitationInput = {
  eli: string;
  /** The provision a quotation sits in; null outside any provision. */
  provision: string | null;
  title: string;
  /** The day the consolidation quoted came into force, ISO-8601. */
  versionValidFrom: string | null;
};

/**
 * A citation of a statute passage, from the pieces the document states about
 * itself. Statute citation styles differ by jurisdiction far more than the
 * corpus knows about, so this composes the identifiers themselves rather than
 * a jurisdiction's connective words, and dates the consolidation in ISO-8601
 * so "as at" is unambiguous in every locale.
 */
export const formatStatuteCitation = ({
  eli,
  provision,
  title,
  versionValidFrom,
}: StatuteCitationInput): string => {
  const identity = [provision, title, eli]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(", ");

  return versionValidFrom === null || versionValidFrom.trim() === ""
    ? identity
    : `${identity} (${versionValidFrom})`;
};

/** Compact temporal-version label for chrome and version pickers. */
export const formatValidityRange = ({
  format,
  openEnded,
  validFrom,
  validTo,
}: FormatValidityRangeOptions): string =>
  `${formatValidityDate(validFrom, format) ?? EM_DASH} – ${
    formatValidityDate(validTo, format) ?? openEnded
  }`;
