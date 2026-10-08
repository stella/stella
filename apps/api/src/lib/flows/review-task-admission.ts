import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import { flowRunSteps } from "@/api/db/schema";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { isFeatureEnabled } from "@/api/lib/auth/feature-access/policy";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { flowTaskMutationTargetCondition } from "@/api/lib/flows/review-task-target";
import type { FlowTaskMutationTarget } from "@/api/lib/flows/review-task-target";

type AdmitLinkedFlowAccessOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  access: "read" | "write";
};

export const admitLinkedFlowAccess = async (
  tx: ScopedTransaction,
  { organizationId, userId, access }: AdmitLinkedFlowAccessOptions,
): Promise<Result<void, HandlerError>> => {
  if (access === "write") {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId,
      featureId: "flows",
    });
  }
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    return Result.err(new HandlerError({ status: 404, message: "Not found" }));
  }
  const principal = { organizationId, userId };
  const snapshot = await resolveFeatureAccessSnapshot({ tx, ...principal });
  return isFeatureEnabled(snapshot, "flows", principal)
    ? Result.ok(undefined)
    : Result.err(new HandlerError({ status: 404, message: "Not found" }));
};

type AdmitTaskFlowMutationOptions = {
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  target: FlowTaskMutationTarget;
};

/** Resolve the whole target under admission fencing before resource locks or writes. */
export const admitTaskFlowMutation = async (
  tx: ScopedTransaction,
  options: AdmitTaskFlowMutationOptions,
): Promise<Result<void, HandlerError>> =>
  await admitTaskFlowTargetAccess(tx, { ...options, access: "write" });

type AdmitTaskFlowTargetAccessOptions = AdmitTaskFlowMutationOptions & {
  access: "read" | "write";
};

export const admitTaskFlowTargetAccess = async (
  tx: ScopedTransaction,
  { workspaceId, userId, target, access }: AdmitTaskFlowTargetAccessOptions,
): Promise<Result<void, HandlerError>> => {
  if (target.type === "entities" && target.entityIds.length === 0) {
    return Result.ok(undefined);
  }
  const workspace = await tx.query.workspaces.findFirst({
    where: { id: { eq: workspaceId } },
    columns: { organizationId: true },
  });
  if (!workspace) {
    return Result.err(new HandlerError({ status: 404, message: "Not found" }));
  }
  // Fence ownership discovery too: an absent link is not a durable admission decision.
  if (access === "write") {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId: workspace.organizationId,
      featureId: "flows",
    });
  }
  const gates = await tx
    .select({ runId: flowRunSteps.runId })
    .from(flowRunSteps)
    .where(
      and(
        eq(flowRunSteps.workspaceId, workspaceId),
        flowTaskMutationTargetCondition(workspaceId, target),
      ),
    )
    .limit(1);
  if (gates.length === 0) {
    return Result.ok(undefined);
  }
  return await admitLinkedFlowAccess(tx, {
    organizationId: workspace.organizationId,
    userId,
    access,
  });
};
