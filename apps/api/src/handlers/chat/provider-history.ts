import * as v from "valibot";

import { answerHistoryCallsInTheirStep } from "@/api/handlers/chat/step-answers";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { guardModelMessages } from "@/api/lib/chat/model-ingress-guard";
import type { GuardedModelMessages } from "@/api/lib/chat/model-ingress-guard";

const providerHistorySchema = v.pipe(
  v.custom<GuardedModelMessages<ChatMessage[]>>(Array.isArray),
  v.brand("GuardedProviderHistory"),
);

/** The history a chat attempt hands the provider. Mintable only by
 *  `guardProviderHistory`, so a history that skipped it fails typecheck at
 *  the dispatch. */
export type GuardedProviderHistory = v.InferOutput<
  typeof providerHistorySchema
>;

/**
 * The provider's copy of `messages`: every call answered right after its
 * step, then run through the model-ingress guard, so the answers it adds pass
 * the guard like everything else the provider reads.
 */
export const guardProviderHistory = ({
  messages,
  workspaceIds,
}: {
  messages: readonly ChatMessage[];
  workspaceIds: readonly SafeId<"workspace">[];
}): GuardedProviderHistory =>
  v.parse(
    providerHistorySchema,
    guardModelMessages({
      messages: answerHistoryCallsInTheirStep(messages),
      workspaceIds,
    }),
  );
