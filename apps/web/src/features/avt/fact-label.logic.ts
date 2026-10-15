/**
 * How an anchor fact's name reads in the record. Imported facts often carry
 * their exhibit reference and a "date (source):" lead-in inside the name
 * ("CAL-01: 9 Mar 2021 (Outlook export p.14): Calendar invitation …"), which
 * the row already shows from the structured fields. The reference becomes a
 * quiet label; the lead-in is dropped only when the fact has a recorded date
 * and its source is exactly the recorded medium, so nothing the fields do not
 * show is ever hidden.
 */

export type FactLabel = {
  reference: string | null;
  statement: string;
};

type RecordedFields = {
  medium: string | null;
  dated: boolean;
};

/** An exhibit-style reference: "CAL-01", "BANK-02", "EM-4a", "WS_12". */
const REFERENCE_PREFIX = /^([A-Z][A-Z0-9]*[-_.][A-Z0-9]+[a-z]?):\s+/u;

/** A lead-in longer than this is prose, not a date. */
const MAX_DATE_LEAD_IN_LENGTH = 32;

export const factLabel = (
  name: string,
  recorded: RecordedFields,
): FactLabel => {
  const match = REFERENCE_PREFIX.exec(name);
  const reference = match?.[1] ?? null;
  const rest = match === null ? name : name.slice(match[0].length);
  return { reference, statement: withoutSourceLeadIn(rest, recorded) };
};

const withoutSourceLeadIn = (
  text: string,
  { medium, dated }: RecordedFields,
): string => {
  if (!dated || medium === null || medium === "") {
    return text;
  }
  const marker = ` (${medium}): `;
  const index = text.indexOf(marker);
  if (index <= 0 || index > MAX_DATE_LEAD_IN_LENGTH) {
    return text;
  }
  const leadIn = text.slice(0, index);
  if (leadIn.includes(":") || !/\d/u.test(leadIn)) {
    return text;
  }
  const statement = text.slice(index + marker.length);
  return statement === "" ? text : statement;
};
