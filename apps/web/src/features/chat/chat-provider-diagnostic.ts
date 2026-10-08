import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";

import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";

import { parseProviderDiagnostic } from "@/lib/errors/provider-diagnostic";

/**
 * The SDK reduces RUN_ERROR to Error(message); retain Stella's validated envelope before yielding.
 * @yields Every original stream event, unchanged.
 */
export const observeChatProviderDiagnostic = async function* (
  source: AsyncIterable<StreamChunk>,
  onDiagnostic: (diagnostic: ProviderDiagnostic) => void,
): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    if (chunk.type === EventType.RUN_ERROR) {
      const diagnostic: unknown = chunk.metadata?.["providerDiagnostic"];
      if (diagnostic !== undefined) {
        onDiagnostic(parseProviderDiagnostic(diagnostic));
      }
    }
    yield chunk;
  }
};
