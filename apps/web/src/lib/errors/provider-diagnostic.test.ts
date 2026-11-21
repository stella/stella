import { Result } from "better-result";
import { expect, expectTypeOf, test } from "bun:test";

import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";

import { captureRedactedException } from "@/lib/analytics/stack-redaction";
import { shouldRetryAPIRequest, toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";

import {
  ProviderDiagnosticError,
  providerDiagnosticFromThrown,
} from "./provider-diagnostic";
import type { ProviderSetupGuidance } from "./provider-setup-guidance";

const diagnostic = {
  provider: "anthropic",
  code: PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired,
  message: "Full provider reason with account context",
} satisfies ProviderDiagnostic;

test("HTTP diagnostics are validated once and retained as typed error data", () => {
  const error = toAPIError({
    status: 403,
    value: {
      message: "provider_credentials_rejected",
      providerDiagnostic: diagnostic,
    },
  });
  expect(providerDiagnosticFromThrown(error)).toEqual(diagnostic);
  expect(
    providerDiagnosticFromThrown(new Error("wrapped", { cause: error })),
  ).toEqual(diagnostic);
});

test("malformed HTTP diagnostic is rejected before it reaches rendering", () => {
  const outcome = Result.try({
    try: () =>
      toAPIError({
        status: 403,
        value: {
          message: "Refused",
          providerDiagnostic: { ...diagnostic, code: "unregistered-code" },
        },
      }),
    catch: (error) => error,
  });
  expect(outcome.status).toBe("error");
  if (outcome.status !== "error") {
    throw new TypeError("Expected rejected diagnostic");
  }
  const rejected = outcome.error;
  expect(ClientOperationError.is(rejected)).toBe(true);
  if (!ClientOperationError.is(rejected)) {
    throw new TypeError("Expected ClientOperationError");
  }
  expect(rejected.action).toBe("parse-provider-diagnostic");
  expect(rejected.message).toBe("Invalid provider diagnostic response");
  expect(shouldRetryAPIRequest(0, rejected)).toBe(false);
});

test("unknown provider diagnostics keep the complete reason without a catalogue code", () => {
  const unknown = {
    ...diagnostic,
    code: null,
    message: "A full unknown reason\nwith additional details.",
  };
  const error = toAPIError({
    status: 400,
    value: { message: "Refused", providerDiagnostic: unknown },
  });
  expect(providerDiagnosticFromThrown(error)).toEqual(unknown);
});

test("telemetry drops provider diagnostic messages and payloads", () => {
  const error = new ProviderDiagnosticError({
    message: "provider_credentials_rejected",
    diagnostic,
  });
  const reported: Error[] = [];
  captureRedactedException(error, (redacted) => {
    reported.push(redacted);
  });
  const redacted = reported.at(0);
  expect(redacted).toBeDefined();
  expect(redacted?.message).toBe("");
  expect(JSON.stringify(redacted)).not.toContain(diagnostic.message);
  expect(JSON.stringify(redacted)).not.toContain("diagnostic");
  expect(redacted?.stack ?? "").not.toContain(diagnostic.message);
});

test("guidance keys are checked against the organization.aiConfig catalogue", () => {
  expectTypeOf<"notAProviderGuidanceKey">().not.toExtend<
    ProviderSetupGuidance["guidance"]
  >();
  expectTypeOf<"notAProviderLinkLabel">().not.toExtend<
    ProviderSetupGuidance["linkLabel"]
  >();
});
