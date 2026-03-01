import { Result, TaggedError } from "better-result";

import { getSyncActorConfig } from "@stella/rivet/actors/sync-actor-config";

import { rivet } from "@/api/handlers/registry";
import type { SafeId } from "@/api/lib/branded-types";

class InvalidateQueryError extends TaggedError("InvalidateQueryError")<{
  queryKey: string[];
  message: string;
  cause: unknown;
}>() {}

type InvalidateQueryArgs = {
  organizationId: SafeId<"organization">;
  authToken: string;
  queryKey: string[];
};

export const invalidateQueryAction = (args: InvalidateQueryArgs) =>
  Result.tryPromise({
    try: async () => {
      const actorConfig = getSyncActorConfig({
        type: "vanilla",
        organizationId: args.organizationId,
        authToken: args.authToken,
      });

      const actor = rivet.sync.getOrCreate(...actorConfig);

      await actor.invalidateQuery(args.queryKey);
    },
    catch: (error) =>
      new InvalidateQueryError({
        queryKey: args.queryKey,
        message: "Failed to invalidate query",
        cause: error,
      }),
  });
