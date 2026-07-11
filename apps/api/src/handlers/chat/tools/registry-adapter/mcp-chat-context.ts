import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { AuthorizedToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import type { MemberRole } from "@/api/lib/member-roles";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import type { McpRequestContext } from "@/api/mcp/context";

/**
 * Everything a chat request has already resolved that an `McpRequestContext`
 * needs. These are the same values `getChatTools` threads into the execution
 * tools today (`chat-tools.ts`), just gathered into one shape. Typed against the
 * adapter's own contract (not chat's live types) so this step can widen inputs
 * without touching live chat.
 */
export type ChatRegistryContextDeps = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberRole: MemberRole;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  /**
   * The request's authorized workspace set. `getChatTools` already resolves
   * this via `resolveToolWorkspaceIds` (pins intersected with the accessible
   * set), so it is the correct source for `accessibleWorkspaceIds`.
   */
  toolWorkspaceIds: AuthorizedToolWorkspaceIds;
  /**
   * Optional, like chat's own `getChatTools` param. Read tools do not mutate,
   * so there is nothing to audit today; it is threaded through so any future
   * logging inside a projected handler is not silently dropped, and defaults to
   * a no-op when chat does not supply one.
   */
  recordAuditEvent?: AuditRecorder | undefined;
  /**
   * Optional per-workspace status. Chat's `AuthorizedToolWorkspaceIds` is a
   * bare id list and carries no status; every projected read tool gates
   * workspace access on the id set alone (`ensureWorkspaceAccess`) and never
   * consults `accessibleWorkspaceStatusById` (only write tools do, via
   * `ensureActiveWorkspace` / `getWorkspaceStatus`). So this defaults to
   * "active" for every authorized workspace: a value that is never read on the
   * read path. It is accepted here so the write-tool driver (a later step) can
   * supply real statuses without reshaping this adapter.
   */
  workspaceStatusById?:
    | ReadonlyMap<string, AccessibleWorkspace["status"]>
    | undefined;
};

// eslint-disable-next-line promise-function-async -- read tools never record audit events; this returns a resolved promise directly, and `async` would only add a redundant wrapper with nothing to await (which `require-await` then rejects)
const NO_OP_AUDIT_RECORDER: AuditRecorder = () => Promise.resolve();

const deriveWorkspaceStatusMap = ({
  toolWorkspaceIds,
  workspaceStatusById,
}: ChatRegistryContextDeps): Map<string, AccessibleWorkspace["status"]> => {
  const statusById = new Map<string, AccessibleWorkspace["status"]>();
  for (const workspaceId of toolWorkspaceIds) {
    statusById.set(
      workspaceId,
      workspaceStatusById?.get(workspaceId) ?? "active",
    );
  }
  return statusById;
};

/**
 * Project a chat request's already-resolved session/workspace state onto the
 * `McpRequestContext` the registry handlers expect. A thin mapping, not a new
 * resolution path: no DB query, no membership lookup.
 *
 * Scope/feature gating is deliberately NOT applied here. MCP dispatch gates a
 * tool on its `ToolScope` (the caller's OAuth scope) and its
 * `McpToolFeatureFlag` (a deploy flag). OAuth scopes have no meaning for a
 * session-authed chat turn: reaching `getChatTools` already means the request
 * passed the coarser workspace/role authorization that governs reads, so scope
 * gating is dropped. Feature-flag gating still matters (a tool's backing surface
 * can be off on this deployment) and is re-checked in the orchestrator, not
 * here, where the tool name is known.
 */
export const buildMcpContextFromChat = (
  deps: ChatRegistryContextDeps,
): McpRequestContext => {
  const accessibleWorkspaceIds = [...deps.toolWorkspaceIds];
  const accessibleWorkspaceStatusById = deriveWorkspaceStatusMap(deps);
  return {
    accessibleWorkspaceIds,
    accessibleWorkspaceIdSet: new Set(accessibleWorkspaceIds),
    accessibleWorkspaceStatusById,
    // Reconstructed from the authorized id set + status map; chat never
    // dispatches the generic capability path, so this is unread on this surface.
    accessibleWorkspaces: [...accessibleWorkspaceStatusById].map(
      ([id, status]) => ({ id: brandPersistedWorkspaceId(id), status }),
    ),
    // A session-authed chat turn carries no OAuth scopes; the generic capability
    // path (the only reader of grantedScopes) is never reached from chat.
    grantedScopes: [],
    memberRole: deps.memberRole,
    organizationId: deps.organizationId,
    recordAuditEvent: deps.recordAuditEvent ?? NO_OP_AUDIT_RECORDER,
    safeDb: deps.safeDb,
    scopedDb: deps.scopedDb,
    userId: deps.userId,
  };
};
