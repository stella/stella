import { Result } from "better-result";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { workspaces } from "@/api/db/schema";
import type { AgentSkillScope } from "@/api/db/schema";
import type { SkillBinding } from "@/api/lib/agent-skills/binding";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasManagementPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

/**
 * Request fields that bind a new skill to one matter or one client. At most
 * one may be set; the binding is fixed once the skill exists.
 */
export const skillBindingBodyFields = {
  boundWorkspaceId: v.optional(resourceIdSchema("workspace")),
  boundClientId: v.optional(resourceIdSchema("contact")),
};

/** The matters a binding is reached through; `null` for an unbound skill. */
const bindingReachCondition = ({
  boundClientId,
  boundWorkspaceId,
}: SkillBinding) => {
  if (boundWorkspaceId !== null) {
    return eq(workspaces.id, boundWorkspaceId);
  }
  return boundClientId === null ? null : eq(workspaces.clientId, boundClientId);
};

/**
 * Whether the caller may create a skill with `scope` and `binding`, decided
 * before the insert so the refusal is a clear 400/403/404 rather than a row
 * security failure (which still backs it):
 * - one binding at most;
 * - a client binding needs a manager;
 * - a team skill needs a manager, unless it is bound to a matter, which any
 *   member who reaches that matter may do;
 * - the bound matter, or a matter of the bound client, must be one the caller
 *   reaches (read under the caller's own matter access).
 */
export const authorizeSkillBinding = async ({
  binding,
  memberRole,
  safeDb,
  scope,
}: {
  binding: SkillBinding;
  memberRole: AuthorizedMemberRole;
  safeDb: SafeDb;
  scope: AgentSkillScope;
}): Promise<Result<void, HandlerError | SafeDbError>> => {
  const { boundClientId, boundWorkspaceId } = binding;
  if (boundClientId !== null && boundWorkspaceId !== null) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Bind a skill to one matter or one client, not both",
      }),
    );
  }
  const isManager = hasManagementPermission(memberRole, {
    agentSkill: ["create"],
  });
  if (boundClientId !== null && !isManager) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Only admins and owners can bind a skill to a client",
      }),
    );
  }
  if (scope === "team" && !isManager && boundWorkspaceId === null) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Only admins and owners can install team skills",
      }),
    );
  }

  const reachCondition = bindingReachCondition(binding);
  if (reachCondition === null) {
    return Result.ok(undefined);
  }
  const reached = await safeDb((tx) =>
    tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(reachCondition)
      .limit(1),
  );
  if (Result.isError(reached)) {
    return Result.err(reached.error);
  }
  if (reached.value.length === 0) {
    return Result.err(
      new HandlerError({
        status: 404,
        message:
          boundWorkspaceId === null ? "Client not found" : "Matter not found",
      }),
    );
  }
  return Result.ok(undefined);
};
