import { disposableEmailBlocklistSet } from "disposable-email-domains-js";

import { env } from "@/api/env";
import { normalizeRateLimitClientAddress } from "@/api/lib/client-ip";
import {
  EXISTING_ACCOUNT_OTP_EMAIL_MAX,
  NEW_ACCOUNT_OTP_RATE_LIMITS,
} from "@/api/lib/limits";
import type { RateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

const DISPOSABLE_EMAIL_DOMAINS = disposableEmailBlocklistSet();
const NEW_ACCOUNT_OTP_RATE_LIMIT_SCOPE = "auth:new-account-otp";

let sharedRateLimitContext: RedisRateLimitContext | null = null;

const getSharedRateLimitContext = (): RedisRateLimitContext => {
  sharedRateLimitContext ??= new RedisRateLimitContext({
    failurePolicy: "fail_open_local",
  });
  return sharedRateLimitContext;
};

const normalizeAuthEmail = (email: string): string =>
  email.trim().toLowerCase();

const domainFromEmail = (email: string): string | null => {
  const normalizedEmail = normalizeAuthEmail(email);
  const separatorIndex = normalizedEmail.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === normalizedEmail.length - 1) {
    return null;
  }

  let domain = normalizedEmail.slice(separatorIndex + 1);
  while (domain.endsWith(".")) {
    domain = domain.slice(0, -1);
  }
  return domain.length > 0 ? domain : null;
};

export const isDisposableEmailAddress = (email: string): boolean => {
  let domain = domainFromEmail(email);
  while (domain) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
      return true;
    }

    const separatorIndex = domain.indexOf(".");
    domain = separatorIndex === -1 ? null : domain.slice(separatorIndex + 1);
  }
  return false;
};

const identityHash = (identity: string): string =>
  new Bun.CryptoHasher("sha256", env.BETTER_AUTH_SECRET)
    .update(identity)
    .digest("hex");

const counterKey = (kind: "email" | "ip", identity: string): string =>
  `${NEW_ACCOUNT_OTP_RATE_LIMIT_SCOPE}:${kind}:${identityHash(
    kind === "ip" ? normalizeRateLimitClientAddress(identity) : identity,
  )}`;

type SignupOtpRateLimitResult =
  | { status: "allowed"; count: number }
  | {
      status: "rate_limited";
      reason: "email" | "ip";
      count: number;
    };

export const consumeSignupOtpRateLimit = async ({
  context = getSharedRateLimitContext(),
  identity,
  kind,
}: {
  context?: Pick<RateLimitContext, "increment">;
  identity: string;
  kind: "email" | "ip";
}): Promise<SignupOtpRateLimitResult> => {
  const limit = NEW_ACCOUNT_OTP_RATE_LIMITS[kind];
  const counter = await context.increment(
    counterKey(kind, identity),
    limit.duration,
  );
  if (counter.count > limit.max) {
    return {
      status: "rate_limited",
      reason: kind,
      count: counter.count,
    };
  }
  return { status: "allowed", count: counter.count };
};

export type NewAccountOtpPolicyResult =
  | { status: "allowed"; reason: "existing_account" | "new_account" }
  | { status: "rejected"; reason: "disposable_email" }
  | {
      status: "rate_limited";
      reason: "email" | "ip";
    };

export const evaluateNewAccountOtpPolicy = async ({
  accountExists,
  clientIp,
  context,
  email,
}: {
  accountExists: (normalizedEmail: string) => Promise<boolean>;
  clientIp: string | null;
  context?: Pick<RateLimitContext, "increment">;
  email: string;
}): Promise<NewAccountOtpPolicyResult> => {
  const normalizedEmail = normalizeAuthEmail(email);

  // Both counters are consumed before the account-existence branch, so a
  // request for a registered address and one for an unregistered address
  // leave identical counter state behind. Consuming them afterwards makes
  // the branch measurable: the caller can exhaust a counter it shares (its
  // own IP) and read the account's existence off whether it moved.
  const emailRateLimitResult = await consumeSignupOtpRateLimit({
    ...(context ? { context } : {}),
    identity: normalizedEmail,
    kind: "email",
  });
  const ipRateLimitResult = clientIp
    ? await consumeSignupOtpRateLimit({
        ...(context ? { context } : {}),
        identity: clientIp,
        kind: "ip",
      })
    : null;

  // An address that already has an account gets a higher ceiling on the same
  // email counter; new-account capacity (and the IP counter) does not apply.
  if (await accountExists(normalizedEmail)) {
    return emailRateLimitResult.count > EXISTING_ACCOUNT_OTP_EMAIL_MAX
      ? { status: "rate_limited", reason: "email" }
      : { status: "allowed", reason: "existing_account" };
  }

  if (emailRateLimitResult.status === "rate_limited") {
    return { status: "rate_limited", reason: "email" };
  }

  if (ipRateLimitResult?.status === "rate_limited") {
    return { status: "rate_limited", reason: "ip" };
  }

  if (isDisposableEmailAddress(normalizedEmail)) {
    return { status: "rejected", reason: "disposable_email" };
  }

  return { status: "allowed", reason: "new_account" };
};
