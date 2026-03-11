import type * as v from "valibot";

import { getActorRegion } from "../consts";
import type { CommonOptions, OptionsType } from "../types";
import { actorKeyFactory, authedActorParamsSchema } from "./common";
import type { AuthedActorOptions, AuthedActorReturn } from "./common";

export type SyncActorEvent = {
  name: "invalidate-query";
  data: string[];
};

const [createActorKey] = actorKeyFactory();

export const syncActorParamsSchema = authedActorParamsSchema;
export type SyncActorParams = v.InferOutput<typeof syncActorParamsSchema>;

type SyncActorOptions<T extends OptionsType> = AuthedActorOptions<T>;
type SyncActorReturn<T extends OptionsType> = AuthedActorReturn<T, "sync">;

export const getSyncActorConfig = <T extends OptionsType>(
  options: SyncActorOptions<T>,
): SyncActorReturn<T> => {
  const key = createActorKey({ organizationId: options.organizationId });
  const params: SyncActorParams = {
    authToken: options.authToken ?? "",
  };
  const commonOptions: CommonOptions = {
    createInRegion: getActorRegion(),
    params,
  };

  if (options.type === "react") {
    const clientOptions: SyncActorReturn<"react"> = {
      name: "sync",
      key,
      enabled: !!options.authToken,
      ...commonOptions,
    };
    return clientOptions as SyncActorReturn<T>;
  }

  const vanillaOptions: SyncActorReturn<"vanilla"> = [[key], commonOptions];
  return vanillaOptions as SyncActorReturn<T>;
};
