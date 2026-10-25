/** Thin client for the hosted usage provider's outbound HTTP API. */

import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { fetchWithTimeout } from "@stll/fetch";
import { isNonNullObject } from "@stll/template-conditions/path";

import {
  getHostedUsageProviderApiVersion,
  getHostedUsageProviderKind,
  type HostedUsageProviderApiCredentials,
} from "@/api/lib/hosted-usage-provider/config";

export const HOSTED_PROVIDER_REQUEST_TIMEOUT_MS = 10_000;

export class HostedUsageProviderApiError extends TaggedError(
  "HostedUsageProviderApiError",
)<{
  message: string;
  status?: number;
  cause?: unknown;
}> {}

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
  /** Seat count for seat-based subscription policies; omit for flat. */
  seats?: number | undefined;
};

type CreateHostedSetupResult = {
  id: string;
  url: string;
  /** When the provider closes the session; null when it reports none. */
  expiresAt: Date | null;
};

const readJsonRecord = async (
  response: Response,
  context: string,
): Promise<Record<string, unknown>> => {
  const body: unknown = await response.json();
  if (isNonNullObject(body)) {
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

const sessionExpirySchema = v.nullish(
  v.pipe(
    v.string(),
    v.isoTimestamp(),
    v.transform((value) => new Date(value)),
  ),
  null,
);

type ProviderRequest =
  | { method: "POST"; path: string; body: Record<string, unknown> }
  | { method: "DELETE"; path: string };

/**
 * The one outbound boundary of this client: every endpoint is a path under
 * the configured base URL, with the same credentials, version pin and
 * timeout.
 */
const sendProviderRequest = async (
  credentials: HostedUsageProviderApiCredentials,
  request: ProviderRequest,
): Promise<Response> => {
  const headers = {
    authorization: `Bearer ${credentials.apiKey}`,
    "Polar-Version": getHostedUsageProviderApiVersion(),
  };
  return await fetchWithTimeout(
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- provider base URL from validated operator configuration (HOSTED_USAGE_PROVIDER_BASE_URL)
    `${credentials.baseUrl}/v1/${request.path}`,
    request.method === "POST"
      ? {
          method: request.method,
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(request.body),
          timeoutMs: HOSTED_PROVIDER_REQUEST_TIMEOUT_MS,
        }
      : {
          method: request.method,
          headers,
          timeoutMs: HOSTED_PROVIDER_REQUEST_TIMEOUT_MS,
        },
  );
};

/** POST a JSON body to the provider API. */
const postProviderJson = async (
  credentials: HostedUsageProviderApiCredentials,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  await sendProviderRequest(credentials, { method: "POST", path, body });

export const eraseHostedCustomer = async ({
  credentials,
  externalCustomerRef,
}: {
  credentials: HostedUsageProviderApiCredentials;
  externalCustomerRef: string;
}): Promise<Result<void, HostedUsageProviderApiError>> =>
  await Result.tryPromise({
    try: async () => {
      // Deletes the customer, cancels its subscriptions and anonymizes its
      // personal data; the provider keeps historic orders and subscriptions.
      const response = await sendProviderRequest(credentials, {
        method: "DELETE",
        path: `customers/external/${encodeURIComponent(externalCustomerRef)}?anonymize=true`,
      });
      if (response.status === 204 || response.status === 404) {
        return;
      }
      throw new HostedUsageProviderApiError({
        message: `Hosted customer erasure returned ${response.status}`,
        status: response.status,
      });
    },
    catch: (cause) =>
      cause instanceof HostedUsageProviderApiError
        ? cause
        : new HostedUsageProviderApiError({
            message: "Hosted customer erasure failed",
            cause,
          }),
  });

const createNeutralSetupSession = async ({
  credentials,
  policyRef,
  accountRef,
  externalAccountRef,
  returnUrl,
  successUrl,
  metadata,
  seats,
}: CreateHostedSetupInput): Promise<
  Result<CreateHostedSetupResult, HostedUsageProviderApiError>
> =>
  await Result.tryPromise({
    try: async () => {
      const response = await postProviderJson(credentials, "setup-sessions/", {
        policy_refs: [policyRef],
        success_url: successUrl,
        return_url: returnUrl,
        account_ref: accountRef,
        external_account_ref: externalAccountRef,
        quantity: seats,
        metadata,
      });
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
        expiresAt: v.parse(sessionExpirySchema, json["expires_at"]),
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

export const createPolarSetupSession = async ({
  credentials,
  policyRef,
  externalAccountRef,
  returnUrl,
  successUrl,
  metadata,
  seats,
}: CreateHostedSetupInput): Promise<
  Result<CreateHostedSetupResult, HostedUsageProviderApiError>
> =>
  await Result.tryPromise({
    try: async () => {
      const response = await postProviderJson(credentials, "checkouts/", {
        products: [policyRef],
        // Polar links the resulting customer by external id, so the
        // org-scoped ref keeps repeat checkouts attached to one customer.
        external_customer_id: externalAccountRef,
        success_url: successUrl,
        return_url: returnUrl,
        // Seat-based products take the seat count at checkout; the
        // resulting subscription reports it back on webhook events.
        seats,
        // Every organization buys as a business. Polar then requires the
        // billing name and full address, and its form collects the tax id.
        is_business_customer: true,
        metadata,
      });
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
        expiresAt: v.parse(sessionExpirySchema, json["expires_at"]),
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

export const createHostedSetupSession = async (
  input: CreateHostedSetupInput,
): Promise<Result<CreateHostedSetupResult, HostedUsageProviderApiError>> =>
  getHostedUsageProviderKind() === "polar"
    ? await createPolarSetupSession(input)
    : await createNeutralSetupSession(input);

type CreateHostedManagementInput = {
  credentials: HostedUsageProviderApiCredentials;
  accountRef: string;
  returnUrl?: string | undefined;
};

type CreateHostedManagementResult = {
  url: string;
};

const createNeutralManagementSession = async ({
  credentials,
  accountRef,
  returnUrl,
}: CreateHostedManagementInput): Promise<
  Result<CreateHostedManagementResult, HostedUsageProviderApiError>
> =>
  await Result.tryPromise({
    try: async () => {
      const response = await postProviderJson(
        credentials,
        "management-sessions",
        {
          account_ref: accountRef,
          return_url: returnUrl,
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

export const createPolarManagementSession = async ({
  credentials,
  accountRef,
  returnUrl,
}: CreateHostedManagementInput): Promise<
  Result<CreateHostedManagementResult, HostedUsageProviderApiError>
> =>
  await Result.tryPromise({
    try: async () => {
      const response = await postProviderJson(
        credentials,
        "customer-sessions/",
        {
          customer_id: accountRef,
          return_url: returnUrl,
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
          "customer_portal_url",
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

export const createHostedManagementSession = async (
  input: CreateHostedManagementInput,
): Promise<
  Result<CreateHostedManagementResult, HostedUsageProviderApiError>
> =>
  getHostedUsageProviderKind() === "polar"
    ? await createPolarManagementSession(input)
    : await createNeutralManagementSession(input);
