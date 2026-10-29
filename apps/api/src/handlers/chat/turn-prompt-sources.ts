import { Result } from "better-result";

import type { ConnectableMcpConnectorCatalog } from "@stll/api-contract/chat-connector";

import type { SafeDbError } from "@/api/db/safe-db";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const OPTIONAL_PROMPT_SOURCE_FAILED = failureSink({
  event: "chat.optional_prompt_source_failed",
  expected: [],
});

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
    observeFailure(result.error, { sink: OPTIONAL_PROMPT_SOURCE_FAILED });
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
    return Result.err(required.error);
  }
  const optional = await loadOptionalPromptSource(connectorCatalog);
  return Result.ok({
    requestedSkillsPrompt: required.value,
    connectableConnectors:
      optional.type === "loaded" ? optional.value : undefined,
  });
};
