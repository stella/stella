import { BETTER_AUTH_ADAPTER_OPTIONS } from "@stll/auth-model";

import { authSchema } from "@/api/db/auth-schema";

export const AUTH_DATABASE_ADAPTER_OPTIONS = {
  ...BETTER_AUTH_ADAPTER_OPTIONS,
  schema: authSchema,
} as const;

export const AUTH_DATABASE_ID_OPTIONS = {} as const;

export const AUTH_SESSION_STORAGE_OPTIONS = {
  storeSessionInDatabase: true,
} as const;

export const AUTH_VERIFICATION_STORAGE_OPTIONS = {
  storeInDatabase: true,
} as const;
