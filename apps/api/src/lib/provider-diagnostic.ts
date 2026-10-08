import { Result } from "better-result";

import {
  PROVIDER_SETUP_ERROR_CODE,
  type ProviderDiagnostic,
} from "@stll/api-contract/provider-setup";

import { sanitizeCredentialText } from "@/api/lib/credential-text";
import { identifyProviderSetupError } from "@/api/lib/provider-error-catalogue";
import { isRecord } from "@/api/lib/type-guards";

const credentials = new WeakMap<object, readonly string[]>();

/** Credentials stay private to a resolved model and expire with it. */
export const registerProviderDiagnosticCredentials = (
  model: object,
  secrets: readonly string[],
): void => {
  credentials.set(model, secrets);
};

const providerErrorRecord = (
  evidence: unknown,
): Record<string, unknown> | undefined => {
  const seen = new Set<object>();
  let current = evidence;
  let candidate: Record<string, unknown> | undefined;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    const awsMetadata = current["$metadata"];
    const awsProviderError =
      isRecord(awsMetadata) &&
      typeof awsMetadata["httpStatusCode"] === "number";
    if (
      typeof current["message"] === "string" &&
      (!(current instanceof Error) || awsProviderError)
    ) {
      candidate = current;
    }
    const body = current["body"];
    const rawResponse = current["rawResponse"];
    if (typeof body === "string" && rawResponse instanceof Response) {
      const parsed = Result.try((): unknown => JSON.parse(body));
      if (Result.isOk(parsed) && isRecord(parsed.value)) {
        current = parsed.value;
        continue;
      }
    }
    current = current["error"] ?? current["cause"];
  }
  return candidate;
};

type CreateProviderDiagnosticOptions = {
  model: { provider: string; keySource?: "byok" | "instance" };
  evidence: unknown;
};

export const createProviderDiagnostic = ({
  model,
  evidence,
}: CreateProviderDiagnosticOptions): ProviderDiagnostic | undefined => {
  if (model.keySource === "instance") {
    return undefined;
  }
  const error = providerErrorRecord(evidence);
  const message = error?.["message"];
  if (error === undefined || typeof message !== "string") {
    return undefined;
  }
  const secrets = credentials.get(model);
  const subscriptionTokenRejected =
    model.provider === "anthropic" &&
    error["type"] === "authentication_error" &&
    (error["code"] === undefined || error["code"] === null) &&
    secrets?.some((secret) => secret.startsWith("sk-ant-oat")) === true;
  return {
    provider: model.provider,
    code: subscriptionTokenRejected
      ? PROVIDER_SETUP_ERROR_CODE.anthropicSubscriptionToken
      : (identifyProviderSetupError({ provider: model.provider, error }) ??
        null),
    message: sanitizeCredentialText(message, secrets).text,
  };
};
