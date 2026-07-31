export const AUTH_SESSION_ADDITIONAL_FIELDS = {
  authenticationMethod: {
    type: "string",
    required: false,
    defaultValue: "non_sso",
    input: false,
  },
  ssoProviderId: {
    type: "string",
    required: false,
    input: false,
  },
} as const;
