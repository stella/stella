import type { apiKey } from "@better-auth/api-key";

type ApiKeyEndpoints = ReturnType<typeof apiKey>["endpoints"];

export type VerifyApiKey = (
  ...args: Parameters<ApiKeyEndpoints["verifyApiKey"]>
) => ReturnType<ApiKeyEndpoints["verifyApiKey"]>;

export type UpdateApiKey = (
  ...args: Parameters<ApiKeyEndpoints["updateApiKey"]>
) => ReturnType<ApiKeyEndpoints["updateApiKey"]>;
