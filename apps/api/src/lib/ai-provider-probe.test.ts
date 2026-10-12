import { Result, TaggedError } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import type { ProbeProviderOptions } from "@/api/lib/ai-provider-probe";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type {
  SafeOutboundFetchBody,
  SafeOutboundFetchError,
  SafeOutboundFetchResponse,
  SafeOutboundHeaders,
} from "@/api/lib/safe-outbound-fetch";
import { PROVIDER_SETUP_ERROR_FIXTURES } from "@/api/tests/fixtures/provider-setup-errors";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";
process.env["AZURE_API_VERSION"] = "";

class MockSafeOutboundFetchError extends TaggedError("SafeOutboundFetchError")<{
  cause?: unknown;
  message: string;
}> {}

type SafeOutboundFetchCall = {
  url: URL;
  headers: Headers;
  method: string;
  maxBytes: number;
};

type MockResponse =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "error"; message: string };

let nextResponse: MockResponse = {
  kind: "ok",
  status: 200,
  body: { object: "list", data: [] },
};
const calls: SafeOutboundFetchCall[] = [];

const mockSafeOutboundFetchBytes = async (opts: {
  body?: SafeOutboundFetchBody;
  headers?: SafeOutboundHeaders;
  maxBytes: number;
  method?: string;
  timeoutMs: number;
  url: string | URL;
}): Promise<Result<SafeOutboundFetchResponse, SafeOutboundFetchError>> => {
  const url = opts.url instanceof URL ? opts.url : new URL(opts.url);
  const headers = new Headers(opts.headers);
  calls.push({
    url,
    headers,
    method: opts.method ?? "GET",
    maxBytes: opts.maxBytes,
  });

  if (nextResponse.kind === "error") {
    return Result.err(
      new MockSafeOutboundFetchError({ message: nextResponse.message }),
    );
  }

  const bodyBytes = new TextEncoder().encode(
    typeof nextResponse.body === "string"
      ? nextResponse.body
      : JSON.stringify(nextResponse.body),
  );
  if (bodyBytes.byteLength > opts.maxBytes) {
    return Result.err(
      new MockSafeOutboundFetchError({
        message: "Response exceeds transport limit",
      }),
    );
  }
  return Result.ok({
    body: bodyBytes.buffer.slice(
      bodyBytes.byteOffset,
      bodyBytes.byteOffset + bodyBytes.byteLength,
    ),
    headers: new Headers({ "content-type": "application/json" }),
    ok: nextResponse.status >= 200 && nextResponse.status < 300,
    status: nextResponse.status,
  });
};

const { probeProvider: probeProviderImpl } =
  await import("@/api/lib/ai-provider-probe");

const probeProvider = async (
  options: Omit<ProbeProviderOptions, "fetchBytes" | "permit">,
) =>
  await probeProviderImpl({
    ...options,
    fetchBytes: mockSafeOutboundFetchBytes,
    permit: grantThirdPartyOutboundPermit(),
  });

beforeEach(() => {
  calls.length = 0;
  nextResponse = {
    kind: "ok",
    status: 200,
    body: { object: "list", data: [] },
  };
});

describe("probeProvider", () => {
  test("probes OpenRouter authentication through the EU endpoint", async () => {
    expect(
      await probeProvider({
        provider: "openrouter",
        apiKey: "test-org-key",
      }),
    ).toEqual({
      valid: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.url.href).toBe(
      "https://eu.openrouter.ai/api/v1/auth/key",
    );
    expect(calls.at(0)?.headers.get("authorization")).toBe(
      "Bearer test-org-key",
    );
  });

  test("passes the configured Azure API version to the Foundry probe", async () => {
    const result = await probeProvider({
      provider: "azure_foundry",
      apiKey: "azure-key",
      endpoint: "https://example.openai.azure.com/openai/v1",
      apiVersion: "2024-06-01",
    });

    expect(result).toEqual({ valid: true });
    const call = calls.at(0);
    if (!call) {
      throw new Error("expected a captured request");
    }
    expect(call.url.pathname).toBe("/openai/v1/models");
    expect(call.url.searchParams.get("api-version")).toBe("2024-06-01");
    expect(call.headers.get("api-key")).toBe("azure-key");
  });

  test("uses the Azure default API version when none is configured", async () => {
    const result = await probeProvider({
      provider: "azure_foundry",
      apiKey: "azure-key",
      endpoint: "https://example.openai.azure.com/openai/v1",
    });

    expect(result).toEqual({ valid: true });
    const call = calls.at(0);
    if (!call) {
      throw new Error("expected a captured request");
    }
    expect(call.url.searchParams.get("api-version")).toBe("v1");
  });

  test("Azure probe accepts when every expected deployment is listed", async () => {
    nextResponse = {
      kind: "ok",
      status: 200,
      body: {
        object: "list",
        data: [
          { id: "gpt-5-chat" },
          { id: "gpt-5-mini" },
          { id: "gpt-5-reasoning" },
        ],
      },
    };

    const result = await probeProvider({
      provider: "azure_foundry",
      apiKey: "azure-key",
      endpoint: "https://example.openai.azure.com/openai/v1",
      expectedAzureDeployments: ["gpt-5-chat", "gpt-5-mini"],
    });

    expect(result).toEqual({ valid: true });
  });

  test("Azure probe rejects when an expected deployment is missing", async () => {
    nextResponse = {
      kind: "ok",
      status: 200,
      body: { object: "list", data: [{ id: "gpt-5-chat" }] },
    };

    const result = await probeProvider({
      provider: "azure_foundry",
      apiKey: "azure-key",
      endpoint: "https://example.openai.azure.com/openai/v1",
      expectedAzureDeployments: ["gpt-5-chat", "typo-deployment"],
    });

    expect(result).toEqual({
      valid: false,
      error: "Azure Foundry deployment not found: typo-deployment",
    });
  });

  test("Azure probe treats a malformed list-models body as zero deployments", async () => {
    nextResponse = { kind: "ok", status: 200, body: "not-an-object" };

    const result = await probeProvider({
      provider: "azure_foundry",
      apiKey: "azure-key",
      endpoint: "https://example.openai.azure.com/openai/v1",
      expectedAzureDeployments: ["any-deployment"],
    });

    expect(result).toEqual({
      valid: false,
      error: "Azure Foundry deployment not found: any-deployment",
    });
  });

  test("Azure probe surfaces a non-2xx response with the upstream detail", async () => {
    nextResponse = {
      kind: "ok",
      status: 401,
      body: { error: { message: "Invalid API key" } },
    };

    const result = await probeProvider({
      provider: "azure_foundry",
      apiKey: "azure-key",
      endpoint: "https://example.openai.azure.com/openai/v1",
    });

    expect(result).toEqual({
      valid: false,
      error:
        "Azure Foundry rejected the key or endpoint (HTTP 401): Invalid API key",
    });
  });

  test("Azure probe propagates outbound fetch errors", async () => {
    nextResponse = { kind: "error", message: "URL host is not allowed" };

    let caught: unknown;
    try {
      await probeProvider({
        provider: "azure_foundry",
        apiKey: "azure-key",
        endpoint: "https://example.openai.azure.com/openai/v1",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof Error).toBe(true);
    if (caught instanceof Error) {
      expect(caught.message).toBe("URL host is not allowed");
    }
  });

  test("Hugging Face probe calls the endpoint models route with bearer auth", async () => {
    const result = await probeProvider({
      provider: "huggingface",
      apiKey: "hf-test",
      endpoint: "https://example.endpoints.huggingface.cloud/v1/",
    });

    expect(result).toEqual({ valid: true });
    const call = calls.at(0);
    if (!call) {
      throw new Error("expected a captured request");
    }
    expect(call.url.toString()).toBe(
      "https://example.endpoints.huggingface.cloud/v1/models",
    );
    expect(call.headers.get("authorization")).toBe("Bearer hf-test");
  });

  test("Hugging Face probe rejects missing endpoint", async () => {
    const result = await probeProvider({
      provider: "huggingface",
      apiKey: "hf-test",
    });

    expect(result).toEqual({
      valid: false,
      error: "Hugging Face endpoint is required",
    });
  });

  test("Hugging Face probe rejects unsafe endpoint shape before fetch", async () => {
    const result = await probeProvider({
      provider: "huggingface",
      apiKey: "hf-test",
      endpoint: "http://localhost:8080/v1",
    });

    expect(result).toEqual({
      valid: false,
      error: "Hugging Face endpoint must use HTTPS",
    });
    expect(calls).toHaveLength(0);
  });

  test("Hugging Face probe surfaces a non-2xx response with upstream detail", async () => {
    nextResponse = {
      kind: "ok",
      status: 401,
      body: { error: { message: "Invalid token" } },
    };

    const result = await probeProvider({
      provider: "huggingface",
      apiKey: "hf-test",
      endpoint: "https://example.endpoints.huggingface.cloud/v1",
    });

    expect(result).toEqual({
      valid: false,
      error:
        "Hugging Face rejected the key or endpoint (HTTP 401): Invalid token",
    });
  });

  test("Bearer provider returns valid on 2xx", async () => {
    const result = await probeProvider({
      provider: "openai",
      apiKey: "sk-test",
    });

    expect(result).toEqual({ valid: true });
    const call = calls.at(0);
    if (!call) {
      throw new Error("expected a captured request");
    }
    expect(call.url.toString()).toBe("https://api.openai.com/v1/models");
    expect(call.headers.get("authorization")).toBe("Bearer sk-test");
  });

  test("Bearer provider surfaces a non-2xx response with the upstream detail", async () => {
    nextResponse = {
      kind: "ok",
      status: 401,
      body: { error: "invalid_api_key" },
    };

    const result = await probeProvider({
      provider: "anthropic",
      apiKey: "bad-key",
    });

    expect(result).toEqual({
      valid: false,
      error: "Anthropic rejected the key (HTTP 401): invalid_api_key",
    });
  });
});

describe("Anthropic workspace-scoped provider checks", () => {
  test("checks a user key with the workspace header without generation", async () => {
    expect(
      await probeProvider({
        provider: "anthropic",
        apiKey: "sk-ant-usr-fixture",
        anthropicWorkspaceId: "wrk_fixture",
      }),
    ).toEqual({ valid: true });
    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.url.pathname).toBe("/v1/models");
    expect(calls.at(0)?.method).toBe("GET");
    expect(calls.at(0)?.headers.get("anthropic-workspace-id")).toBe(
      "wrk_fixture",
    );
    expect(calls.at(0)?.headers.get("x-api-key")).toBe("sk-ant-usr-fixture");
  });

  test("returns the full provider diagnostic and typed workspace guidance", async () => {
    const message =
      "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.";
    nextResponse = {
      kind: "ok",
      status: 400,
      body: {
        type: "error",
        error: { type: "invalid_request_error", message },
      },
    };
    expect(
      await probeProvider({
        provider: "anthropic",
        apiKey: "sk-ant-usr-fixture",
      }),
    ).toEqual({
      valid: false,
      code: "ai_config_anthropic_workspace_required",
      error: `Anthropic rejected the key (HTTP 400): ${message}`,
    });
    expect(calls.at(0)?.url.pathname).toBe("/v1/models");
  });

  test("keeps workspace-scoped keys unchanged", async () => {
    expect(
      await probeProvider({
        provider: "anthropic",
        apiKey: "sk-ant-api03-fixture",
      }),
    ).toEqual({ valid: true });
    expect(calls.at(0)?.headers.has("anthropic-workspace-id")).toBe(false);
  });

  test("keeps long unknown provider diagnostics in full", async () => {
    const message = "Provider diagnostic ".repeat(40);
    nextResponse = {
      kind: "ok",
      status: 401,
      body: { error: { type: "authentication_error", message } },
    };
    expect(
      await probeProvider({
        provider: "anthropic",
        apiKey: "sk-ant-api03-fixture",
      }),
    ).toEqual({
      valid: false,
      error: `Anthropic rejected the key (HTTP 401): ${message}`,
    });
  });

  test("sends Google keys in a header rather than the URL", async () => {
    await probeProvider({ provider: "google", apiKey: "google-fixture-key" });
    expect(calls.at(0)?.url.search).toBe("");
    expect(calls.at(0)?.headers.get("x-goog-api-key")).toBe(
      "google-fixture-key",
    );
  });
});

test("provider diagnostics retain their full reason while echoed keys are removed", async () => {
  const apiKey = "fixture-key-without-provider-prefix";
  const message = `Key ${apiKey} rejected. ${"Provider reason ".repeat(40)}`;
  nextResponse = {
    kind: "ok",
    status: 401,
    body: { error: { type: "authentication_error", message } },
  };
  const result = await probeProvider({ provider: "anthropic", apiKey });
  expect(result).toEqual({
    valid: false,
    error: `Anthropic rejected the key (HTTP 401): ${message.replace(apiKey, "[redacted-secret]")}`,
  });
});

test("provider transport is bounded without shortening accepted diagnostic text", async () => {
  const message = "Neutral full provider diagnostic ".repeat(1000);
  nextResponse = { kind: "ok", status: 400, body: { error: { message } } };
  const result = await probeProvider({
    provider: "openai",
    apiKey: "fixture-key",
  });
  expect(calls.at(0)?.maxBytes).toBe(1_000_000);
  expect(result).toMatchObject({
    valid: false,
    error: expect.stringContaining(message),
  });
});

const largeModelListOptions = [
  { provider: "openai", apiKey: "fixture-key" },
  { provider: "google", apiKey: "fixture-key" },
  { provider: "bedrock", apiKey: "fixture-key" },
  { provider: "mistral", apiKey: "fixture-key" },
  { provider: "anthropic", apiKey: "fixture-key" },
  { provider: "openrouter", apiKey: "fixture-key" },
  {
    provider: "azure_foundry",
    apiKey: "fixture-key",
    endpoint: "https://example.openai.azure.com/openai/v1",
    expectedAzureDeployments: ["fixture-deployment"],
  },
  {
    provider: "huggingface",
    apiKey: "fixture-key",
    endpoint: "https://example.endpoints.huggingface.cloud/v1",
  },
] as const satisfies readonly Omit<
  ProbeProviderOptions,
  "fetchBytes" | "permit"
>[];

const assertLargeModelList = async (
  options: Omit<ProbeProviderOptions, "fetchBytes" | "permit">,
) => {
  const body = {
    data: [
      {
        id: "fixture-deployment",
        description: "Model details ".repeat(10_000),
      },
    ],
  };
  expect(
    new TextEncoder().encode(JSON.stringify(body)).byteLength,
  ).toBeGreaterThan(64 * 1024);
  nextResponse = { kind: "ok", status: 200, body };
  expect(await probeProvider(options)).toEqual({ valid: true });
  expect(calls.at(0)?.maxBytes).toBe(1_000_000);
};

const assertOversizedError = async (
  options: Omit<ProbeProviderOptions, "fetchBytes" | "permit">,
) => {
  const message = "Neutral provider diagnostic ".repeat(3000);
  nextResponse = { kind: "ok", status: 400, body: { error: { message } } };
  const result = await probeProvider(options);
  expect(JSON.stringify(result)).not.toContain("Neutral provider diagnostic");
  expect(result).toMatchObject({
    valid: false,
    error: expect.stringContaining("exceeding the 64 KiB diagnostic limit"),
  });
};

for (const options of largeModelListOptions) {
  test(`accepts successful model lists above 64 KiB for ${options.provider}`, async () =>
    assertLargeModelList(options));
  test(`refuses oversized error diagnostics without truncation for ${options.provider}`, async () =>
    assertOversizedError(options));
}

test("retains a full short diagnostic from a large error response", async () => {
  const message = "The configured project does not have access to this model.";
  const body = {
    error: { message, metadata: "Neutral error metadata ".repeat(5000) },
  };
  expect(
    new TextEncoder().encode(JSON.stringify(body)).byteLength,
  ).toBeGreaterThan(64 * 1024);
  nextResponse = { kind: "ok", status: 403, body };
  expect(
    await probeProvider({ provider: "openai", apiKey: "fixture-key" }),
  ).toEqual({
    valid: false,
    error: `OpenAI rejected the key (HTTP 403): ${message}`,
  });
});

type ProbeCatalogueFixture =
  (typeof PROVIDER_SETUP_ERROR_FIXTURES)[keyof typeof PROVIDER_SETUP_ERROR_FIXTURES];

const assertCatalogueProbe = async (
  code: string,
  fixture: ProbeCatalogueFixture,
) => {
  nextResponse = {
    kind: "ok",
    status: 400,
    body:
      fixture.provider === "bedrock" ? fixture.error : { error: fixture.error },
  };
  const result = await probeProvider({
    provider: fixture.provider,
    apiKey:
      code === "ai_config_anthropic_subscription_token"
        ? "sk-ant-oat-fixture"
        : "fixture-key",
    ...(fixture.provider === "azure_foundry"
      ? { endpoint: "https://fixture.openai.azure.com" }
      : {}),
  });
  expect(result).toMatchObject({ valid: false, code });
  if (result.valid) {
    throw new TypeError("Expected fixture rejection");
  }
  if (code !== "ai_config_anthropic_subscription_token") {
    expect(result.error).toContain(fixture.error.message);
  }
};

for (const [code, fixture] of Object.entries(PROVIDER_SETUP_ERROR_FIXTURES)) {
  test(`probe returns catalogue code ${code} with its full provider reason`, async () => {
    await assertCatalogueProbe(code, fixture);
  });
}
