import type { SafeId } from "@/api/lib/branded-types";
import type { ModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import {
  NO_ORGANIZATION_MODEL_DISPATCH,
  type ModelDispatchAdmission,
  type ModelDispatchScope,
} from "@/api/lib/rate-limit/model-dispatch-admission";
import type { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";

declare const org: SafeId<"organization">;
declare const proof: ModelDispatchAdmission;
const NONE = NO_ORGANIZATION_MODEL_DISPATCH;
const forged = {
  type: "organization",
  organizationId: org,
  actionKind: "chat.send",
} as const;

({ organizationId: org, admission: proof }) satisfies ModelDispatchScope;
({ organizationId: null, admission: NONE }) satisfies ModelDispatchScope;

// @ts-expect-error an organization's dispatch needs its admission proof
({ organizationId: org }) satisfies ModelDispatchScope;
// @ts-expect-error tenant work cannot pass as work with no organization
({ organizationId: org, admission: NONE }) satisfies ModelDispatchScope;
// @ts-expect-error work with no organization carries no tenant's proof
({ organizationId: null, admission: proof }) satisfies ModelDispatchScope;
// @ts-expect-error a proof is minted by admission, never written out
({ organizationId: org, admission: forged }) satisfies ModelDispatchScope;

type ResolveOptions = Parameters<typeof resolveTanStackTextModel>[0];
const request = {
  dataClass: "customer",
  managedAIResidency: "eu",
  orgAIConfig: null,
  role: "fast",
} as const;

({
  ...request,
  organizationId: org,
  admission: proof,
}) satisfies ResolveOptions;
// @ts-expect-error resolving a model requires the dispatch's admission
({ ...request, organizationId: org }) satisfies ResolveOptions;

declare const admitModelAction: ModelActionAdmitter;
void admitModelAction(async ({ admission }) => {
  ({ organizationId: org, admission }) satisfies ModelDispatchScope;
  return await Promise.resolve(admission.actionKind);
});
