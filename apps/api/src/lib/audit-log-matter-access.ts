import { sql } from "drizzle-orm";

import { workspaceCheck } from "@/api/db/rls";
import { auditLogs } from "@/api/db/schema";

/**
 * Whether the reader may see an audit row's matter: organization-level rows
 * always, matter rows only for a matter the transaction's workspace
 * authorization admits. Every audit read applies this one rule: the activity
 * log and its export filter on it, and the organization archive keeps the rows
 * it rejects with their matter details withheld.
 */
export const auditLogMatterReadable = sql<boolean>`(${auditLogs.workspaceId} IS NULL OR ${workspaceCheck})`;
