import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";

import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import type { HandlerExceptionScope } from "@stll/errors";

import { getAnalytics } from "@/lib/analytics/provider";
import { parseProviderDiagnostic } from "@/lib/errors/provider-diagnostic";

type ObserveChatProviderDiagnosticOptions = {
  scope: HandlerExceptionScope;
  onDiagnostic: (diagnostic: ProviderDiagnostic) => void;
};

/**
 * The SDK reduces RUN_ERROR to Error(message); retain Stella's validated envelope before yielding.
 * @yields Every original stream event, unchanged.
 */
export const observeChatProviderDiagnostic = async function* (
  source: AsyncIterable<StreamChunk>,
  { scope, onDiagnostic }: ObserveChatProviderDiagnosticOptions,
): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    if (chunk.type === EventType.RUN_ERROR) {
      const diagnostic: unknown = chunk.metadata?.["providerDiagnostic"];
      if (diagnostic !== undefined) {
        const parsed = parseProviderDiagnostic(diagnostic);
        if (parsed.isOk()) {
          onDiagnostic(parsed.value);
        } else {
          // The run already failed and says so; only its setup guidance is
          // missing, which a malformed envelope must not invent.
          getAnalytics().captureError(parsed.error, {
            fingerprintKey: "observeChatProviderDiagnostic:failure",
            scope,
          });
        }
      }
    }
    yield chunk;
  }
};
