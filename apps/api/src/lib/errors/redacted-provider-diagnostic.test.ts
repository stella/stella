import { expect, test } from "bun:test";

import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";

import { aiErrorStatusBody, aiHandlerError } from "@/api/lib/ai-error";
import { PROVIDER_SETUP_ERROR_FIXTURES } from "@/api/tests/fixtures/provider-setup-errors";

import { ProviderCallError } from "./provider-call-error";
import { createProviderCallError } from "./provider-call-failure";
import {
  createProviderDiagnostic,
  PROVIDER_ERROR_TEXT_MAX_BYTES,
  redactedProviderDiagnostic,
  redactProviderMessage,
  registerProviderDiagnosticCredentials,
} from "./redacted-provider-diagnostic";

test("every catalogue fixture reaches guidance and supported runtime adapters keep evidence private", () => {
  for (const code of Object.values(PROVIDER_SETUP_ERROR_CODE)) {
    const fixture = PROVIDER_SETUP_ERROR_FIXTURES[code];
    const model = { provider: fixture.provider, keySource: "byok" } as const;
    expect(
      createProviderDiagnostic({ model, evidence: { error: fixture.error } }),
    ).toEqual({
      provider: fixture.provider,
      code,
      message: redactProviderMessage(fixture.error.message),
    });
    // Azure setup is supported by the probe, but has no runtime text adapter.
    if (model.provider === "azure_foundry") {
      continue;
    }
    const error = createProviderCallError({
      model: { provider: model.provider, keySource: model.keySource },
      status: 502,
      evidence: { error: fixture.error },
    });
    expect(error.providerDiagnostic).toEqual({
      provider: fixture.provider,
      code,
      message: redactProviderMessage(fixture.error.message),
    });
    const mapped = aiHandlerError(error, { status: 502, message: "Fallback" });
    expect(mapped).toBeInstanceOf(ProviderCallError);
    if (mapped instanceof ProviderCallError) {
      expect(mapped.providerDiagnostic).toEqual(error.providerDiagnostic);
    }
    expect(
      aiErrorStatusBody(error, { status: 502, message: "Fallback" }).body,
    ).toMatchObject({ providerDiagnostic: error.providerDiagnostic });
    expect(JSON.stringify(error)).not.toContain(fixture.error.message);
    expect(JSON.stringify(error.toJSON())).not.toContain(fixture.error.message);
    expect(
      JSON.stringify(Object.fromEntries(Object.entries(error))),
    ).not.toContain(fixture.error.message);
  }
});

test("projects only the actual provider message, preserving unknown reasons in full", () => {
  const message = "Unknown provider reason. ".repeat(60);
  const evidence = Object.assign(
    new Error(`500 ${JSON.stringify({ error: { message } })}`),
    {
      status: 500,
      request: { body: "Request content" },
      error: { type: "new_provider_error", message },
    },
  );
  expect(
    createProviderDiagnostic({
      model: { provider: "anthropic", keySource: "byok" },
      evidence,
    }),
  ).toEqual({
    provider: "anthropic",
    code: null,
    message: redactProviderMessage(message),
  });
  expect(
    createProviderDiagnostic({
      model: { provider: "anthropic", keySource: "byok" },
      evidence: new Error("Unstructured SDK wrapper"),
    }),
  ).toBeUndefined();
});

test("AWS provider exceptions project the provider reason while ordinary errors remain private", () => {
  const evidence = Object.assign(
    new Error("Provider throttled this operation"),
    { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } },
  );
  expect(
    createProviderDiagnostic({
      model: { provider: "bedrock", keySource: "byok" },
      evidence,
    }),
  ).toEqual({
    provider: "bedrock",
    code: null,
    message: redactProviderMessage("Provider throttled this operation"),
  });
});

test("registered BYOK credentials are removed even without a recognizable prefix", () => {
  const model = { provider: "google", keySource: "byok" } as const;
  registerProviderDiagnosticCredentials(model, ["fixture-opaque-credential"]);
  expect(
    createProviderDiagnostic({
      model,
      evidence: {
        code: 403,
        message: "Key fixture-opaque-credential is denied",
      },
    })?.message,
  ).toBe(redactProviderMessage("Key [redacted-secret] is denied"));
});

test("managed provider failures retain the existing customer error surface", () => {
  expect(
    createProviderDiagnostic({
      model: { provider: "openrouter", keySource: "instance" },
      evidence: { code: 402, message: "Insufficient credits" },
    }),
  ).toBeUndefined();
});

test("persisted subscription credentials guide generic auth rejection without overriding a provider code", () => {
  const model = { provider: "anthropic", keySource: "byok" } as const;
  registerProviderDiagnosticCredentials(model, ["sk-ant-oat-fixture"]);
  const error = { type: "authentication_error", message: "Invalid x-api-key" };
  expect(createProviderDiagnostic({ model, evidence: error })?.code).toBe(
    PROVIDER_SETUP_ERROR_CODE.anthropicSubscriptionToken,
  );
  expect(
    createProviderDiagnostic({
      model,
      evidence: { ...error, code: "unknown_explicit_code" },
    })?.code,
  ).toBeNull();
});

test("SDK response bodies expose only their actual provider reason", () => {
  const message = "Unknown gateway response reason";
  const evidence = Object.assign(
    new Error("SDK wrapper includes request document"),
    {
      statusCode: 502,
      rawResponse: new Response("", { status: 502 }),
      body: JSON.stringify({ error: { code: "new_gateway_reason", message } }),
    },
  );
  expect(
    createProviderDiagnostic({
      model: { provider: "openrouter", keySource: "byok" },
      evidence,
    }),
  ).toEqual({
    provider: "openrouter",
    code: null,
    message: redactProviderMessage(message),
  });
  expect(
    createProviderDiagnostic({
      model: { provider: "openrouter", keySource: "byok" },
      evidence: new Error(
        JSON.stringify({ error: { code: "new_gateway_reason", message } }),
      ),
    }),
  ).toBeUndefined();
});

test("unknown provider error bodies without a code retain their full reason", () => {
  const message = "Unexpected provider reason without a structured code";
  expect(
    createProviderDiagnostic({
      model: { provider: "mistral", keySource: "byok" },
      evidence: { error: { message } },
    }),
  ).toEqual({
    provider: "mistral",
    code: null,
    message: redactProviderMessage(message),
  });
});

/** A provider reason carrying every credential shape a provider echoes back. */
const CREDENTIAL_LADEN_REASON = [
  "Incorrect API key provided: sk-proj-****************abcd.",
  "Retried with Bearer fixture.bearer.token-value.",
  "Endpoint https://fixture-user:fixture-password@provider.example.test/v1 refused.",
].join(" ");
const CREDENTIAL_FRAGMENTS = [
  "abcd",
  "fixture.bearer.token-value",
  "fixture-user",
  "fixture-password",
];

test("a provider reason keeps its words and loses every credential it carries", () => {
  const model = { provider: "openai", keySource: "byok" } as const;
  const message =
    createProviderDiagnostic({
      model,
      evidence: { status: 401, message: CREDENTIAL_LADEN_REASON },
    })?.message ?? "";
  expect(message).toContain("Incorrect API key provided:");
  expect(message).toContain("provider.example.test/v1 refused.");
  for (const fragment of CREDENTIAL_FRAGMENTS) {
    expect(message).not.toContain(fragment);
  }
});

test("a diagnostic read back from a stream or store is redacted again", () => {
  const { message } = redactedProviderDiagnostic({
    provider: "openai",
    code: null,
    message: CREDENTIAL_LADEN_REASON,
  });
  for (const fragment of CREDENTIAL_FRAGMENTS) {
    expect(message).not.toContain(fragment);
  }
  // Redaction is idempotent, so a second pass keeps what the first kept.
  expect(
    redactedProviderDiagnostic({ provider: "openai", code: null, message })
      .message,
  ).toBe(message);
});

test("a provider reason is capped at the diagnostic size bound", () => {
  const { message } = redactedProviderDiagnostic({
    provider: "openai",
    code: null,
    message: "é".repeat(PROVIDER_ERROR_TEXT_MAX_BYTES),
  });
  expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(
    PROVIDER_ERROR_TEXT_MAX_BYTES,
  );
  expect(message).not.toContain("\uFFFD");
  expect(message.length).toBeGreaterThan(0);
});
