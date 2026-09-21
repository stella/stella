import { t } from "elysia";
import type { Static } from "elysia";

import type { CaseLawResearchAnswerType } from "@stll/api-contract";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { suggestColumnPrompt } from "@/api/lib/properties/column-prompt-suggestion";

const suggestableContentType = t.Union([
  t.Literal("text"),
  t.Literal("single-select"),
  t.Literal("multi-select"),
  t.Literal("date"),
  t.Literal("int"),
]);

// Both directions of the mirror: the suggestion capability is written for one
// set of value kinds, and a kind added to either side fails here.
type MirroredContentType = Static<typeof suggestableContentType>;
true satisfies MirroredContentType extends CaseLawResearchAnswerType
  ? CaseLawResearchAnswerType extends MirroredContentType
    ? true
    : never
  : never;

const suggestPromptBodySchema = t.Object({
  name: tDefaultVarchar,
  contentType: suggestableContentType,
  options: t.Optional(
    t.Array(
      t.Object({
        value: t.String({ minLength: 1, maxLength: 1000 }),
      }),
    ),
  ),
  // Plain-text version of the user's current prompt. When non-empty,
  // the LLM is asked to refine it instead of starting from scratch.
  currentPrompt: t.Optional(t.String({ maxLength: 2000 })),
  instruction: t.String({ minLength: 1, maxLength: 2000 }),
});

const config = {
  description:
    "Draft or refine a column's extraction prompt with the model, from the " +
    "column name, value type, select options, a free-text instruction, and " +
    "optionally the prompt as it stands. Returns one single-line prompt of " +
    "at most 280 characters and stores nothing. Consumes AI usage.",
  permissions: { property: ["create"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: suggestPromptBodySchema,
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies WorkspaceHandlerConfig;

const suggestPrompt = createSafeHandler(
  config,
  // eslint-disable-next-line require-yield -- createSafeHandler mandates AsyncGenerator; no DB ops to Result.await
  async function* ({
    body,
    orgAIConfig,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    return await suggestColumnPrompt({
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
      promptCachingEnabled,
      safeDb,
      abortSignal: request.signal,
    });
  },
);

export default suggestPrompt;
