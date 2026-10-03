import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log.constants";

type ChatAuditResourceType =
  | typeof AUDIT_RESOURCE_TYPE.CHAT_THREAD
  | typeof AUDIT_RESOURCE_TYPE.CHAT_MESSAGE
  | typeof AUDIT_RESOURCE_TYPE.CHAT_FILE;

/**
 * Change fields an audit entry about a chat resource may carry. Chat payloads
 * come from conversations, so only settings and identifiers are listed here:
 * free text (titles, names, message content) never enters `changes`, whatever
 * key a writer uses. A field that is not listed is dropped when the entry is
 * written and again when it is read, so older rows follow the same projection.
 * `created` and `deleted` hold snapshots that are projected with the same list.
 */
const CHAT_CHANGE_FIELDS = {
  [AUDIT_RESOURCE_TYPE.CHAT_THREAD]: new Set([
    "chatModel",
    "chatReasoningEffort",
    "contextMatterIds",
    "created",
    "deleted",
    "titleChanged",
    "titleSource",
    "webSearchEnabled",
  ]),
  [AUDIT_RESOURCE_TYPE.CHAT_MESSAGE]: new Set<string>(),
  [AUDIT_RESOURCE_TYPE.CHAT_FILE]: new Set<string>(),
} as const satisfies Record<ChatAuditResourceType, ReadonlySet<string>>;

const isChatResourceType = (
  resourceType: string,
): resourceType is ChatAuditResourceType =>
  Object.hasOwn(CHAT_CHANGE_FIELDS, resourceType);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutTitles = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withoutTitles);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "title")
      .map(([key, nested]) => [key, withoutTitles(nested)]),
  );
};

const onlyListedFields = (
  value: unknown,
  fields: ReadonlySet<string>,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => onlyListedFields(item, fields));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => fields.has(key))
      .map(([key, nested]) => [key, onlyListedFields(nested, fields)]),
  );
};

/** Projects one `{ old, new }` diff: snapshots keep only the listed fields. */
const projectDiff = (diff: unknown, fields: ReadonlySet<string>): unknown => {
  if (!isRecord(diff)) {
    return diff;
  }
  return Object.fromEntries(
    Object.entries(diff)
      .filter(([side]) => side === "old" || side === "new")
      .map(([side, value]) => [side, onlyListedFields(value, fields)]),
  );
};

/** The `changes` an audit entry stores and shows for its resource type. */
export const auditChangesForResource = (
  resourceType: string,
  changes: Record<string, unknown> | null | undefined,
) => {
  if (!changes) {
    return null;
  }
  if (!isChatResourceType(resourceType)) {
    return changes;
  }
  const fields = CHAT_CHANGE_FIELDS[resourceType];
  return Object.fromEntries(
    Object.entries(changes)
      .filter(([key]) => fields.has(key))
      .map(([key, diff]) => [key, projectDiff(diff, fields)]),
  );
};

/** The request and event `metadata` an audit entry stores. */
export const auditMetadataForResource = (
  resourceType: string,
  details: Record<string, unknown> | null | undefined,
) => {
  if (!details) {
    return null;
  }
  if (resourceType !== AUDIT_RESOURCE_TYPE.CHAT_THREAD) {
    return details;
  }
  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => key !== "title")
      .map(([key, value]) => [key, withoutTitles(value)]),
  );
};
