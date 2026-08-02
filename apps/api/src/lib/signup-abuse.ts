import { disposableEmailBlocklistSet } from "disposable-email-domains-js";
import type { Context } from "elysia-rate-limit";

import { env } from "@/api/env";
import { NEW_ACCOUNT_OTP_RATE_LIMITS } from "@/api/lib/limits";
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

export const normalizeAuthEmail = (email: string): string =>
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
  `${NEW_ACCOUNT_OTP_RATE_LIMIT_SCOPE}:${kind}:${identityHash(identity)}`;

const retryAfterSeconds = (nextReset: Date): number =>
  Math.max(1, Math.ceil((nextReset.getTime() - Date.now()) / 1000));

type NewAccountOtpRateLimitResult =
  | { status: "allowed" }
  | {
      status: "rate_limited";
      reason: "email" | "ip";
      retryAfterSeconds: number;
    };

export const consumeNewAccountOtpRateLimit = async ({
  clientIp,
  context = getSharedRateLimitContext(),
  normalizedEmail,
}: {
  clientIp: string | null;
  context?: Pick<Context, "increment">;
  normalizedEmail: string;
}): Promise<NewAccountOtpRateLimitResult> => {
  const emailCounterPromise = context.increment(
    counterKey("email", normalizedEmail),
    NEW_ACCOUNT_OTP_RATE_LIMITS.email.duration,
  );
  const ipCounterPromise = clientIp
    ? context.increment(
        counterKey("ip", clientIp),
        NEW_ACCOUNT_OTP_RATE_LIMITS.ip.duration,
      )
    : null;

  const emailCounter = await emailCounterPromise;
  const ipCounter = ipCounterPromise ? await ipCounterPromise : null;

  if (emailCounter.count > NEW_ACCOUNT_OTP_RATE_LIMITS.email.max) {
    return {
      status: "rate_limited",
      reason: "email",
      retryAfterSeconds: retryAfterSeconds(emailCounter.nextReset),
    };
  }
  if (ipCounter && ipCounter.count > NEW_ACCOUNT_OTP_RATE_LIMITS.ip.max) {
    return {
      status: "rate_limited",
      reason: "ip",
      retryAfterSeconds: retryAfterSeconds(ipCounter.nextReset),
    };
  }
  return { status: "allowed" };
};

export type NewAccountOtpPolicyResult =
  | { status: "allowed"; reason: "existing_account" | "new_account" }
  | { status: "rejected"; reason: "disposable_email" }
  | {
      status: "rate_limited";
      reason: "email" | "ip";
      retryAfterSeconds: number;
    };

export const evaluateNewAccountOtpPolicy = async ({
  accountExists,
  clientIp,
  context,
  email,
}: {
  accountExists: (normalizedEmail: string) => Promise<boolean>;
  clientIp: string | null;
  context?: Pick<Context, "increment">;
  email: string;
}): Promise<NewAccountOtpPolicyResult> => {
  const normalizedEmail = normalizeAuthEmail(email);
  if (await accountExists(normalizedEmail)) {
    return { status: "allowed", reason: "existing_account" };
  }
  if (isDisposableEmailAddress(normalizedEmail)) {
    return { status: "rejected", reason: "disposable_email" };
  }

  const rateLimitResult = await consumeNewAccountOtpRateLimit({
    clientIp,
    ...(context ? { context } : {}),
    normalizedEmail,
  });
  if (rateLimitResult.status === "rate_limited") {
    return rateLimitResult;
  }
  return { status: "allowed", reason: "new_account" };
};
