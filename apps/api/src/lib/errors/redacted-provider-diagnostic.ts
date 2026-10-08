import { Result } from "better-result";
import * as v from "valibot";

import {
  PROVIDER_SETUP_ERROR_CODE,
  type ProviderDiagnostic,
} from "@stll/api-contract/provider-setup";

import { sanitizeCredentialText } from "@/api/lib/credential-text";
import { identifyProviderSetupError } from "@/api/lib/provider-error-catalogue";
import { isRecord } from "@/api/lib/type-guards";

const credentials = new WeakMap<object, readonly string[]>();

/** The most provider error text kept for the reader, in UTF-8 bytes. */
export const PROVIDER_ERROR_TEXT_MAX_BYTES = 64 * 1024;

// Not exported: parsing through it is the only way to mint the brand, and
// only `redactProviderMessage` does, after redacting and capping the text.
const redactedProviderMessageSchema = v.pipe(
  v.string(),
  v.brand("RedactedProviderMessage"),
);

/** Provider error text that has been through the credential redactor and the size cap. */
export type RedactedProviderMessage = v.InferOutput<
  typeof redactedProviderMessageSchema
>;

/**
 * The only diagnostic the API stores, streams or answers with: its message
 * can only come from `redactProviderMessage`.
 */
export type RedactedProviderDiagnostic = Omit<ProviderDiagnostic, "message"> & {
  message: RedactedProviderMessage;
};

const capUtf8 = (text: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return new TextDecoder()
    .decode(bytes.subarray(0, maxBytes))
    .replace(/\uFFFD$/u, "");
};

/**
 * Provider error text as the reader may keep it: known credential shapes
 * and the caller's own secrets redacted, then capped. Redacting text that
 * was already redacted changes nothing, so a diagnostic read back from a
 * stream or a store passes through again on its way out.
 */
export const redactProviderMessage = (
  text: string,
  secrets: readonly string[] = [],
): RedactedProviderMessage =>
  v.parse(
    redactedProviderMessageSchema,
    capUtf8(
      sanitizeCredentialText(text, secrets).text,
      PROVIDER_ERROR_TEXT_MAX_BYTES,
    ),
  );

/** A diagnostic read back from a stream or a store, redacted again before reuse. */
export const redactedProviderDiagnostic = ({
  code,
  message,
  provider,
}: ProviderDiagnostic): RedactedProviderDiagnostic => ({
  code,
  message: redactProviderMessage(message),
  provider,
});

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
}: CreateProviderDiagnosticOptions): RedactedProviderDiagnostic | undefined => {
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
    message: redactProviderMessage(message, secrets),
  };
};
