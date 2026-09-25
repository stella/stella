/**
 * One structured model call for a verification pass.
 *
 * A call carries only the text it needs, never the whole document: a long
 * document is read a window at a time, so no call grows with the document.
 * What every call of a pass shares (the facts, for grading) goes first and
 * carries the cache breakpoint, so later calls and the repair round read it
 * from the prompt cache.
 */

import type { ModelMessage, TextPart } from "@tanstack/ai";
import type { AnthropicTextMetadata } from "@tanstack/ai-anthropic";
import type * as v from "valibot";

import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  createTanStackAIAnalyticsCallbacks,
  type AIUsageMetering,
} from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import { markTanStackCacheBreakpoint } from "@/api/lib/tanstack-ai-caching";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

/** The role both passes dispatch on, and the one a run records. */
export const VERIFICATION_MODEL_ROLE = "pdf" as const;
const CALL_TIMEOUT_MS = 120_000;

export type VerificationModelDeps = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering: AIUsageMetering;
  abortSignal: AbortSignal;
  /** External model-dispatch boundary; supplied by focused tests. */
  generateObjectForRole?: typeof generateTanStackObjectForRole | undefined;
};

/** Blocks as `[id] text` lines: the ids are what the model cites. */
export const blocksText = (blocks: readonly VerificationBlock[]): string =>
  blocks.map((block) => `[${block.id}] ${block.text}`).join("\n");

type VerificationCallArgs<TSchema extends v.GenericSchema> = {
  deps: VerificationModelDeps;
  feature: string;
  system: string;
  /** Text every call of the pass repeats; cached after the first call. */
  shared: string | null;
  outputSchema: TSchema;
};

export type VerificationCall<TSchema extends v.GenericSchema> = {
  /** The first request of a call: the shared text, then `task`. */
  request: (task: string) => ModelMessage;
  generate: (messages: ModelMessage[]) => Promise<v.InferOutput<TSchema>>;
  captureError: (cause: unknown) => void;
};

export const createVerificationCall = <TSchema extends v.GenericSchema>({
  deps,
  feature,
  system,
  shared,
  outputSchema,
}: VerificationCallArgs<TSchema>): VerificationCall<TSchema> => {
  const caching = resolveCaching({
    promptCachingEnabled: deps.promptCachingEnabled,
    role: VERIFICATION_MODEL_ROLE,
    scopeKey: `list-verification:${deps.entityVersionId}`,
  });
  const analytics = createTanStackAIAnalyticsCallbacks({
    feature,
    modelRole: VERIFICATION_MODEL_ROLE,
    orgAIConfig: deps.orgAIConfig,
    properties: {
      organization_id: deps.organizationId,
      workspace_id: deps.workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering: deps.usageMetering,
  });
  const sharedParts: TextPart<AnthropicTextMetadata>[] =
    shared === null
      ? []
      : [
          markTanStackCacheBreakpoint(
            { type: "text", content: shared },
            { decision: caching },
          ),
        ];
  const generate = deps.generateObjectForRole ?? generateTanStackObjectForRole;

  return {
    request: (task) => ({
      role: "user",
      content: [...sharedParts, { type: "text", content: task }],
    }),
    generate: async (messages) =>
      await generate({
        role: VERIFICATION_MODEL_ROLE,
        orgAIConfig: deps.orgAIConfig,
        organizationId: deps.organizationId,
        analytics,
        caching,
        serviceTier: deps.serviceTier,
        tenantWorkspaceIds: [deps.workspaceId],
        system,
        messages,
        abortSignal: AbortSignal.any([
          deps.abortSignal,
          AbortSignal.timeout(CALL_TIMEOUT_MS),
        ]),
        outputSchema,
      }),
    captureError: (cause) => {
      analytics.captureError(cause);
    },
  };
};
