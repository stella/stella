import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log.constants";

const withoutTitles = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withoutTitles);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "title")
      .map(([key, nested]) => [key, withoutTitles(nested)]),
  );
};

export const auditDetailsForResource = (
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
