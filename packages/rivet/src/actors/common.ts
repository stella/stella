import type { ActorOptions, AnyActorRegistry } from "@rivetkit/framework-base";
import * as v from "valibot";

import type { OptionsType, VanillaOptions } from "../types";

export const authedActorParamsSchema = v.strictObject({
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
    const first = key[0];
    if (!first) {
      throw new Error("parseActorKey: empty key array");
    }
    // SAFETY: key is produced by actorKeyFactory via JSON.stringify(data) where data
    // conforms to AuthedActorKey; roundtrip yields the same shape.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    return JSON.parse(first) as T;
  }

  // SAFETY: same as above; key comes from our serialization.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(key) as T;
};

export const actorKeyFactory = <T extends AuthedActorKey>() => {
  const createKey = (data: T) => {
    const sorted = Object.fromEntries(
      Object.keys(data)
        .toSorted()
        // SAFETY: keys come from Object.keys(data), so they are valid keyof T.
        // eslint-disable-next-line typescript/no-unsafe-type-assertion
        .map((k) => [k, data[k as keyof T]]),
    );
    return JSON.stringify(sorted);
  };

  return [createKey, parseActorKey<T>] as const;
};
