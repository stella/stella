import type { GenericEndpointContext } from "@better-auth/core";
import { getSessionFromCtx } from "better-auth/api";
import { panic } from "better-result";

import { secondFactorProviderIdentifier } from "@/api/lib/auth-artifacts";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";

/** Better Auth's cookie for a sign-in whose second factor is pending. */
const TWO_FACTOR_COOKIE_NAME = "two_factor";

const SOCIAL_CALLBACK_PREFIX = "/callback/";
const SECOND_FACTOR_COMPLETION_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
]);

/** Refuses a sign-in whose session {@link endSessionWithoutLinkedAccount} ended. */
export const DISCONNECTED_SIGN_IN_MESSAGE =
  "This sign-in method is no longer connected to the account. Sign in with a code sent to the account's email.";

/** The value a pending second factor records when its first factor needs no linked account. */
export const NO_LINKED_ACCOUNT = "none";

/**
 * What a sign-in's session needs to still exist: nothing, the linked account
 * it authenticated through, or, for a second factor whose first factor was
 * never recorded, nothing it can prove.
 */
export type LinkedAccountRequirement =
  | { type: "none" }
  | { type: "linked"; provider: string }
  | { type: "unrecorded" };

type SignInEndpoint = { path?: string | undefined; params?: unknown };

type AccountLookup = (
  userId: SafeId<"user">,
  providerId: string,
) => Promise<boolean>;

/**
 * The linked account a first-factor sign-in at the endpoint authenticated
 * through. A request carries the provider in its path (`/callback/google`), a
 * server call in its params.
 */
export const signInAccountProvider = (
  ctx: SignInEndpoint | null | undefined,
): string | undefined => {
  const path = ctx?.path;
  if (path === "/sign-in/email") {
    return "credential";
  }
  if (path === undefined || !path.startsWith(SOCIAL_CALLBACK_PREFIX)) {
    return undefined;
  }
  const fromPath = path.slice(SOCIAL_CALLBACK_PREFIX.length);
  const fromParams = isRecord(ctx?.params) ? ctx.params["id"] : undefined;
  const provider = fromPath === ":id" ? fromParams : fromPath;
  return typeof provider === "string" && provider !== ""
    ? provider
    : panic(`Social sign-in callback without a provider: ${path}`);
};

/** Whether the endpoint completes a sign-in's pending second factor. */
export const isSecondFactorCompletion = (
  ctx: SignInEndpoint | null | undefined,
): boolean =>
  ctx?.path !== undefined && SECOND_FACTOR_COMPLETION_PATHS.has(ctx.path);

/** A first-factor endpoint's requirement, from the provider it authenticated through. */
export const firstFactorRequirement = (
  ctx: SignInEndpoint | null | undefined,
): LinkedAccountRequirement => {
  const provider = signInAccountProvider(ctx);
  return provider === undefined
    ? { type: "none" }
    : { type: "linked", provider };
};

/** A second-factor completion's requirement, from what its pending challenge recorded. */
export const secondFactorRequirement = (
  recorded: string | undefined,
): LinkedAccountRequirement => {
  if (recorded === undefined) {
    return { type: "unrecorded" };
  }
  return recorded === NO_LINKED_ACCOUNT
    ? { type: "none" }
    : { type: "linked", provider: recorded };
};

/**
 * Records, beside a pending second-factor grant, what its first factor needs
 * so the session that completes it is held to the same linked account.
 */
export const recordSecondFactorRequirement = async (
  ctx: GenericEndpointContext,
  {
    row,
    requirement,
  }: {
    row: { identifier: string; expiresAt: Date };
    requirement: LinkedAccountRequirement;
  },
): Promise<void> => {
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: secondFactorProviderIdentifier(row.identifier),
    value:
      requirement.type === "linked" ? requirement.provider : NO_LINKED_ACCOUNT,
    expiresAt: row.expiresAt,
  });
};

/**
 * The linked account a new session needs to still exist. A second-factor
 * completion reads what its pending challenge recorded about the first factor;
 * Better Auth has consumed the challenge itself by then.
 */
export const sessionLinkedAccountRequirement = async (
  ctx: GenericEndpointContext | null,
): Promise<LinkedAccountRequirement> => {
  if (!ctx || !isSecondFactorCompletion(ctx)) {
    return firstFactorRequirement(ctx);
  }
  // Better Auth completes enrollment, not a pending sign-in, when the request
  // already carries a session: that verification rotates the signed-in
  // session and has no pending challenge to have recorded a first factor.
  if ((await getSessionFromCtx(ctx)) !== null) {
    return { type: "none" };
  }
  const grant = await ctx.getSignedCookie(
    ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME).name,
    ctx.context.secret,
  );
  const recorded =
    typeof grant === "string"
      ? await ctx.context.internalAdapter.findVerificationValue(
          secondFactorProviderIdentifier(grant),
        )
      : null;
  return secondFactorRequirement(recorded?.value);
};

/**
 * Ends what a sign-in just wrote, a session or a pending second-factor grant,
 * when the account it authenticated through is no longer linked, before it
 * reaches the client. The check runs after the insert because an access reset
 * deletes the linked accounts before it sweeps sessions and pending grants:
 * either this check sees the account gone, or the reset's sweep sees the row.
 * Returns whether it ended the row.
 */
export const endSessionWithoutLinkedAccount = async ({
  requirement,
  userId,
  hasAccount,
  endSession,
}: {
  requirement: LinkedAccountRequirement;
  userId: SafeId<"user">;
  hasAccount: AccountLookup;
  endSession: () => Promise<void>;
}): Promise<boolean> => {
  switch (requirement.type) {
    case "none":
      return false;
    case "linked":
      if (await hasAccount(userId, requirement.provider)) {
        return false;
      }
      break;
    case "unrecorded":
      break;
    default:
      return panic(
        `Unhandled linked-account requirement: ${String(requirement satisfies never)}`,
      );
  }
  await endSession();
  return true;
};
