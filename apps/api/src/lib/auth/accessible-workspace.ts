import type { InferSelectModel } from "drizzle-orm";

import type { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type AccessibleWorkspace = {
  id: SafeId<"workspace">;
  status: InferSelectModel<typeof workspaces>["status"];
};

/** Which matter statuses an operation admits; archived only where it says so. */
export type WorkspaceStatusAccess = "active" | "active-or-archived";

/**
 * The one matter-status policy every surface applies, whether the matter
 * comes from a `:workspaceId` path, a request body, a chat thread or an MCP
 * call: writes need an active matter, reads may also admit an archived one,
 * and a matter being deleted (or not accessible at all) is never admitted.
 */
export const admitsWorkspaceStatus = (
  status: AccessibleWorkspace["status"] | null | undefined,
  admitted: WorkspaceStatusAccess,
): boolean =>
  status === "active" ||
  (admitted === "active-or-archived" && status === "archived");
