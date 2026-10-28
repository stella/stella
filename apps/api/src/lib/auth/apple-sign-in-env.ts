import { panic, Result } from "better-result";

import { env } from "@/api/env";
import { resolveAppleSignIn } from "@/api/lib/apple-sign-in-config";
import type { AppleSignIn } from "@/api/lib/apple-sign-in-config";

let configured: AppleSignIn | undefined;

/**
 * This deployment's Sign in with Apple settings, read once. The boot
 * invariant has already refused a partial or unreadable configuration, so an
 * error here is a broken invariant.
 */
export const configuredAppleSignIn = (): AppleSignIn => {
  if (configured === undefined) {
    const resolved = resolveAppleSignIn(env);
    configured = Result.isError(resolved)
      ? panic(resolved.error.message)
      : resolved.value;
  }
  return configured;
};
