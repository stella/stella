/** Thin client for the hosted usage provider's outbound HTTP API. */

import { Result, TaggedError } from "better-result";

import type { HostedUsageProviderApiCredentials } from "@/api/lib/hosted-usage-provider/config";

const REQUEST_TIMEOUT_MS = 10_000;

export class HostedUsageProviderApiError extends TaggedError(
  "HostedUsageProviderApiError",
)<{
  message: string;
  status?: number;
  cause?: unknown;
}>() {}

type HostedSetupMetadata = {
  organization_id: string;
  usage_policy_id: string;
  seat_user_id?: string | undefined;
};

type CreateHostedSetupInput = {
  credentials: HostedUsageProviderApiCredentials;
  policyRef: string;
  accountRef?: string | undefined;
  externalAccountRef?: string | undefined;
  returnUrl?: string | undefined;
  successUrl: string;
  metadata: HostedSetupMetadata;
};

type CreateHostedSetupResult = {
  id: string;
  url: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readJsonRecord = async (
  response: Response,
  context: string,
): Promise<Record<string, unknown>> => {
  const body = await response.json();
  if (isRecord(body)) {
    return body;
  }
  throw new HostedUsageProviderApiError({
    message: `${context} returned invalid JSON`,
  });
};

const readStringField = (
  body: Record<string, unknown>,
  field: string,
  context: string,
): string => {
  const value = body[field];
  if (typeof value === "string") {
    return value;
  }
  throw new HostedUsageProviderApiError({
    message: `${context} missing ${field}`,
  });
};

export const createHostedSetupSession = async ({
  credentials,
  policyRef,
  accountRef,
  externalAccountRef,
  returnUrl,
  successUrl,
  metadata,
}: CreateHostedSetupInput): Promise<
  Result<CreateHostedSetupResult, HostedUsageProviderApiError>
> =>
  await Result.tryPromise({
    try: async () => {
      const response = await fetch(
        `${credentials.baseUrl}/v1/setup-sessions/`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            policy_refs: [policyRef],
            success_url: successUrl,
            return_url: returnUrl,
            account_ref: accountRef,
            external_account_ref: externalAccountRef,
            metadata,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new HostedUsageProviderApiError({
          message: `Hosted setup session returned ${response.status}`,
          status: response.status,
        });
      }
      const json = await readJsonRecord(response, "Hosted setup session");
      return {
        id: readStringField(json, "id", "Hosted setup session"),
        url: readStringField(json, "url", "Hosted setup session"),
      };
    },
    catch: (cause) => {
      if (cause instanceof HostedUsageProviderApiError) {
        return cause;
      }
      return new HostedUsageProviderApiError({
        message: "Hosted setup session failed",
        cause,
      });
    },
  });

type CreateHostedManagementInput = {
  credentials: HostedUsageProviderApiCredentials;
  accountRef: string;
  returnUrl?: string | undefined;
};

type CreateHostedManagementResult = {
  url: string;
};

export const createHostedManagementSession = async ({
  credentials,
  accountRef,
  returnUrl,
}: CreateHostedManagementInput): Promise<
  Result<CreateHostedManagementResult, HostedUsageProviderApiError>
> =>
  await Result.tryPromise({
    try: async () => {
      const response = await fetch(
        `${credentials.baseUrl}/v1/management-sessions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            account_ref: accountRef,
            return_url: returnUrl,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new HostedUsageProviderApiError({
          message: `Hosted usage management session returned ${response.status}`,
          status: response.status,
        });
      }
      const json = await readJsonRecord(
        response,
        "Hosted usage management session",
      );
      return {
        url: readStringField(
          json,
          "management_url",
          "Hosted usage management session",
        ),
      };
    },
    catch: (cause) => {
      if (cause instanceof HostedUsageProviderApiError) {
        return cause;
      }
      return new HostedUsageProviderApiError({
        message: "Hosted usage management session failed",
        cause,
      });
    },
  });
