import { Result } from "better-result";
import * as v from "valibot";

import { env } from "@/env";
import { fetchWithTimeout } from "@/lib/fetch";

const devOtpSchema = v.object({ otp: v.string() });

/**
 * Reads (and consumes) the email-OTP the dev API mirrors for an address so the
 * sign-in flow can prefill the code instead of making you copy it by hand. The
 * mirror endpoint only exists in dev, so this resolves to `null` in production
 * (and the fetch is tree-shaken out) and whenever no mirrored code is waiting.
 */
export const fetchDevOtp = async (email: string): Promise<string | null> => {
  if (!import.meta.env.DEV) {
    return null;
  }

  const result = await Result.tryPromise(async () => {
    const url = new URL("/dev-public/last-otp", env.VITE_API_URL);
    url.searchParams.set("email", email);
    const response = await fetchWithTimeout(url, {
      credentials: "include",
      timeoutMs: 3000,
    });
    if (!response.ok) {
      return null;
    }
    const parsed = v.safeParse(devOtpSchema, await response.json());
    return parsed.success ? parsed.output.otp : null;
  });

  return Result.isOk(result) ? result.value : null;
};
