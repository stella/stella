export const userErrors = {
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  "invalid-params": "Invalid parameters",
  "invalid-arguments": "Invalid action arguments",
  "invalid-workspace": "Workspace is in an invalid state",
} as const satisfies Record<Lowercase<string>, string>;

export type UserErrorCode = keyof typeof userErrors;
