import type { ActorOptions, AnyActorRegistry } from "@rivetkit/framework-base";
import { sort } from "@tamtamchik/json-deep-sort";
import * as v from "valibot";

import type { OptionsType, VanillaOptions } from "../types";

export const authedActorParamsSchema = v.object({
  authToken: v.string(),
});

export type AuthedActorParams = v.InferOutput<typeof authedActorParamsSchema>;

export type AuthedActorOptions<
  T extends OptionsType,
  TData extends Record<string, unknown> = Record<string, unknown>,
> = {
  type: T;
  authToken: T extends "react" ? string | undefined : string;
  organizationId: string;
} & TData;

export type AuthedActorReturn<
  T extends OptionsType,
  TName extends string,
> = T extends "react" ? ActorOptions<AnyActorRegistry, TName> : VanillaOptions;

type AuthedActorKey = {
  organizationId: string;
};

export const parseActorKey = <T extends AuthedActorKey = AuthedActorKey>(
  key: string | string[],
): T => {
  if (Array.isArray(key)) {
    return JSON.parse(key[0]);
  }

  return JSON.parse(key);
};

export const actorKeyFactory = <T extends AuthedActorKey>() => {
  const createKey = (data: T) => {
    const json = JSON.stringify(data);
    const sorted = sort(json, true, true);

    return sorted;
  };

  return [createKey, parseActorKey<T>] as const;
};
