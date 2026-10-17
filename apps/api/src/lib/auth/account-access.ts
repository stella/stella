export const ACCOUNT_ACCESS = {
  standard: "standard",
  sandbox: "sandbox",
  accountControl: "account-control",
} as const;

export type AccountAccess =
  (typeof ACCOUNT_ACCESS)[keyof typeof ACCOUNT_ACCESS];
