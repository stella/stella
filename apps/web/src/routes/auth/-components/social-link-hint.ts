import { Result } from "better-result";
import * as v from "valibot";

import { socialProviderSchema } from "@/components/auth/access-reset.logic";
import { authClient } from "@/lib/auth-client";
import { toAuthClientError } from "@/lib/errors/auth";

const hintSchema = v.object({
  method: v.nullable(socialProviderSchema),
  provider: v.nullable(socialProviderSchema),
});
export const NO_SOCIAL_LINK_HINT = { method: null, provider: null };

/**
 * Consumes the single-use hint behind a refused social sign-in. The hint only
 * tailors the recovery copy, so a failed read is reported and the email proof
 * continues without it.
 */
export const loadSocialLinkHint = async (
  captureError: (error: unknown) => void,
) => {
  const response = await Result.tryPromise(
    async () =>
      await authClient.$fetch("/social-link-hint", { method: "POST" }),
  );
  const hint = response.andThen(({ data, error }) =>
    error ? Result.err(toAuthClientError(error)) : Result.ok(data),
  );
  if (Result.isError(hint)) {
    captureError(hint.error);
    return NO_SOCIAL_LINK_HINT;
  }
  const parsed = v.safeParse(hintSchema, hint.value);
  return parsed.success ? parsed.output : NO_SOCIAL_LINK_HINT;
};
