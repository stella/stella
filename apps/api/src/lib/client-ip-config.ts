export const SIGNUP_RATE_LIMIT_IP_SOURCE = {
  direct: "direct",
  trustedProxy: "trusted_proxy",
} as const;

export type SignupRateLimitIpSource =
  (typeof SIGNUP_RATE_LIMIT_IP_SOURCE)[keyof typeof SIGNUP_RATE_LIMIT_IP_SOURCE];
