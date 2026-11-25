import {
  AUDIT_PERFORMER_FILTER,
  AUDIT_RESOURCE_TYPE,
} from "@stll/api-contract/audit-log";
import type {
  AuditPerformerFilter,
  AuditResourceType,
} from "@stll/api-contract/audit-log";

// Background services write far more rows than people do; the log opens on
// what members did and shows automations on request.
export const DEFAULT_PERFORMER_FILTER = AUDIT_PERFORMER_FILTER.people;
export const AUDIT_LOG_PAGE_LIMIT = 20;
export const ALL_PERFORMERS = "all";

export type PerformerChoice = AuditPerformerFilter | typeof ALL_PERFORMERS;

export const toPerformerChoice = (value: string | null): PerformerChoice => {
  if (value === AUDIT_PERFORMER_FILTER.automations) {
    return AUDIT_PERFORMER_FILTER.automations;
  }
  if (value === ALL_PERFORMERS) {
    return ALL_PERFORMERS;
  }
  return DEFAULT_PERFORMER_FILTER;
};

const MATTER_RESOURCE_TYPE_ALIAS = "matter";
const AUDIT_RESOURCE_TYPES = Object.values(AUDIT_RESOURCE_TYPE);

/**
 * Translates user-facing resource type names (such as "matter" or a localized
 * resource label) to the internal audit resource type at the filter boundary.
 */
export const resolveAuditResourceTypeFilter = (
  raw: string,
  resolveLabel?: (resourceType: AuditResourceType) => string,
): string | undefined => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (AUDIT_RESOURCE_TYPES.some((kind) => kind === trimmed)) {
    return trimmed;
  }
  const normalized = trimmed.toLocaleLowerCase();
  if (normalized === MATTER_RESOURCE_TYPE_ALIAS) {
    return AUDIT_RESOURCE_TYPE.WORKSPACE;
  }
  if (resolveLabel) {
    for (const resourceType of AUDIT_RESOURCE_TYPES) {
      if (
        resolveLabel(resourceType).trim().toLocaleLowerCase() === normalized
      ) {
        return resourceType;
      }
    }
  }
  return trimmed;
};
