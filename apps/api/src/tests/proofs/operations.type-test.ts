import type { Named, Proof } from "@gdp-ts/core";
import { Result } from "better-result";

import { runCheckedSubagentBatch } from "@/api/handlers/chat/tools/spawn-subagents-tool";
import { readCheckedAIConfiguration } from "@/api/lib/ai-config-loader";
import {
  ACCOUNT_ACCESS,
  type createSafeRootHandler,
  type HandlerConfig,
  runCheckedScopedHandler,
} from "@/api/lib/api-handlers";
import {
  runCheckedOrganizationFileWrite,
  runCheckedOrganizationFileCopy,
} from "@/api/lib/files/organization-file-usage";
import { startFlowRun } from "@/api/lib/flows/start-flow-run";
import type { OperationAuthorization } from "@/api/lib/proofs/checked-transaction";
import { runCheckedAction } from "@/api/lib/rate-limit/action-admission";
import { fillTemplateDocx } from "@/api/lib/templates/template-fill-service";
import type { AiFillCollaborators } from "@/api/lib/templates/template-fill-service";

const config = {
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

type Context = Parameters<
  Parameters<typeof createSafeRootHandler<typeof config, { ok: boolean }>>[1]
>[0];

const rejectedAtCompileTime = (outcome: unknown) => outcome;

// Compile-only: these functions are never invoked.
export const scopedOperationProofMistakes = async <N, Other>(
  args: Parameters<
    typeof runCheckedScopedHandler<typeof config, Context, { ok: boolean }, N>
  >[0],
  otherInput: Named<Other, typeof args.input.value>,
  otherProof: Proof<"OtherOperation", [N]>,
) => {
  const { proof, ...withoutProof } = args;
  // @ts-expect-error Execution requires checked evidence.
  rejectedAtCompileTime(await runCheckedScopedHandler(withoutProof));
  rejectedAtCompileTime(
    // @ts-expect-error The input must retain its exact name.
    await runCheckedScopedHandler({ ...args, input: args.input.value }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error Evidence for one operation cannot authorize another input.
    await runCheckedScopedHandler({ ...args, input: otherInput }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error Evidence kinds are distinct.
    await runCheckedScopedHandler({ ...args, proof: otherProof }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error A boolean cannot stand in for evidence.
    await runCheckedScopedHandler({ ...args, proof: true }),
  );
  // @ts-expect-error A spread copy of evidence is not evidence.
  const copied: typeof proof = {
    ...proof, // oxlint-disable-line typescript/no-misused-spread -- a spread copy must not type-check as evidence
    input: { ...args.input, value: args.scratch },
  };
  rejectedAtCompileTime(copied);
  // @ts-expect-error An object literal cannot construct evidence.
  const literal: typeof proof = { kind: "HandlerUsageAllowed" };
  return literal;
};

export const actionOperationProofMistakes = async <R, N, A, Other>(
  args: Parameters<typeof runCheckedAction<R, N, A>>[0],
  otherInput: Named<Other, typeof args.input.value>,
  otherAdmission: Named<Other, typeof args.admission.value>,
) => {
  const { proof, ...withoutProof } = args;
  // @ts-expect-error Action execution requires checked evidence.
  rejectedAtCompileTime(await runCheckedAction(withoutProof));
  rejectedAtCompileTime(
    // @ts-expect-error The admitted input must retain its exact name.
    await runCheckedAction({ ...args, input: args.input.value }),
  );
  // @ts-expect-error Evidence must belong to this action's complete input.
  rejectedAtCompileTime(await runCheckedAction({ ...args, input: otherInput }));
  // @ts-expect-error Admission evidence keeps its own scope.
  const copied: typeof proof = { ...proof, admission: args.admission }; // oxlint-disable-line typescript/no-misused-spread -- a spread copy must not type-check as evidence
  rejectedAtCompileTime(copied);
  // @ts-expect-error An object literal cannot construct evidence.
  const literal: typeof proof = { kind: "ActionAdmitted" };
  rejectedAtCompileTime(
    // @ts-expect-error Evidence belongs to the admitted execution scope.
    await runCheckedAction({ ...args, admission: otherAdmission }),
  );
  return literal;
};

export const operationAuthorizationMistakes = <Kind extends string, Input>(
  authorization: OperationAuthorization<Kind, Input>,
) => {
  // @ts-expect-error The public method cannot reproduce the sealed authorization.
  const literal: typeof authorization = {
    execute: authorization.execute.bind(authorization),
  };
  return literal;
};

export const scopedOperationResultInference = async <N>(
  args: Parameters<
    typeof runCheckedScopedHandler<typeof config, Context, { ok: boolean }, N>
  >[0],
) => {
  const result = await runCheckedScopedHandler(args);
  if ("code" in result) {
    return result.code;
  }
  return Result.ok(result.ok satisfies boolean);
};

export const conditionalOperationMistakes = async (
  flow: Parameters<typeof startFlowRun>[0],
  fill: Parameters<typeof fillTemplateDocx>[0],
  buildCollaborators: () => Promise<AiFillCollaborators>,
) => {
  const { admit, ...withoutAdmission } = flow;
  // @ts-expect-error Starting a flow requires an authorization-producing check.
  rejectedAtCompileTime(await startFlowRun(withoutAdmission));
  rejectedAtCompileTime(
    // @ts-expect-error Raw collaborators cannot replace an AI fill admission callback.
    await fillTemplateDocx({ ...fill, aiFill: buildCollaborators }),
  );
  const unchecked = {
    ...fill,
    aiFill: async () => Result.ok(await buildCollaborators()),
  };
  // @ts-expect-error AI fill admission requires an admitted/refused outcome, not a Result.
  rejectedAtCompileTime(await fillTemplateDocx(unchecked));
  return admit;
};

export const configurationEvidenceMistakes = <Settings, N, Other>(
  args: Parameters<typeof readCheckedAIConfiguration<Settings, N>>[0],
  otherInput: Named<Other, typeof args.input.value>,
) => {
  const { proof, ...withoutProof } = args;
  // @ts-expect-error Configuration exposure requires evidence.
  readCheckedAIConfiguration(withoutProof);
  // @ts-expect-error Ordinary values cannot replace the named settings input.
  readCheckedAIConfiguration({ ...args, input: args.input.value });
  // @ts-expect-error Evidence must refer to this actor and settings input.
  readCheckedAIConfiguration({ ...args, input: otherInput });
  // @ts-expect-error A flag is not configuration evidence.
  readCheckedAIConfiguration({ ...args, proof: true });
  return proof;
};

export const subagentEvidenceMistakes = async <N, Other>(
  args: Parameters<typeof runCheckedSubagentBatch<N>>[0],
  otherInput: Named<Other, typeof args.input.value>,
) => {
  const { proof, ...withoutProof } = args;
  // @ts-expect-error Batch dispatch requires evidence.
  rejectedAtCompileTime(await runCheckedSubagentBatch(withoutProof));
  rejectedAtCompileTime(
    // @ts-expect-error Evidence belongs to the complete checked batch.
    await runCheckedSubagentBatch({ ...args, input: otherInput }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error The batch must retain its name.
    await runCheckedSubagentBatch({ ...args, input: args.input.value }),
  );
  return proof;
};

export const fileEvidenceMistakes = async <T, E, N, Other>(
  write: Parameters<typeof runCheckedOrganizationFileWrite<T, N>>[0],
  copy: Parameters<typeof runCheckedOrganizationFileCopy<T, E, N>>[0],
  otherWrite: Named<Other, typeof write.input.value>,
) => {
  const { proof, ...withoutProof } = write;
  // @ts-expect-error Stored object execution requires evidence.
  rejectedAtCompileTime(await runCheckedOrganizationFileWrite(withoutProof));
  rejectedAtCompileTime(
    // @ts-expect-error A different input and reservation cannot reuse evidence.
    await runCheckedOrganizationFileWrite({ ...write, input: otherWrite }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error Copy execution cannot replace checked input with ordinary values.
    await runCheckedOrganizationFileCopy({ ...copy, input: copy.input.value }),
  );
  return proof;
};
