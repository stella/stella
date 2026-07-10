import type { SafeDb, ScopedDb } from "@/api/db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { loadOrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import type { MemberRole } from "@/api/lib/member-roles";
import type { McpRequestContext } from "@/api/mcp/context";
import { bindWorkspaceRecorder } from "@/api/mcp/tool-utils";

/**
 * The subset of an Elysia safe-handler context the generic capability path
 * reconstructs from an `McpRequestContext` plus the gateway `Request`. It is a
 * structural superset of both `RootHandlerContext` and (with `workspaceId`)
 * `WorkspaceHandlerContext` for every field a safe handler or the safe-handler
 * wrapper actually reads: `body`/`params`/`query` (validated input), the
 * request/route used only for logging, the DB accessors, org/user identity, the
 * member role in `{ role }` shape, the org AI config, and the audit recorders.
 *
 * It deliberately does not model the full Elysia `Context` (response `set`,
 * cookies, redirect, parsed `headers`): a handler that reaches for those is
 * refused at invoke via the context-fidelity waiver table, so the generic path
 * never runs one that would read a field this shape omits. `set` is present as a
 * minimal, inert object so a stray read does not throw.
 */
export type SynthesizedCapabilityContext = {
  body: unknown;
  params: unknown;
  query: unknown;
  request: Request;
  route: string;
  set: { headers: Record<string, string> };
  user: { id: SafeId<"user"> };
  session: { activeOrganizationId: SafeId<"organization"> };
  scopedDb: ScopedDb;
  safeDb: SafeDb;
  activeWorkspaceIds: SafeId<"workspace">[];
  accessibleWorkspaces: AccessibleWorkspace[];
  memberRole: { role: MemberRole };
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  recordAuditEvent: AuditRecorder;
  createAuditRecorder: (opts?: {
    workspaceId?: SafeId<"workspace"> | null;
  }) => AuditRecorder;
  workspaceId?: SafeId<"workspace">;
};

/** Synthetic `route` string used only for log/telemetry attribution. */
export const capabilityRoute = (capabilityId: string): string =>
  `mcp:invoke_capability/${capabilityId}`;

/**
 * Build the safe-handler context an enumerated capability's `{ config, handler }`
 * export expects. Mirrors what the REST `validateAuth` resolve assembles per
 * request, sourced from the already-resolved MCP session context: identity and
 * DB accessors are threaded verbatim, the member role is reshaped to `{ role }`,
 * the org AI config is loaded lazily (one indexed `organization_settings` read,
 * paid only on an actual invoke), and the audit recorder is bound to the
 * resolved workspace exactly as `workspaceAccessMacro` does. `workspaceId` is
 * set only for workspace-kind capabilities (root/session skip it).
 */
export const synthesizeCapabilityContext = async ({
  capabilityId,
  context,
  input,
  request,
  workspaceId,
}: {
  capabilityId: string;
  context: McpRequestContext;
  input: { body: unknown; params: unknown; query: unknown };
  request: Request;
  workspaceId: SafeId<"workspace"> | undefined;
}): Promise<SynthesizedCapabilityContext> => {
  const { orgAIConfig, promptCachingEnabled } = await loadOrgSettingsForAuth(
    context.organizationId,
  );

  const recordAuditEvent =
    workspaceId === undefined
      ? context.recordAuditEvent
      : bindWorkspaceRecorder(context, workspaceId);

  return {
    body: input.body,
    params: input.params,
    query: input.query,
    request,
    route: capabilityRoute(capabilityId),
    set: { headers: {} },
    user: { id: context.userId },
    session: { activeOrganizationId: context.organizationId },
    scopedDb: context.scopedDb,
    safeDb: context.safeDb,
    activeWorkspaceIds: context.accessibleWorkspaceIds,
    accessibleWorkspaces: context.accessibleWorkspaces,
    memberRole: { role: context.memberRole },
    orgAIConfig,
    promptCachingEnabled,
    recordAuditEvent,
    createAuditRecorder: (opts) =>
      createAuditRecorder({
        organizationId: context.organizationId,
        userId: context.userId,
        request,
        server: null,
        workspaceId:
          opts && "workspaceId" in opts
            ? (opts.workspaceId ?? null)
            : (workspaceId ?? null),
      }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
};
