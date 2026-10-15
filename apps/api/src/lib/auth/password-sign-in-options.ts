/**
 * Better Auth email-and-password options. Self-hosted local password auth
 * keeps sign-up (gated by the bootstrap token). The restricted review account
 * alone only signs in: sign-up is off, and the review-account plugin refuses
 * every other address.
 */
export const resolveEmailAndPasswordOptions = ({
  localPasswordEnabled,
  reviewAccountConfigured,
}: {
  localPasswordEnabled: boolean;
  reviewAccountConfigured: boolean;
}) => {
  if (localPasswordEnabled) {
    return {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 12,
      requireEmailVerification: false,
    };
  }
  if (reviewAccountConfigured) {
    return {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      requireEmailVerification: false,
    };
  }
  return undefined;
};
