import { afterEach, describe, expect, test } from "bun:test";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

const { probeProvider } = await import("@/api/lib/ai-provider-probe");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("probeProvider", () => {
  test("passes the configured Azure API version to the Foundry probe", async () => {
    const captured: {
      apiKey?: string | null;
      url?: URL;
    } = {};

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
});
