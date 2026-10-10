import * as v from "valibot";

import {
  AUTH_ACCESS_RESET_ERROR_CODE,
  AUTH_SOCIAL_PROVIDER_IDS,
} from "@stll/auth-model";

const accessResetErrorSchema = v.object({
  status: v.literal(409),
  code: v.literal(AUTH_ACCESS_RESET_ERROR_CODE),
  providers: v.array(v.string()),
});

export const accessResetProviders = (error: unknown): string[] | null => {
  const parsed = v.safeParse(accessResetErrorSchema, error);
  return parsed.success ? parsed.output.providers : null;
};

export const socialProviderSchema = v.picklist(AUTH_SOCIAL_PROVIDER_IDS);
export type SocialProvider = v.InferOutput<typeof socialProviderSchema>;
const SOCIAL_PROVIDER_NAMES = {
  google: "Google",
  microsoft: "Microsoft",
} as const satisfies Record<SocialProvider, string>;

export const socialProviderName = (provider: SocialProvider): string =>
  SOCIAL_PROVIDER_NAMES[provider];
