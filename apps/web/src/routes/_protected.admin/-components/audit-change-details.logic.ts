/** One changed field of an audit entry, as a reader compares it. */
export type AuditChangeRow =
  | { type: "diff"; field: string; before: unknown; after: unknown }
  | { type: "value"; field: string; value: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FIELD_DIFF_KEYS = new Set(["old", "new", "before", "after"]);

const isFieldDiff = (
  value: unknown,
): value is {
  old?: unknown;
  new?: unknown;
  before?: unknown;
  after?: unknown;
} =>
  isRecord(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => FIELD_DIFF_KEYS.has(key));

/**
 * Audit `changes` as field rows. Writers record `{ field: { old, new } }` or
 * `{ field: { before, after } }`; anything else (a created record's values, a
 * list of ids) is shown as the field's value, so no payload shape is dropped.
 */
export const auditChangeRows = (changes: unknown): AuditChangeRow[] => {
  if (changes === null || changes === undefined) {
    return [];
  }
  if (!isRecord(changes)) {
    return [{ type: "value", field: "", value: changes }];
  }
  return Object.entries(changes).map(([field, value]) =>
    isFieldDiff(value)
      ? {
          type: "diff",
          field,
          before: value.before ?? value.old,
          after: value.after ?? value.new,
        }
      : { type: "value", field, value },
  );
};

/** Whether a value needs a block of its own rather than one inline line. */
export const isStructuredAuditValue = (value: unknown) =>
  typeof value === "object" && value !== null;

/** A scalar audit value as text; structured values are pretty-printed. */
export const formatAuditValue = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (isStructuredAuditValue(value)) {
    return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(value);
};

/** A value squeezed onto one line for the table's summary. */
export const formatAuditValueInline = (value: unknown): string | null => {
  if (isStructuredAuditValue(value)) {
    return JSON.stringify(value);
  }
  return formatAuditValue(value);
};
