import { Result, TaggedError } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realSafeFetch from "@/api/lib/safe-outbound-fetch";
import type {
  SafeOutboundFetchBody,
  SafeOutboundFetchError,
  SafeOutboundFetchResponse,
  SafeOutboundHeaders,
} from "@/api/lib/safe-outbound-fetch";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";
process.env["AZURE_API_VERSION"] = "";
process.env["AI_DEVTOOLS_ENABLED"] = "";

class MockSafeOutboundFetchError extends TaggedError("SafeOutboundFetchError")<{
  cause?: unknown;
  message: string;
}>() {}

type SafeOutboundFetchCall = {
  url: URL;
  headers: Headers;
  method: string;
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
  calls.push({ url, headers, method: opts.method ?? "GET" });

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

void mock.module("@/api/lib/safe-outbound-fetch", () => ({
  ...realSafeFetch,
  safeOutboundFetchBytes: mockSafeOutboundFetchBytes,
}));

const { probeProvider } = await import("@/api/lib/ai-provider-probe");

beforeEach(() => {
  calls.length = 0;
  nextResponse = {
    kind: "ok",
    status: 200,
    body: { object: "list", data: [] },
  };
});

afterEach(() => {
  mock.restore();
});

describe("probeProvider", () => {
  test("passes the configured Azure API version to the Foundry probe", async () => {
    const result = await probeProvider(
      "azure_foundry",
      "azure-key",
      "https://example.openai.azure.com/openai/v1",
      "2024-06-01",
    );

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
    const result = await probeProvider(
      "azure_foundry",
      "azure-key",
      "https://example.openai.azure.com/openai/v1",
    );

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
    nextResponse = {
      kind: "ok",
      status: 200,
      body: { object: "list", data: [{ id: "gpt-5-chat" }] },
    };

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
    nextResponse = { kind: "ok", status: 200, body: "not-an-object" };

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

  test("Azure probe surfaces a non-2xx response with the upstream detail", async () => {
    nextResponse = {
      kind: "ok",
      status: 401,
      body: { error: { message: "Invalid API key" } },
    };

    const result = await probeProvider(
      "azure_foundry",
      "azure-key",
      "https://example.openai.azure.com/openai/v1",
    );

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
      await probeProvider(
        "azure_foundry",
        "azure-key",
        "https://example.openai.azure.com/openai/v1",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof Error).toBe(true);
    if (caught instanceof Error) {
      expect(caught.message).toBe("URL host is not allowed");
    }
  });

  test("Bearer provider returns valid on 2xx", async () => {
    const result = await probeProvider("openai", "sk-test");

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

    const result = await probeProvider("anthropic", "bad-key");

    expect(result).toEqual({
      valid: false,
      error: "Anthropic rejected the key (HTTP 401): invalid_api_key",
    });
  });
});
