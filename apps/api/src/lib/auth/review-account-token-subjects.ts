import type { AuthContext } from "better-auth";
import { Result } from "better-result";
import { decodeJwt } from "jose";

import { REVIEW_ACCOUNT_OPERATION } from "@/api/lib/auth/review-account-policy";
import type { ReviewAccountOperation } from "@/api/lib/auth/review-account-policy";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Auth endpoints that redeem a token or a stored state naming an account,
 * with how to find that account. A token issued before the account was
 * restricted still names it, so each redemption is checked against the
 * account policy before the endpoint takes effect. Email codes are named by
 * the request's email and checked with the other body-email endpoints.
 */
export type TokenSubject = {
  email: string;
  operation: ReviewAccountOperation;
};

type TokenRedemptionInput = {
  body: unknown;
  query: unknown;
  internalAdapter: Pick<
    AuthContext["internalAdapter"],
    "findVerificationValue" | "findUserById"
  >;
};

type TokenSubjectResolver = (
  input: TokenRedemptionInput,
) => Promise<readonly TokenSubject[]>;

const readString = (source: unknown, key: string): string | undefined => {
  const value = isRecord(source) ? source[key] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** Better Auth reads the body first, then the query. */
const readParameter = (
  { body, query }: Pick<TokenRedemptionInput, "body" | "query">,
  key: string,
) => readString(body, key) ?? readString(query, key);

/** The account a stored verification value names by user id. */
const storedUserSubject = async (
  internalAdapter: TokenRedemptionInput["internalAdapter"],
  identifier: string,
  operation: ReviewAccountOperation,
): Promise<readonly TokenSubject[]> => {
  const verification = await internalAdapter.findVerificationValue(identifier);
  if (!verification) {
    return [];
  }
  const owner = await internalAdapter.findUserById(verification.value);
  return owner ? [{ email: owner.email, operation }] : [];
};

/**
 * The accounts an email-verification or email-change link names: the
 * current address and, for a change, the new one. Parsing only; a token
 * that does not decode names nobody and the endpoint refuses it itself.
 */
const verificationLinkSubjects = (
  input: Pick<TokenRedemptionInput, "body" | "query">,
): readonly TokenSubject[] => {
  const token = readParameter(input, "token");
  const payload =
    token === undefined ? undefined : Result.try(() => decodeJwt(token));
  if (payload === undefined || Result.isError(payload)) {
    return [];
  }
  const email = readString(payload.value, "email");
  const updateTo = readString(payload.value, "updateTo");
  const operation =
    updateTo === undefined
      ? REVIEW_ACCOUNT_OPERATION.verifyEmail
      : REVIEW_ACCOUNT_OPERATION.changeEmail;
  return [email, updateTo].flatMap((subject) =>
    subject === undefined ? [] : [{ email: subject, operation }],
  );
};

export const REVIEW_ACCOUNT_TOKEN_REDEMPTIONS: Readonly<
  Record<string, TokenSubjectResolver>
> = {
  // Password reset: `reset-password:<token>` stores the user id.
  "/reset-password": async (input) => {
    const token = readParameter(input, "token");
    return token === undefined
      ? []
      : await storedUserSubject(
          input.internalAdapter,
          `reset-password:${token}`,
          REVIEW_ACCOUNT_OPERATION.changePassword,
        );
  },
  // Account deletion confirmation: `delete-account-<token>` stores the id.
  "/delete-user/callback": async (input) => {
    const token = readParameter(input, "token");
    return token === undefined
      ? []
      : await storedUserSubject(
          input.internalAdapter,
          `delete-account-${token}`,
          REVIEW_ACCOUNT_OPERATION.deleteAccount,
        );
  },
  // Email verification and email-change confirmation: a signed token naming
  // the current address and, for a change, the new one. Read without
  // verifying; a forged token is refused by the endpoint anyway.
  "/verify-email": async (input) =>
    await Promise.resolve(verificationLinkSubjects(input)),
  // Social sign-in callback: a stored OAuth state that links an identity
  // names the account it links to.
  "/callback/:id": async (input) => {
    const state = readParameter(input, "state");
    if (state === undefined) {
      return [];
    }
    const verification =
      await input.internalAdapter.findVerificationValue(state);
    if (!verification) {
      return [];
    }
    const parsed = Result.try((): unknown => JSON.parse(verification.value));
    const link =
      Result.isOk(parsed) && isRecord(parsed.value)
        ? parsed.value["link"]
        : undefined;
    const userId = readString(link, "userId");
    if (userId === undefined) {
      return [];
    }
    const owner = await input.internalAdapter.findUserById(userId);
    return owner
      ? [
          {
            email: owner.email,
            operation: REVIEW_ACCOUNT_OPERATION.linkIdentity,
          },
        ]
      : [];
  },
};

/**
 * Whether an auth path matches a route template: segment by segment, with a
 * `:param` segment matching any one segment. Hooks may see either the
 * template (`/callback/:id`) or the concrete path (`/callback/google`).
 */
export const matchesAuthPathTemplate = (
  template: string,
  path: string,
): boolean => {
  const templateSegments = template.split("/");
  const pathSegments = path.split("/");
  return (
    templateSegments.length === pathSegments.length &&
    templateSegments.every(
      (segment, index) =>
        segment === pathSegments[index] ||
        (segment.startsWith(":") && (pathSegments[index] ?? "").length > 0),
    )
  );
};

/** The subject resolver for a token-redeeming auth path, if it is one. */
export const findReviewAccountTokenRedemption = (
  path: string,
): TokenSubjectResolver | undefined =>
  Object.entries(REVIEW_ACCOUNT_TOKEN_REDEMPTIONS).find(([template]) =>
    matchesAuthPathTemplate(template, path),
  )?.[1];

export const isReviewAccountTokenRedemptionPath = (path: string): boolean =>
  findReviewAccountTokenRedemption(path) !== undefined;
