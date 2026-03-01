import type * as v from "valibot";

import { getActorRegion } from "../consts";
import type { CommonOptions, OptionsType } from "../types";
import {
  actorKeyFactory,
  authedActorParamsSchema,
  type AuthedActorOptions,
  type AuthedActorReturn,
} from "./common";

export type BBoxActorEvent = {
  name: "b-box-status";
  data: {
    status: "pending" | "completed" | "error";
    justificationId: string;
  };
};

const [createActorKey, parseActorKey] = actorKeyFactory<{
  organizationId: string;
  workspaceId: string;
}>();
export const parseBBoxActorKey = parseActorKey;

export const bBoxActorParamsSchema = authedActorParamsSchema;
export type BBoxActorParams = v.InferOutput<typeof bBoxActorParamsSchema>;

type BBoxActorOptions<T extends OptionsType> = AuthedActorOptions<
  T,
  {
    workspaceId: string;
  }
>;
type BBoxActorReturn<T extends OptionsType> = AuthedActorReturn<T, "bBox">;

export const getBBoxActorConfig = <T extends OptionsType>(
  options: BBoxActorOptions<T>,
): BBoxActorReturn<T> => {
  const key = createActorKey({
    organizationId: options.organizationId,
    workspaceId: options.workspaceId,
  });
  const params: BBoxActorParams = {
    authToken: options.authToken ?? "",
  };
  const commonOptions: CommonOptions = {
    createInRegion: getActorRegion(),
    params,
  };

  if (options.type === "react") {
    const clientOptions: BBoxActorReturn<"react"> = {
      name: "bBox",
      key,
      enabled: !!options.authToken,
      ...commonOptions,
    };
    return clientOptions as BBoxActorReturn<T>;
  }

  const vanillaOptions: BBoxActorReturn<"vanilla"> = [[key], commonOptions];
  return vanillaOptions as BBoxActorReturn<T>;
};
