import type { SafeId } from "@/api/lib/branded-types";
import type { ModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import {
  type ModelDispatchAdmission,
  type ModelDispatchScope,
  NO_ORGANIZATION_MODEL_DISPATCH,
} from "@/api/lib/rate-limit/model-dispatch-admission";
import type { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";
import type { getTanStackTextModelInfoForTask } from "@/api/lib/tanstack-ai-models";

declare const org: SafeId<"organization">;
declare const proof: ModelDispatchAdmission;
const NONE = NO_ORGANIZATION_MODEL_DISPATCH;
const forged = {
  userId: null,
  type: "organization",
  organizationId: org,
  actionKind: "chat.send",
} as const;

({
  userId: null,
  organizationId: org,
  admission: proof,
}) satisfies ModelDispatchScope;
({
  userId: null,
  organizationId: null,
  admission: NONE,
}) satisfies ModelDispatchScope;

// @ts-expect-error an organization's dispatch needs its admission proof
({ userId: null, organizationId: org }) satisfies ModelDispatchScope;
const noTenantAdmission = {
  userId: null,
  organizationId: org,
  admission: NONE,
};
// @ts-expect-error tenant work cannot pass as work with no organization
noTenantAdmission satisfies ModelDispatchScope;
const tenantAdmissionWithoutOrganization = {
  userId: null,
  organizationId: null,
  admission: proof,
};
// @ts-expect-error work with no organization carries no tenant's proof
tenantAdmissionWithoutOrganization satisfies ModelDispatchScope;
const unmintedAdmission = {
  userId: null,
  organizationId: org,
  admission: forged,
};
// @ts-expect-error a proof is minted by admission, never written out
unmintedAdmission satisfies ModelDispatchScope;

type ResolveOptions = Parameters<typeof resolveTanStackTextModel>[0];
const request = {
  dataClass: "customer",
  managedAIResidency: "eu",
  orgAIConfig: null,
  task: "short-text",
} as const;

({
  ...request,
  userId: null,
  organizationId: org,
  admission: proof,
}) satisfies ResolveOptions;
// @ts-expect-error resolving a model requires the dispatch's admission
({ ...request, userId: null, organizationId: org }) satisfies ResolveOptions;

declare const admitModelAction: ModelActionAdmitter;
void admitModelAction(async ({ admission }) => {
  ({
    userId: null,
    organizationId: org,
    admission,
  }) satisfies ModelDispatchScope;
  return await Promise.resolve(admission.actionKind);
});

// The managed model tier rides on the proof: admission reads it when minting,
// and the dispatching code never chooses it.
const forgedTier = { ...forged, modelTier: "fast" } as const;
const unmintedTierAdmission = {
  userId: null,
  organizationId: org,
  admission: forgedTier,
};
// @ts-expect-error a proof with a chosen tier is still not minted by admission
unmintedTierAdmission satisfies ModelDispatchScope;

// Every resolution of a task's model states the tier it resolves at.
type InfoOptions = Parameters<typeof getTanStackTextModelInfoForTask>[2];
({
  dataClass: "customer",
  organizationId: org,
  modelTier: proof.modelTier,
}) satisfies InfoOptions;
// @ts-expect-error a task's managed model cannot be resolved without a tier
({ dataClass: "customer", organizationId: org }) satisfies InfoOptions;

// @ts-expect-error organization dispatch states its user identity
({ organizationId: org, admission: proof }) satisfies ModelDispatchScope;
// @ts-expect-error dispatch with no organization still states its user identity
({ organizationId: null, admission: NONE }) satisfies ModelDispatchScope;
