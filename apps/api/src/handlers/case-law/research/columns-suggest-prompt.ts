import { Result } from "better-result";

import { TEXT_FIELD_TYPE } from "@stll/api-contract/case-law-text-field";

import { suggestResearchColumnPromptBodySchema } from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionSummaries } from "@/api/lib/case-law/decision-summaries";
import { suggestColumnPrompt } from "@/api/lib/properties/column-prompt-suggestion";
import type { SuggestPromptDecisionSample } from "@/api/lib/properties/column-prompt-suggestion";

const config = {
  description:
    "Draft or refine a question column's wording with the model, from the " +
    "answer kind, a free-text instruction, the question as it stands, and " +
    "the search the column is being added to. The named decisions are read " +
    "through the public gate and only their published headnotes ground the " +
    "wording. Returns one single-line question of at most 280 characters " +
    "and stores nothing. Consumes AI usage.",
  // The grant the column itself carries: one capability, one AI spend, and a
  // reader who may not author a column has no draft to write.
  permissions: { caseLawResearch: ["create"] },
  mcp: { type: "internal", reason: "search_ui" },
  body: suggestResearchColumnPromptBodySchema,
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

const suggestResearchColumnPrompt = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
  }) {
    // The grounding is read here, never sent: the client names decisions and
    // the server quotes them only if this read returns them. A decision the
    // gate withholds — unknown id, or a source whose terms forbid
    // redistribution — is simply absent from the sample.
    const readable = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readPublicDecisionSummaries({
            caseLawDb: caseLawPublicReadDb,
            decisionIds: [...new Set(body.decisionIds)],
          }),
      ),
    );
    const samples: SuggestPromptDecisionSample[] = readable.map((decision) => ({
      caseNumber: decision.caseNumber,
      court: decision.court,
      decisionDate: decision.decisionDate,
      headnote:
        decision.headnote.type === TEXT_FIELD_TYPE.PRESENT
          ? decision.headnote.text
          : null,
    }));

    return await suggestColumnPrompt({
      draft: {
        // A question column has no heading beside its question, so the
        // wording is the name the suggestion refines; there is no second
        // draft field to carry.
        name: body.question,
        contentType: body.answerKind,
        options: body.options?.map((option) => option.value),
        currentPrompt: undefined,
        instruction: body.instruction,
      },
      context: {
        kind: "case-law",
        country: body.country,
        query: body.query,
        filters: {
          court: body.filters.court,
          decisionType: body.filters.decisionType,
          dateFrom: body.filters.dateFrom,
          dateTo: body.filters.dateTo,
          language: body.filters.language,
        },
        samples,
      },
      organizationId: session.activeOrganizationId,
      userId: user.id,
      orgAIConfig,
      promptCachingEnabled,
      safeDb,
      abortSignal: request.signal,
    });
  },
);

export default suggestResearchColumnPrompt;
