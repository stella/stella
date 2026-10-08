import type { SearchHistoryKind } from "@/api/db/schema";
import type { AuditEvent } from "@/api/lib/audit-log";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log.constants";

const HISTORY_AUDIT_KINDS = {
  // A free-text search does not identify one of the document kinds.
  search: null,
  decision: "case_law",
  statute: "statute",
} as const satisfies Record<SearchHistoryKind, "case_law" | "statute" | null>;

type SearchHistoryAuditOptions = {
  resourceId: string;
  operation: "record" | "import" | "delete" | "clear" | "account-deletion";
  entryCount: number;
  kinds: readonly SearchHistoryKind[];
};

/** Only mutation metadata crosses the audit boundary; history content stays private. */
export const searchHistoryAuditEvent = ({
  resourceId,
  operation,
  entryCount,
  kinds,
}: SearchHistoryAuditOptions) =>
  ({
    action:
      operation === "record" || operation === "import"
        ? AUDIT_ACTION.UPDATE
        : AUDIT_ACTION.DELETE,
    resourceType: AUDIT_RESOURCE_TYPE.SEARCH_HISTORY,
    resourceId,
    metadata: {
      operation,
      entryCount,
      kinds: kinds.flatMap((kind) => {
        const auditKind = HISTORY_AUDIT_KINDS[kind];
        return auditKind === null ? [] : [auditKind];
      }),
    },
  }) as const satisfies AuditEvent;
