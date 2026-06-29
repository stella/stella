import { describe, expect, test } from "bun:test";

import { maskWebSearchKey } from "@/api/lib/web-search/keys";
import type { WebSearchDeployConfig } from "@/api/lib/web-search/select-provider";
import { resolveWebSearchProviders } from "@/api/lib/web-search/select-provider";

const deploy = (
  overrides: Partial<WebSearchDeployConfig> = {},
): WebSearchDeployConfig => ({
  featureEnabled: true,
  searchProvider: "tavily",
  fetchProvider: "jina",
  platformSearchApiKey: undefined,
  platformFetchApiKey: undefined,
  ...overrides,
});

describe("resolveWebSearchProviders", () => {
  test("feature flag off disables both providers even with keys", () => {
    const resolved = resolveWebSearchProviders(
      deploy({ featureEnabled: false, platformSearchApiKey: "platform" }),
      { searchApiKey: "org" },
    );
    expect(resolved.webSearchProvider).toBeNull();
    expect(resolved.urlFetcher).toBeNull();
  });

  test("org search key enables search when the provider is selected", () => {
    const resolved = resolveWebSearchProviders(deploy(), {
      searchApiKey: "org-tavily",
    });
    expect(resolved.webSearchProvider?.name).toBe("tavily");
  });

  test("platform key is the fallback when the org has no key", () => {
    const resolved = resolveWebSearchProviders(
      deploy({ platformSearchApiKey: "platform-tavily" }),
    );
    expect(resolved.webSearchProvider?.name).toBe("tavily");
  });

  test("search is unavailable when neither an org nor platform key exists", () => {
    expect(resolveWebSearchProviders(deploy()).webSearchProvider).toBeNull();
  });

  test("no search provider selected means no search even with a key", () => {
    const resolved = resolveWebSearchProviders(
      deploy({ searchProvider: undefined }),
      { searchApiKey: "org" },
    );
    expect(resolved.webSearchProvider).toBeNull();
  });

  test("jina fetcher is available keyless once the provider is selected", () => {
    expect(resolveWebSearchProviders(deploy()).urlFetcher?.name).toBe("jina");
  });

  test("no fetch provider selected means no url fetcher", () => {
    expect(
      resolveWebSearchProviders(deploy({ fetchProvider: undefined }))
        .urlFetcher,
    ).toBeNull();
  });
});

describe("maskWebSearchKey", () => {
  test("exposes only the first 8 chars and never the tail", () => {
    const masked = maskWebSearchKey("tvly-abcdef0123456789");
    expect(masked.startsWith("tvly-abc")).toBe(true);
    expect(masked).not.toContain("def0123456789");
    expect(masked).toContain("****************");
  });
});
