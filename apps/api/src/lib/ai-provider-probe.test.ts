import { afterEach, describe, expect, test } from "bun:test";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";
process.env["AZURE_API_VERSION"] = "";

const { probeProvider } = await import("@/api/lib/ai-provider-probe");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("probeProvider", () => {
  test("passes the configured Azure API version to the Foundry probe", async () => {
    const captured = captureAzureProbeRequest();

    const result = await probeProvider(
      "azure_foundry",
      "azure-key",
      "https://example.openai.azure.com/openai/v1",
      "2024-06-01",
    );

    expect(result).toEqual({ valid: true });
    expect(captured.url?.pathname).toBe("/openai/v1/models");
    expect(captured.url?.searchParams.get("api-version")).toBe("2024-06-01");
    expect(captured.apiKey).toBe("azure-key");
  });

  test("uses the Azure default API version when none is configured", async () => {
    const captured = captureAzureProbeRequest();

    const result = await probeProvider(
      "azure_foundry",
      "azure-key",
      "https://example.openai.azure.com/openai/v1",
    );

    expect(result).toEqual({ valid: true });
    expect(captured.url?.searchParams.get("api-version")).toBe("v1");
  });

  test("Azure probe accepts when every expected deployment is listed", async () => {
    mockAzureListModelsResponse([
      { id: "gpt-5-chat" },
      { id: "gpt-5-mini" },
      { id: "gpt-5-reasoning" },
    ]);

    const result = await probeProvider(
      "azure_foundry",
      "azure-key",
      "https://example.openai.azure.com/openai/v1",
      undefined,
      ["gpt-5-chat", "gpt-5-mini"],
    );

    expect(result).toEqual({ valid: true });
  });

  test("Azure probe rejects when an expected deployment is missing", async () => {
    mockAzureListModelsResponse([{ id: "gpt-5-chat" }]);

    const result = await probeProvider(
      "azure_foundry",
      "azure-key",
      "https://example.openai.azure.com/openai/v1",
      undefined,
      ["gpt-5-chat", "typo-deployment"],
    );

    expect(result).toEqual({
      valid: false,
      error: "Azure Foundry deployment not found: typo-deployment",
    });
  });

  test("Azure probe treats a malformed list-models body as zero deployments", async () => {
    mockAzureListModelsResponse("not-an-object");

    const result = await probeProvider(
      "azure_foundry",
      "azure-key",
      "https://example.openai.azure.com/openai/v1",
      undefined,
      ["any-deployment"],
    );

    expect(result).toEqual({
      valid: false,
      error: "Azure Foundry deployment not found: any-deployment",
    });
  });
});

type CapturedAzureProbeRequest = {
  apiKey?: string | null;
  url?: URL;
};

const mockAzureListModelsResponse = (data: unknown): void => {
  const body = Array.isArray(data)
    ? JSON.stringify({ object: "list", data })
    : JSON.stringify(data);
  const mockFetch: typeof fetch = Object.assign(
    async () => new Response(body, { status: 200 }),
    { preconnect: originalFetch.preconnect },
  );
  globalThis.fetch = mockFetch;
};

const captureAzureProbeRequest = (): CapturedAzureProbeRequest => {
  const captured: CapturedAzureProbeRequest = {};
  const mockFetch: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      captured.url = new URL(url);
      captured.apiKey = new Headers(init?.headers).get("api-key");
      return new Response("{}", { status: 200 });
    },
    {
      preconnect: originalFetch.preconnect,
    },
  );
  globalThis.fetch = mockFetch;
  return captured;
};
