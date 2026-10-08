import { expect, test } from "bun:test";

import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";

import { captureRedactedException } from "@/lib/analytics/stack-redaction";
import { toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";

import {
  ProviderDiagnosticError,
  providerDiagnosticFromThrown,
} from "./provider-diagnostic";

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
  expect(() =>
    toAPIError({
      status: 403,
      value: {
        message: "Refused",
        providerDiagnostic: { ...diagnostic, code: "unregistered-code" },
      },
    }),
  ).toThrow(ClientOperationError);
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
