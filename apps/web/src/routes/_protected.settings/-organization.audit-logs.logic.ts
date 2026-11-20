import { AUDIT_PERFORMER_FILTER } from "@stll/api-contract/audit-log";
import type { AuditPerformerFilter } from "@stll/api-contract/audit-log";

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
