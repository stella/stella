import { Result } from "better-result";
import { t } from "elysia";

import { resolveCaching } from "@/api/lib/ai-config";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { streamTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";

const MAX_PREFIX_CHARS = 8000;
const MAX_SUFFIX_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 96;
const AUTOCOMPLETE_TIMEOUT_MS = 10_000;

const requestBody = t.Object({
  prefix: t.String({ maxLength: MAX_PREFIX_CHARS }),
  suffix: t.Optional(t.String({ maxLength: MAX_SUFFIX_CHARS })),
  headings: t.Optional(t.Array(t.String({ maxLength: 240 }), { maxItems: 8 })),
  language: t.Optional(t.String({ maxLength: 8 })),
});

const config = {
  permissions: { chat: ["create"] },
  body: requestBody,
} satisfies HandlerConfig;

const SYSTEM_PROMPT = [
  "You complete the user's legal writing inline, one short continuation at a time.",
  "Continue from the cursor in the user's voice and language. Match register and terminology.",
  "Return only the continuation text. No quotes, no labels, no markdown, no preamble.",
  "Stop at the end of the current sentence or clause; never start a new paragraph.",
  "If the prefix already ends a complete thought, return an empty string.",
  "Never invent citations, case names, statute numbers, or authorities.",
].join(" ");

const buildUserPrompt = (input: {
  prefix: string;
  suffix?: string | undefined;
  headings?: readonly string[] | undefined;
  language?: string | undefined;
}): string => {
  const sections: string[] = [];
  if (input.language) {
    sections.push(`Language: ${input.language}`);
  }
  if (input.headings && input.headings.length > 0) {
    sections.push(`Headings: ${input.headings.join(" › ")}`);
  }
  sections.push("--- Text before cursor ---");
  sections.push(input.prefix);
  if (input.suffix && input.suffix.length > 0) {
    sections.push("--- Text after cursor ---");
    sections.push(input.suffix);
  }
  sections.push(
    "--- Continue from the cursor. Output only the continuation. ---",
  );
  return sections.join("\n");
};

const autocompleteStream = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    promptCachingEnabled,
    session,
    request,
  }) {
    const stream = yield* Result.try({
      try: () =>
        streamTanStackTextForRole({
          role: "fast",
          serviceTier: "standard",
          orgAIConfig,
          organizationId: session.activeOrganizationId,
          caching: resolveCaching({
            promptCachingEnabled,
            role: "fast",
            scopeKey: null,
          }),
          abortSignal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(AUTOCOMPLETE_TIMEOUT_MS),
          ]),
          system: SYSTEM_PROMPT,
          prompt: buildUserPrompt({
            prefix: body.prefix,
            suffix: body.suffix,
            headings: body.headings,
            language: body.language,
          }),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
        }),
      catch: (cause) => {
        if (cause instanceof HandlerError) {
          return cause;
        }
        return new HandlerError({
          status: 500,
          message: "Autocomplete is not available on this deployment.",
          cause,
        });
      },
    });

    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const writeEvent = (event: string, data: unknown) => {
          if (request.signal.aborted) {
            return;
          }
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        };
        try {
          for await (const delta of stream) {
            if (delta.length > 0) {
              writeEvent("token", { text: delta });
            }
          }
          writeEvent("done", {});
        } catch (error) {
          if (!request.signal.aborted) {
            writeEvent("error", {
              message:
                error instanceof Error ? error.message : "stream interrupted",
            });
          }
        } finally {
          if (!request.signal.aborted) {
            controller.close();
          }
        }
      },
    });

    return Result.ok(
      new Response(sse, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      }),
    );
  },
);

export default autocompleteStream;
