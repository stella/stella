/**
 * AI assist for clause authoring: revise a clause body's prose in place,
 * guided by the clause's usage notes and a free-text instruction from the
 * user. Stateless — the body is supplied in the request, so it works for an
 * unsaved (new) clause as well as an existing one; nothing is persisted, the
 * caller applies the returned body in the editor and saves through the normal
 * update path.
 *
 * The model never emits structure: it returns revised text per editable
 * (non-directive) paragraph keyed by index, and we swap only that text. Lists,
 * headings, paragraph order, and every `{{ }}` directive stay exactly as
 * authored. Reuses the `streamText` + `Output.object` structured-output pattern
 * (see suggest-template-fields).
 */

import { Output, streamText } from "ai";
import { Result } from "better-result";
import { t } from "elysia";
import * as v from "valibot";

import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { getModelForRole } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { clauseBodySchema } from "./shared-schemas";
import type { ClauseBody } from "./types";

const REWRITE_TIMEOUT_MS = 45_000;

const rewriteClauseBodySchema = t.Object({
  body: clauseBodySchema,
  instruction: t.String({ minLength: 1, maxLength: 2000 }),
  usageNotes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  title: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
});

// strictObject + required (not optional): OpenAI strict structured output
// rejects objects without `additionalProperties: false` / missing-from-required
// properties. The model returns revised text per editable paragraph index.
const rewriteOutputSchema = v.strictObject({
  paragraphs: v.array(
    v.strictObject({
      index: v.number(),
      text: v.string(),
    }),
  ),
});

const SYSTEM_PROMPT =
  "You revise the prose of a legal clause in place. You preserve its meaning, " +
  "structure, and every {{ }} template marker verbatim, changing only the " +
  "wording as instructed. You never invent facts or add placeholders.";

type BuildPromptArgs = {
  numbered: string;
  instruction: string;
  usageNotes?: string | null | undefined;
  title?: string | null | undefined;
};

const buildPrompt = ({
  numbered,
  instruction,
  usageNotes,
  title,
}: BuildPromptArgs): string => {
  const context: string[] = [];
  if (title) {
    context.push(`Clause title: ${title}`);
  }
  if (usageNotes) {
    context.push(
      `Usage notes (when and how this clause is used): ${usageNotes}`,
    );
  }
  const prefix = context.length > 0 ? `${context.join("\n")}\n\n` : "";
  return `${prefix}Revise the clause below according to this instruction:
${instruction}

Return revised text ONLY for the numbered paragraphs you actually change, each as { index, text } reusing the SAME index. Omit paragraphs you leave unchanged. Keep every {{ ... }} marker verbatim, and do not add or remove paragraphs.

Paragraphs:
${numbered}`;
};

const config = {
  permissions: { clause: ["update"] },
  body: rewriteClauseBodySchema,
} satisfies HandlerConfig;

const rewriteClause = createSafeRootHandler(
  config,
  async function* ({ session, body }) {
    const organizationId = session.activeOrganizationId;

    // Editable paragraphs = non-directive with non-empty text; directives and
    // blank spacers are never sent and never changed.
    const editable = body.body.flatMap((paragraph, index) =>
      paragraph.isDirective === true || paragraph.text.trim() === ""
        ? []
        : [{ index, text: paragraph.text }],
    );

    if (editable.length === 0) {
      return Result.ok({ body: body.body });
    }

    const orgAIConfig = await loadOrgAIConfig(organizationId);
    const numbered = editable.map((p) => `[${p.index}] ${p.text}`).join("\n");

    const output = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const result = streamText({
            abortSignal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
            messages: [
              {
                role: "user",
                content: buildPrompt({
                  numbered,
                  instruction: body.instruction,
                  usageNotes: body.usageNotes,
                  title: body.title,
                }),
              },
            ],
            model: getModelForRole("fast", orgAIConfig, {
              promptCachingEnabled: false,
              scopeKey: organizationId,
              organizationId,
              serviceTier: "standard",
            }),
            output: Output.object({
              schema: strictOutputSchema(rewriteOutputSchema),
            }),
            system: SYSTEM_PROMPT,
          });
          return await result.output;
        },
        catch: (cause) =>
          new HandlerError({
            status: 502,
            message: "AI rewrite failed",
            cause,
          }),
      }),
    );

    const revisions = new Map(
      output.paragraphs.map((p) => [p.index, p.text.trim()]),
    );

    // Swap only the prose of returned, editable paragraphs. Changed paragraphs
    // collapse to a single run (inline bold/italic is lost on those — an
    // accepted trade-off; structure, lists, and directives are untouched).
    const revisedBody: ClauseBody = body.body.map((paragraph, index) => {
      const text = revisions.get(index);
      if (text === undefined || text === "" || paragraph.isDirective === true) {
        return paragraph;
      }
      return { ...paragraph, text, runs: [{ text }] };
    });

    return Result.ok({ body: revisedBody });
  },
);

export default rewriteClause;
