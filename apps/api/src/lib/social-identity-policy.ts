import type { BetterAuthOptions } from "better-auth";

const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

type MicrosoftIdentityOptions = {
  profile: Record<string, unknown> | undefined;
  email: string | undefined;
  tenantId: string | undefined;
};

export const isVerifiedMicrosoftIdentity = ({
  profile,
  email,
  tenantId,
}: MicrosoftIdentityOptions) => {
  if (!profile || !email || !tenantId || typeof profile["tid"] !== "string") {
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

type IdentityValidation = NonNullable<
  NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]
>;

export const createSocialIdentityValidation =
  (tenantId: string | undefined): IdentityValidation =>
  ({ user, source }) => {
    if (
      source.method !== "oauth" &&
      source.method !== "sso-oidc" &&
      source.method !== "sso-saml" &&
      source.method !== "agent-idjag"
    ) {
      return;
    }
    const verified =
      source.oauth?.providerId === "microsoft"
        ? isVerifiedMicrosoftIdentity({
            profile: source.oauth.profile,
            email: user.email,
            tenantId,
          })
        : user.emailVerified === true;
    if (verified) {
      return;
    }
    return {
      error: "identity_not_allowed",
      errorDescription: "Sign-in is unavailable for this account.",
    };
  };

export const SOCIAL_ACCOUNT_LINKING_OPTIONS = {
  enabled: true,
  trustedProviders: [],
  allowDifferentEmails: false,
  requireLocalEmailVerified: true,
} satisfies NonNullable<
  NonNullable<BetterAuthOptions["account"]>["accountLinking"]
>;
