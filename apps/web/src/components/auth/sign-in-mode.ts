export const SIGN_IN_MODE = {
  signIn: "sign-in",
  reauthenticate: "reauthenticate",
} as const;

export type SignInMode = (typeof SIGN_IN_MODE)[keyof typeof SIGN_IN_MODE];
