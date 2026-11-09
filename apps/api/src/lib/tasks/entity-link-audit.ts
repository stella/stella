/**
 * The `metadata.change` a task link audit row carries. The handlers write it
 * and the matter activity feed narrates it, so both read these values.
 */
export const TASK_LINK_AUDIT_CHANGE = {
  ADDED: "entity-link-added",
  REMOVED: "entity-link-removed",
} as const;
