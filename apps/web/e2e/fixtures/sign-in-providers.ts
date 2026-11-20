// The production browser build exercises these provider integrations in this order.
export const SIGN_IN_PROVIDERS = [
  {
    name: "Google",
    id: "google",
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=csp-smoke",
  },
  {
    name: "Microsoft",
    id: "microsoft",
    url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=csp-smoke",
  },
] as const;
