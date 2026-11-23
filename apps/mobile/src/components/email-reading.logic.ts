/**
 * An email's date as a date, when its header states one that parses. The
 * header is free text; one that does not parse is shown as written.
 */
export const parseEmailDate = (value: string | null): Date | null => {
  if (value === null || value.trim() === "") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
