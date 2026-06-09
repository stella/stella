import { Output, streamText } from "ai";
import { Result } from "better-result";
import { t } from "elysia";
import * as v from "valibot";

import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { getModelForRole } from "@/api/lib/ai-models";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { strictOutputSchema } from "@/api/lib/strict-output-schema";

const SUGGEST_EDITS_TIMEOUT_MS = 60_000;

const suggestEditsBodySchema = t.Object({
  // The text the editor chose to send: the whole document or the selection.
  text: t.String({ maxLength: 200_000 }),
  instruction: t.String({ maxLength: 2000 }),
});

const editsSchema = v.strictObject({
  edits: v.array(
    v.strictObject({
      originalText: v.string(),
      replacementText: v.string(),
      note: v.nullable(v.string()),
    }),
  ),
});

const SYSTEM_PROMPT =
  "You edit legal documents. You propose precise text replacements that carry " +
  "out the user's instruction. originalText must be copied VERBATIM from the " +
  "document — never paraphrase it — and must be long enough to be unambiguous. " +
  "In multilingual documents, propose a separate edit per language version. " +
  "Keep {{...}} template markers intact unless the instruction targets them.";

const buildPrompt = (documentText: string, instruction: string): string =>
  `Instruction: ${instruction}

For each place the instruction applies, return:
- originalText: the EXACT text to replace, copied verbatim from the document
- replacementText: the new text
- note: a one-line explanation when helpful, else null

Document:
${documentText}`;

/**
 * In-editor AI edits for the Template Studio: given a slice of template text
 * and a free-form instruction, ask the model for precise text replacements.
 * Returns raw {originalText, replacementText} pairs for the editor to render
 * as in-place accept/reject suggestions; nothing is applied server-side.
 */
const config = {
  permissions: { workspace: ["read"] },
  body: suggestEditsBodySchema,
} satisfies HandlerConfig;

const suggestEdits = createSafeRootHandler(
  config,
  async function* ({ session, body }) {
    const { text, instruction } = body;
    const trimmed = text.trim();
    if (trimmed.length === 0 || instruction.trim().length === 0) {
      return Result.ok({ edits: [] });
    }

    const edits = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const orgAIConfig = await loadOrgAIConfig(
            session.activeOrganizationId,
          );
          const result = streamText({
            abortSignal: AbortSignal.timeout(SUGGEST_EDITS_TIMEOUT_MS),
            messages: [
              { role: "user", content: buildPrompt(trimmed, instruction) },
            ],
            model: getModelForRole("fast", orgAIConfig, {
              promptCachingEnabled: false,
              scopeKey: session.activeOrganizationId,
              organizationId: session.activeOrganizationId,
              serviceTier: "standard",
            }),
            output: Output.object({ schema: strictOutputSchema(editsSchema) }),
            system: SYSTEM_PROMPT,
          });
          const { edits: raw } = await result.output;
          return raw.map((edit) => ({
            originalText: edit.originalText,
            replacementText: edit.replacementText,
            note: edit.note ?? undefined,
          }));
        },
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to suggest edits",
            cause,
          }),
      }),
    );

    return Result.ok({ edits });
  },
);

export default suggestEdits;
