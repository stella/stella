import type { MicrosoftEntraIDProfile } from "@better-auth/core/social-providers";
import type { BetterAuthOptions } from "better-auth";

const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

type MicrosoftIdentityOptions = {
  profile: Record<string, unknown> | undefined;
  email: string | undefined;
  tenantId: string | undefined;
};

const isAllowedMicrosoftTenant = ({
  profile,
  tenantId,
}: Pick<MicrosoftIdentityOptions, "profile" | "tenantId">) => {
  if (!profile || !tenantId || typeof profile["tid"] !== "string") {
    return false;
  }
  const tenant = profile["tid"].toLowerCase();
  if (
    profile["iss"] !==
    `https://login.microsoftonline.com/${profile["tid"]}/v2.0`
  ) {
    return false;
  }
  switch (tenantId.toLowerCase()) {
    case "common":
      break;
    case "organizations":
      if (tenant === MICROSOFT_CONSUMER_TENANT_ID) {
        return false;
      }
      break;
    case "consumers":
      if (tenant !== MICROSOFT_CONSUMER_TENANT_ID) {
        return false;
      }
      break;
    default:
      if (tenant !== tenantId.toLowerCase()) {
        return false;
      }
  }
  return true;
};

export const isVerifiedMicrosoftIdentity = ({
  profile,
  email,
  tenantId,
}: MicrosoftIdentityOptions) => {
  if (!isAllowedMicrosoftTenant({ profile, tenantId }) || !profile || !email) {
    return false;
  }
  if (
    typeof profile["email"] !== "string" ||
    profile["email"].toLowerCase() !== email.toLowerCase()
  ) {
    return false;
  }
  if (profile["email_verified"] === false) {
    return false;
  }
  if (profile["email_verified"] === true || profile["xms_edov"] === true) {
    return true;
  }
  return [
    profile["verified_primary_email"],
    profile["verified_secondary_email"],
  ].some(
    (addresses) =>
      Array.isArray(addresses) &&
      addresses.some(
        (address: unknown) =>
          typeof address === "string" &&
          address.toLowerCase() === email.toLowerCase(),
      ),
  );
};

/**
 * Microsoft profile mapping: `emailVerified` comes from the same identity-proof
 * predicate the identity validation applies.
 */
export const createMicrosoftProfileMapper =
  (tenantId: string | undefined) => (profile: MicrosoftEntraIDProfile) => ({
    emailVerified: isVerifiedMicrosoftIdentity({
      profile,
      email: profile.email,
      tenantId,
    }),
  });

type IdentityValidation = NonNullable<
  NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]
>;

type MicrosoftClaimWarning = {
  provider: "microsoft";
  tenantMode: "common" | "organizations" | "consumers" | "specific" | "unset";
  missingClaims: string;
};

type SocialIdentityValidationOptions = {
  tenantId: string | undefined;
  requireMicrosoftVerifiedEmailClaim: boolean;
  warn: (attributes: MicrosoftClaimWarning) => void;
};

export const createSocialIdentityValidation =
  ({
    tenantId,
    requireMicrosoftVerifiedEmailClaim,
    warn,
  }: SocialIdentityValidationOptions): IdentityValidation =>
  ({ user, source }) => {
    if (
      source.method !== "oauth" &&
      source.method !== "sso-oidc" &&
      source.method !== "sso-saml" &&
      source.method !== "agent-idjag"
    ) {
      return undefined;
    }
    const denial = {
      error: "identity_not_allowed",
      errorDescription: "Sign-in is unavailable for this account.",
    };
    if (source.oauth?.providerId !== "microsoft") {
      return user.emailVerified === true ? undefined : denial;
    }
    const { profile } = source.oauth;
    if (!isAllowedMicrosoftTenant({ profile, tenantId })) {
      return denial;
    }
    if (isVerifiedMicrosoftIdentity({ profile, email: user.email, tenantId })) {
      return undefined;
    }
    if (requireMicrosoftVerifiedEmailClaim) {
      return denial;
    }
    const configured = tenantId?.toLowerCase();
    let tenantMode: MicrosoftClaimWarning["tenantMode"] = "specific";
    switch (configured) {
      case "common":
      case "organizations":
      case "consumers":
        tenantMode = configured;
        break;
      case undefined:
        tenantMode = "unset";
        break;
      default:
        break;
    }
    warn({
      provider: "microsoft",
      tenantMode,
      missingClaims: [
        "xms_edov",
        "email_verified",
        "verified_primary_email",
        "verified_secondary_email",
      ]
        .filter((claim) => profile?.[claim] === undefined)
        .join(","),
    });
    return undefined;
  };

export const SOCIAL_ACCOUNT_LINKING_OPTIONS = {
  enabled: true,
  trustedProviders: [],
  allowDifferentEmails: false,
} satisfies NonNullable<
  NonNullable<BetterAuthOptions["account"]>["accountLinking"]
>;
