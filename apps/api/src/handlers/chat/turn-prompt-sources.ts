import { Result } from "better-result";

import type { ConnectableMcpConnectorCatalog } from "@stll/api-contract/chat-connector";

import type { SafeDbError } from "@/api/db/safe-db";
import { captureError } from "@/api/lib/analytics/capture";

type PromptSource<TRequirement, TValue> = {
  type: TRequirement;
  load: () => Promise<Result<TValue, SafeDbError>>;
};

type TurnPromptSources = {
  requestedSkills: PromptSource<"required", string>;
  connectorCatalog: PromptSource<
    "optional",
    ConnectableMcpConnectorCatalog | undefined
  >;
};

/** Optional enrichment cannot acquire the authority to fail a turn. */
const loadOptionalPromptSource = async <T>(
  source: PromptSource<"optional", T>,
) => {
  const read = await Result.tryPromise(source.load);
  const result = read.andThen((value) => value);
  if (Result.isError(result)) {
    captureError(result.error, { operation: "optional-turn-prompt-source" });
    return { type: "omitted", error: result.error } as const;
  }
  return { type: "loaded", value: result.value } as const;
};

/** Explicitly requested skills are required; discovery hints are optional. */
export const loadTurnPromptSources = async ({
  requestedSkills,
  connectorCatalog,
}: TurnPromptSources) => {
  const requiredRead = await Result.tryPromise(requestedSkills.load);
  const required = requiredRead.andThen((value) => value);
  if (Result.isError(required)) {
    return required;
  }
  const optional = await loadOptionalPromptSource(connectorCatalog);
  return Result.ok({
    requestedSkillsPrompt: required.value,
    connectableConnectors:
      optional.type === "loaded" ? optional.value : undefined,
  });
};
