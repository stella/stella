import * as v from "valibot";

export const chatCacheStablePrefixSchema = v.pipe(
  v.string(),
  v.brand("ChatCacheStablePrefix"),
);
export const chatOrganizationPromptLayerSchema = v.pipe(
  v.string(),
  v.brand("ChatOrganizationPromptLayer"),
);

export type ChatCacheStablePrefix = v.InferOutput<
  typeof chatCacheStablePrefixSchema
>;
export type ChatOrganizationPromptLayer = v.InferOutput<
  typeof chatOrganizationPromptLayerSchema
>;

/** Separate brands keep a user's or turn's data out of cacheable layers. */
export type ChatSafePromptLayers = {
  readonly organization: ChatOrganizationPromptLayer;
  readonly static: ChatCacheStablePrefix;
};
