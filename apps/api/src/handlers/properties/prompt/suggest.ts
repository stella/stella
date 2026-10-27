import { Result } from "better-result";
import * as v from "valibot";

import type { CaseLawResearchAnswerType } from "@stll/api-contract";

import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { defaultVarcharSchema } from "@/api/lib/custom-schema";
import { suggestColumnPrompt } from "@/api/lib/properties/column-prompt-suggestion";

const suggestableContentType = v.picklist([
  "text",
  "single-select",
  "multi-select",
  "date",
  "int",
]);

// Both directions of the mirror: the suggestion capability is written for one
// set of value kinds, and a kind added to either side fails here.
type MirroredContentType = v.InferOutput<typeof suggestableContentType>;
true satisfies MirroredContentType extends CaseLawResearchAnswerType
  ? CaseLawResearchAnswerType extends MirroredContentType
    ? true
    : never
  : never;

const suggestPromptBodySchema = v.object({
  name: defaultVarcharSchema,
  contentType: suggestableContentType,
  options: v.optional(
    v.array(
      v.object({
        value: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
      }),
    ),
  ),
  currentPrompt: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  instruction: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
});

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "properties.suggest-prompt" },
  description:
    "Draft or refine a column's extraction prompt with the model, from the " +
    "column name, value type, select options, a free-text instruction, and " +
    "optionally the prompt as it stands. Returns one single-line prompt of " +
    "at most 280 characters and stores nothing. Consumes AI usage.",
  permissions: { property: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: true,
  },
  body: suggestPromptBodySchema,
  requiresUsage: { actionType: "chat", modelTask: "short-text" },
} satisfies WorkspaceHandlerConfig;

const suggestPrompt = createSafeHandler(
  config,
  // oxlint-disable-next-line require-yield -- createSafeHandler mandates AsyncGenerator; no DB ops to Result.await
  async function* ({
    orgAIConfigStatus,
    modelAdmission,
    body,
    orgAIConfig,
    managedAIResidency,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError(undefined));
    }

    return await suggestColumnPrompt({
      admission: configuredModelAdmission({ modelAdmission }),
      draft: {
        name: body.name,
        contentType: body.contentType,
        options: body.options?.map((option) => option.value),
        currentPrompt: body.currentPrompt,
        instruction: body.instruction,
      },
      context: { kind: "workspace", workspaceId },
      organizationId: session.activeOrganizationId,
      userId: user.id,
      orgAIConfig,
      managedAIResidency,
      promptCachingEnabled,
      safeDb,
      abortSignal: request.signal,
    });
  },
);

export default suggestPrompt;
