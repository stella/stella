import { Result } from "better-result";

import { desktopDictationModelsSchema } from "@stll/api-contract/desktop-dictation-transcription";

import { listDictationModels } from "@/api/handlers/dictation/desktop-transcription";
import { mayUseRetainingModels } from "@/api/handlers/dictation/transcribe";
import { readTranscriptionDeployment } from "@/api/handlers/dictation/transcription-deployment";
import { orgAIConfigStatusError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  // The model picker of a member's dictation; agents do not dictate.
  mcp: { type: "internal", reason: "native_tool_ui" },
  response: safeHandlerResponseSchemas(desktopDictationModelsSchema),
} as const satisfies HandlerConfig;

/**
 * The transcription models a signed-in member may choose, labelled the way
 * the linked desktop's labelled list is: the region's models first, then
 * those outside it marked `outsideRegion`, and a model whose provider keeps
 * the audio marked `retainsData`, listed only to a member granted such
 * models. A client that shows this list sends the transcription's labels
 * flag, and only then may it name the models marked here.
 */
export const createDictationModelsEndpoint = ({
  readDeployment = readTranscriptionDeployment,
}: { readDeployment?: typeof readTranscriptionDeployment } = {}) =>
  createSafeRootHandler(config, async function* (ctx) {
    const configurationError = orgAIConfigStatusError(ctx.orgAIConfigStatus);
    if (configurationError !== null) {
      return yield* Result.err(configurationError);
    }
    return Result.ok(
      listDictationModels(ctx, {
        deployment: readDeployment(),
        labeled: true,
        retention: true,
        retainingModels: mayUseRetainingModels(ctx),
      }),
    );
  });

export default createDictationModelsEndpoint();
