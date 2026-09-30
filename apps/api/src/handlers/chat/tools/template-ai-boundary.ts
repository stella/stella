import { panic, Result } from "better-result";

import {
  prepareTextForThirdParty,
  prepareUnknownForThirdParty,
  restoreTextFromBoundary,
} from "@/api/handlers/chat/third-party-boundary";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { captureError } from "@/api/lib/analytics/capture";
import { AI_FIELD_GENERATION_FAILURE_MESSAGE } from "@/api/lib/docx/resolve-ai-fields";
import type { AiFillCollaborators } from "@/api/lib/templates/template-fill-service";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const PREPARE_FAILED = { feature: "templates.fill.prepare" } as const;

const prepareOptionalText = async (
  boundary: ChatThirdPartyBoundary,
  text: string | undefined,
) =>
  text === undefined
    ? Result.ok(undefined)
    : await prepareTextForThirdParty({ boundary, text });

const prepareValues = async (
  boundary: ChatThirdPartyBoundary,
  values: Record<string, unknown>,
) => {
  const prepared = await prepareUnknownForThirdParty({
    boundary,
    value: values,
  });
  return Result.isError(prepared)
    ? Result.err(prepared.error)
    : Result.ok(
        isRecord(prepared.value)
          ? prepared.value
          : panic("Prepared template values are not an object"),
      );
};

type TemplateAiCollaboratorsForBoundaryOptions = {
  boundary: ChatThirdPartyBoundary;
  collaborators: AiFillCollaborators;
  /** Collects the path of every field whose draft kept a placeholder the
   *  boundary cannot restore. */
  unrestoredFields: Set<string>;
};

/**
 * A chat template fill's AI collaborators behind the turn's boundary. The
 * tool receives the turn's real values; each nested request is prepared like
 * the turn itself, and what the model drafts comes back with those values
 * restored before it enters the document. A draft that keeps a placeholder
 * the boundary never sent is reported in `unrestoredFields`.
 */
export const templateAiCollaboratorsForBoundary = ({
  boundary,
  collaborators: { adaptAiValue, decideAiCondition, generateAiValue },
  unrestoredFields,
}: TemplateAiCollaboratorsForBoundaryOptions): AiFillCollaborators => {
  if (boundary.type === "raw") {
    return { adaptAiValue, decideAiCondition, generateAiValue };
  }
  const restore = (fieldPath: string, text: string) => {
    const restored = restoreTextFromBoundary(boundary, text);
    if (!restored.complete) {
      unrestoredFields.add(fieldPath);
    }
    return restored.text;
  };

  return {
    ...(generateAiValue === undefined
      ? {}
      : {
          generateAiValue: async (input) => {
            const prepared = await Result.gen(async function* () {
              const prompt = yield* Result.await(
                prepareTextForThirdParty({ boundary, text: input.prompt }),
              );
              const values = yield* Result.await(
                prepareValues(boundary, input.values),
              );
              const documentText = yield* Result.await(
                prepareOptionalText(boundary, input.documentText),
              );
              return Result.ok({ ...input, documentText, prompt, values });
            });
            if (Result.isError(prepared)) {
              captureError(prepared.error, PREPARE_FAILED);
              return {
                type: "failed",
                reason: "generation-failed",
                message: AI_FIELD_GENERATION_FAILURE_MESSAGE,
              };
            }
            const draft = await generateAiValue(prepared.value);
            return draft.type === "drafted"
              ? {
                  type: "drafted",
                  value: restore(input.fieldPath, draft.value),
                }
              : draft;
          },
        }),
    ...(decideAiCondition === undefined
      ? {}
      : {
          decideAiCondition: async (input) => {
            const prepared = await Result.gen(async function* () {
              const prompt = yield* Result.await(
                prepareTextForThirdParty({ boundary, text: input.prompt }),
              );
              const values = yield* Result.await(
                prepareValues(boundary, input.values),
              );
              return Result.ok({ ...input, prompt, values });
            });
            if (Result.isError(prepared)) {
              captureError(prepared.error, PREPARE_FAILED);
              // An undecided condition excludes its block, as when the model
              // cannot answer.
              return undefined;
            }
            return await decideAiCondition(prepared.value);
          },
        }),
    ...(adaptAiValue === undefined
      ? {}
      : {
          adaptAiValue: async (input) => {
            const prepared = await Result.gen(async function* () {
              const stub = yield* Result.await(
                prepareTextForThirdParty({ boundary, text: input.stub }),
              );
              const label = yield* Result.await(
                prepareOptionalText(boundary, input.label),
              );
              const prompt = yield* Result.await(
                prepareOptionalText(boundary, input.prompt),
              );
              const contexts = yield* Result.await(
                prepareUnknownForThirdParty({
                  boundary,
                  value: input.occurrences.map(({ context }) => context),
                }),
              );
              const occurrences = isUnknownArray(contexts)
                ? contexts.map((context) => ({
                    context:
                      typeof context === "string"
                        ? context
                        : panic("A prepared occurrence is not text"),
                  }))
                : panic("Prepared occurrences are not a list");
              return Result.ok({ ...input, label, occurrences, prompt, stub });
            });
            if (Result.isError(prepared)) {
              captureError(prepared.error, PREPARE_FAILED);
              // An unadapted stub keeps the user's value, as when the model
              // cannot answer.
              return undefined;
            }
            const adapted = await adaptAiValue(prepared.value);
            return adapted?.map((text) => restore(input.fieldPath, text));
          },
        }),
  };
};
