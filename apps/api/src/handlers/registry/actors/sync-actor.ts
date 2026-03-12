import { actor } from "rivetkit";
import * as v from "valibot";

import {
  broadcastEvent,
  createUserError,
  validateGlobalActorSession,
} from "@/api/handlers/registry/utils";

const invalidateQuerySchema = v.array(v.string());

type InvalidateQueryArgs = v.InferOutput<typeof invalidateQuerySchema>;

export const syncActor = actor({
  state: {},
  createConnState: async (c, params) =>
    await validateGlobalActorSession(c.key, params),
  actions: {
    invalidateQuery: (c, args: InvalidateQueryArgs) => {
      const queryKey = v.safeParse(invalidateQuerySchema, args);

      if (!queryKey.success) {
        throw createUserError("invalid-arguments", {
          cause: queryKey.issues,
        });
      }

      broadcastEvent(c, { name: "invalidate-query", data: queryKey.output });
    },
  },
});
