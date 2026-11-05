/** One changed field of an audit entry, as a reader compares it. */
export type AuditChangeRow =
  | { type: "diff"; field: string; before: unknown; after: unknown }
  | { type: "value"; field: string; value: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFieldDiffKey = (key: string): boolean => {
  switch (key) {
    case "old":
    case "new":
    case "before":
    case "after":
      return true;
    default:
      return false;
  }
};

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
  Object.keys(value).every(isFieldDiffKey);

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
  return Object.entries(changes).flatMap(([field, value]): AuditChangeRow[] => {
    if (!isFieldDiff(value)) {
      return [{ type: "value", field, value }];
    }
    const before = value.before ?? value.old;
    const after = value.after ?? value.new;
    return (
      (isSnapshotField(field) ? snapshotRows(before, after) : null) ?? [
        { type: "diff", field, before, after },
      ]
    );
  });
};

const isAbsent = (value: unknown) => value === null || value === undefined;

/** The fields writers use for a record created or deleted as a whole. */
const isSnapshotField = (field: string) =>
  field === "created" || field === "deleted";

/**
 * A record created or deleted as a whole (`{ deleted: { old: {...}, new: null
 * } }`) reads as its own fields, one row each, rather than as one row of raw
 * JSON.
 */
const snapshotRows = (
  before: unknown,
  after: unknown,
): AuditChangeRow[] | null => {
  if (isRecord(before) && isAbsent(after)) {
    return Object.entries(before).map(([field, value]) => ({
      type: "diff",
      field,
      before: value,
      after: null,
    }));
  }
  if (isAbsent(before) && isRecord(after)) {
    return Object.entries(after).map(([field, value]) => ({
      type: "diff",
      field,
      before: null,
      after: value,
    }));
  }
  return null;
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
