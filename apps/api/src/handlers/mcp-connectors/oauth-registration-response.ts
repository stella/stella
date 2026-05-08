import type { McpOAuthRegistrationResponse } from "@/api/db/schema";

const REDACTED_OAUTH_REGISTRATION_VALUE = "[redacted]";
const SENSITIVE_OAUTH_REGISTRATION_KEYS = new Set([
  "access_token",
  "client_assertion",
  "client_secret",
  "id_token",
  "password",
  "refresh_token",
  "registration_access_token",
]);

export const redactMcpOAuthRegistrationResponse = (
  response: Record<string, unknown>,
): McpOAuthRegistrationResponse => redactMcpOAuthRegistrationObject(response);

const redactMcpOAuthRegistrationObject = (
  response: Record<string, unknown>,
): McpOAuthRegistrationResponse => {
  const entries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(response)) {
    entries.push([
      key,
      isSensitiveOAuthRegistrationKey(key)
        ? REDACTED_OAUTH_REGISTRATION_VALUE
        : redactMcpOAuthRegistrationValue(value),
    ]);
  }

  return Object.fromEntries(entries);
};

const redactMcpOAuthRegistrationValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactMcpOAuthRegistrationValue);
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  return redactMcpOAuthRegistrationObject(value);
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

const isSensitiveOAuthRegistrationKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return (
    SENSITIVE_OAUTH_REGISTRATION_KEYS.has(normalized) ||
    normalized.endsWith("_secret") ||
    normalized.endsWith("_password") ||
    normalized.endsWith("_assertion")
  );
};
