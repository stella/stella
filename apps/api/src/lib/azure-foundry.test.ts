import { describe, expect, test } from "bun:test";

import { normalizeAzureFoundryBaseURL } from "@/api/lib/azure-foundry";

describe("Azure Foundry endpoint normalization", () => {
  test("normalizes Azure OpenAI resource endpoints for the AI SDK Azure provider", () => {
    expect(
      normalizeAzureFoundryBaseURL(
        "https://example.openai.azure.com/openai/v1/",
      ),
    ).toEqual({
      ok: true,
      baseURL: "https://example.openai.azure.com/openai",
    });

    expect(
      normalizeAzureFoundryBaseURL("https://example.openai.azure.com/"),
    ).toEqual({
      ok: true,
      baseURL: "https://example.openai.azure.com/openai",
    });
  });

  test("normalizes Azure Foundry project endpoints", () => {
    expect(
      normalizeAzureFoundryBaseURL(
        "https://example.services.ai.azure.com/api/projects/customer-matter",
      ),
    ).toEqual({
      ok: true,
      baseURL:
        "https://example.services.ai.azure.com/api/projects/customer-matter/openai",
    });
  });

  test("rejects unsafe or unrelated endpoints", () => {
    expect(
      normalizeAzureFoundryBaseURL("http://example.com/openai/v1"),
    ).toEqual({
      ok: false,
      error: "Endpoint must use HTTPS",
    });
    expect(normalizeAzureFoundryBaseURL("https://example.com/models")).toEqual({
      ok: false,
      error:
        "Endpoint must be an Azure OpenAI /openai/v1 endpoint or an Azure Foundry project endpoint",
    });
    expect(normalizeAzureFoundryBaseURL("https://example.com/")).toEqual({
      ok: false,
      error:
        "Endpoint must include /openai/v1 unless it is an Azure OpenAI resource host",
    });
  });
});
