import type * as v from "valibot";

import { getActorRegion } from "../consts";
import type { CommonOptions, OptionsType } from "../types";
import { actorKeyFactory, authedActorParamsSchema } from "./common";
import type { AuthedActorOptions, AuthedActorReturn } from "./common";

export type UserContext = {
  userName: string;
  locale: string;
  timezone: string;
};

export type ThreadSummary = {
  id: string;
  title: string;
  createdAt: number;
  workspaceId: string | null;
};

export type SequencedChunk<TChunk = unknown> = {
  threadId: string;
  seq: number;
  chunk: TChunk;
};

const [createActorKey] = actorKeyFactory<{
  organizationId: string;
  userId: string;
}>();

export const chatActorParamsSchema = authedActorParamsSchema;
export type ChatActorParams = v.InferOutput<typeof chatActorParamsSchema>;

type ChatActorOptions<T extends OptionsType> = AuthedActorOptions<
  T,
  { userId: string }
>;
type ChatActorReturn<T extends OptionsType> = AuthedActorReturn<T, "chat">;

export const getChatActorConfig = <T extends OptionsType>(
  options: ChatActorOptions<T>,
): ChatActorReturn<T> => {
  const key = createActorKey({
    organizationId: options.organizationId,
    userId: options.userId,
  });
  const params: ChatActorParams = {
    authToken: options.authToken ?? "",
  };
  const region = getActorRegion();
  const commonOptions: CommonOptions = {
    ...(region && { createInRegion: region }),
    params,
  };

  if (options.type === "react") {
    const clientOptions: ChatActorReturn<"react"> = {
      name: "chat",
      key,
      enabled: !!options.authToken,
      ...commonOptions,
    };
    // SAFETY: framework type erasure; clientOptions satisfies ChatActorReturn
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return clientOptions as ChatActorReturn<T>;
  }

  const vanillaOptions: ChatActorReturn<"vanilla"> = [[key], commonOptions];
  // SAFETY: framework type erasure; vanillaOptions satisfies ChatActorReturn
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return vanillaOptions as ChatActorReturn<T>;
};
