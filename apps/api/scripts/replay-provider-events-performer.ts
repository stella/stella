import { Result, TaggedError } from "better-result";
import { userInfo } from "node:os";
import * as v from "valibot";

import type { ProviderEventReplayPerformer } from "@/api/lib/hosted-usage-provider/replay-audit";

export class ReplayPerformerIdentityError extends TaggedError(
  "ReplayPerformerIdentityError",
)<{ message: string; cause?: unknown }> {}

const METADATA_TIMEOUT_MS = 5000;

// Task metadata has other fields; only the task ARN is retained.
const taskIdentitySchema = v.object({
  TaskARN: v.pipe(
    v.string(),
    v.regex(/^arn:[^:]+:ecs:[^:]+:\d{12}:task\/.+$/u),
  ),
});

type ResolveReplayPerformerOptions = {
  metadataUri: string | undefined;
  executionEnvironment?: string | undefined;
  fetchMetadata?: (url: string, signal: AbortSignal) => Promise<Response>;
  localUsername?: () => string;
};

/** Resolve before opening the database: ECS identity failure refuses the run. */
export const resolveReplayPerformer = async ({
  metadataUri,
  executionEnvironment,
  fetchMetadata = async (url, signal) => await fetch(url, { signal }),
  localUsername = () => userInfo().username,
}: ResolveReplayPerformerOptions): Promise<
  Result<ProviderEventReplayPerformer, ReplayPerformerIdentityError>
> =>
  await Result.tryPromise({
    try: async () => {
      if (metadataUri === undefined) {
        if (executionEnvironment?.startsWith("AWS_ECS_")) {
          throw new ReplayPerformerIdentityError({
            message: "ECS task metadata endpoint is missing; replay refused.",
          });
        }
        const username = localUsername();
        if (!username.trim()) {
          throw new ReplayPerformerIdentityError({
            message: "Could not resolve the local OS user; replay refused.",
          });
        }
        return { type: "local", username };
      }
      const response = await fetchMetadata(
        `${metadataUri}/task`,
        AbortSignal.timeout(METADATA_TIMEOUT_MS),
      );
      if (!response.ok) {
        throw new ReplayPerformerIdentityError({
          message: "Could not resolve ECS task identity; replay refused.",
        });
      }
      const { TaskARN } = v.parse(taskIdentitySchema, await response.json());
      return { type: "service", id: TaskARN, name: null };
    },
    catch: (cause) =>
      new ReplayPerformerIdentityError({
        message: "Could not resolve replay performer identity; replay refused.",
        cause,
      }),
  });
