import { Result } from "better-result";
import { t } from "elysia";

import { suggestTemplateFields } from "@/api/handlers/templates/suggest-template-fields";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
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
  // Authoring assistance (which literals should become {{fields}}) that spends
  // org AI, so it takes the same `template: ["create"]` grant as its chat twin
  // `suggest_template_fields`; a fill-only or read-only role must not reach it.
  permissions: { template: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: suggestFieldsBodySchema,
  requiresUsage: { actionType: "chat", modelRole: "fast" },
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
  async function* ({ session, body, safeDb, orgAIConfig, user }) {
    const organizationId = session.activeOrganizationId;
    const { text, instructions } = body;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return Result.ok({ suggestions: [] });
    }

    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: null,
      },
      feature: "templates.suggestFields",
      modelRole: "fast",
      orgAIConfig,
      properties: { organization_id: organizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const suggestions = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await suggestTemplateFields({
            documentText: trimmed,
            instructions,
            orgAIConfig,
            organizationId,
            aiAnalytics,
          }),
        catch: (cause) => {
          aiAnalytics.captureError(cause);
          return new HandlerError({
            status: 500,
            message: "Failed to suggest template fields",
            cause,
          });
        },
      }),
    );

    return Result.ok({ suggestions });
  },
);

export default suggestFields;
