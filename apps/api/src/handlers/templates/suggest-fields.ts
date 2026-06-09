import { Result } from "better-result";
import { t } from "elysia";

import { suggestTemplateFields } from "@/api/handlers/templates/suggest-template-fields";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const suggestFieldsBodySchema = t.Object({
  // The text the editor chose to send: the whole document or just the current
  // selection. Bounded so a pathological document can't blow up the prompt.
  text: t.String({ maxLength: 200_000 }),
  instructions: t.Optional(t.String({ maxLength: 2000 })),
});

const config = {
  permissions: { workspace: ["read"] },
  body: suggestFieldsBodySchema,
} satisfies HandlerConfig;

/**
 * In-editor AI field suggestions: given a slice of template text (the whole
 * document or the current selection) plus optional extra instructions, ask the
 * model which values should become fillable fields. Returns the raw suggestions
 * — literal text + proposed field path + input type — for the editor to render
 * as accept/reject proposals. Unlike `/prepare`, it never rewrites the document;
 * wrapping the chosen span as `{{field}}` happens client-side on accept.
 */
const suggestFields = createSafeRootHandler(
  config,
  async function* ({ session, body }) {
    const { text, instructions } = body;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return Result.ok({ suggestions: [] });
    }

    const suggestions = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const orgAIConfig = await loadOrgAIConfig(
            session.activeOrganizationId,
          );
          return await suggestTemplateFields({
            documentText: trimmed,
            instructions,
            orgAIConfig,
            organizationId: session.activeOrganizationId,
          });
        },
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to suggest template fields",
            cause,
          }),
      }),
    );

    return Result.ok({ suggestions });
  },
);

export default suggestFields;
