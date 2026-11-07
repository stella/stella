import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";

import { AI_ERROR_KINDS } from "@stll/api-contract";
import { isActionAdmissionCode } from "@stll/api-contract/action-admission";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import type { HandlerExceptionScope } from "@stll/errors";

import { getAnalytics } from "@/lib/analytics/provider";
import { APIError } from "@/lib/errors/api";
import { parseProviderDiagnostic } from "@/lib/errors/provider-diagnostic";

type ObserveChatProviderDiagnosticOptions = {
  scope: HandlerExceptionScope;
  onDiagnostic: (diagnostic: ProviderDiagnostic) => void;
};

const CLASSIFIED_RUN_ERROR_KINDS: ReadonlySet<string> = new Set(
  AI_ERROR_KINDS.filter((kind) => kind !== "unknown"),
);

/**
 * Whether a run error carries a failure the server already named: a provider
 * state or a refusal, which the page shows. `unknown` names nothing, and a
 * failed response keeps its own status and code, so both stay reportable.
 */
export const isClassifiedRunError = (error: Error): boolean => {
  if (APIError.is(error) || !("code" in error)) {
    return false;
  }
  const { code } = error;
  return (
    isActionAdmissionCode(code) ||
    (typeof code === "string" && CLASSIFIED_RUN_ERROR_KINDS.has(code))
  );
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
