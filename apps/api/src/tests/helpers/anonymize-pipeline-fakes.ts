import { panic } from "better-result";

import { createPipelineContext } from "@stll/anonymize";
import type { NativeAnonymizeBinding } from "@stll/anonymize";

import type { AnonymizeTextFieldsDependencies } from "@/api/mcp/anonymization-core";
import { RESERVED_TOKEN_PLANE } from "@/api/mcp/field-markers";

type NativePipeline = Awaited<
  ReturnType<AnonymizeTextFieldsDependencies["createNativePipelineFromConfig"]>
>;

/**
 * Pipeline dependencies whose native redaction returns `rewrite(text)` and
 * detects nothing, so a test controls exactly what comes back from the
 * pipeline (for example output that lost part of its structure).
 */
export const createRewritingAnonymizeDependencies = (
  rewrite: (text: string) => string,
): AnonymizeTextFieldsDependencies => {
  // SAFETY: the binding is passed through to the fake pipeline factory
  // below and never read.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double stands in for the native binding
  const binding = {} as NativeAnonymizeBinding;
  const pipeline = {
    redactText: (fullText: string) => ({
      resolvedEntities: [],
      redaction: {
        entityCount: 0,
        operatorMap: new Map(),
        redactionMap: new Map<string, string>(),
        redactedText: rewrite(fullText),
      },
    }),
  };
  return {
    getBinding: async () => await Promise.resolve(binding),
    createNativePipelineFromConfig: async () =>
      await Promise.resolve(
        // SAFETY: the chat pipeline only calls `redactText`.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double only implements `redactText`
        pipeline as unknown as NativePipeline,
      ),
    createPipelineContext,
    deanonymise: (text: string) => text,
    loadAnonymizationGazetteerEntries: async () => await Promise.resolve([]),
    loadAnonymizationAllowlistCanonicals: async () => await Promise.resolve([]),
    loadNameDictionaries: async () => await Promise.resolve({}),
  };
};

const isFieldDelimiterToken = (character: string): boolean => {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint >= RESERVED_TOKEN_PLANE.fieldDelimiter.start &&
    codePoint <= RESERVED_TOKEN_PLANE.fieldDelimiter.end
  );
};

/**
 * Replace the first field delimiter token in `text`, the way a recognizer
 * that matched it would.
 */
export const replaceFirstFieldDelimiterToken = (
  text: string,
  replacement: string,
): string => {
  const characters = Array.from(text);
  const index = characters.findIndex(isFieldDelimiterToken);
  if (index === -1) {
    // A fixture that never reaches a delimiter would prove nothing.
    return panic("The pipeline input carries no field delimiter");
  }
  characters[index] = replacement;
  return characters.join("");
};
