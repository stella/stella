import { describe, expect, test } from "bun:test";

import {
  groupOAuthScopeDisplayEntries,
  toOAuthScopeDisplayEntries,
  type OAuthScopeDisplayEntry,
} from "@/lib/oauth-scopes";

describe("OAuth scope display groups", () => {
  test("groups every requested entry exactly once", () => {
    const entries = toOAuthScopeDisplayEntries([
      "stella:search",
      "stella:read",
      "stella:templates",
      "stella:skills",
      "offline_access",
      "provider:custom",
    ]);
    const grouped = groupOAuthScopeDisplayEntries(entries);
    const regrouped = Object.values(grouped).flat();

    expect(regrouped).toEqual(entries);
    expect(regrouped).toHaveLength(entries.length);
    expect(grouped.read).toHaveLength(2);
    expect(grouped.change).toHaveLength(2);
    expect(grouped.other).toHaveLength(2);
  });

  test("uses scope metadata for known groups and other for unknown scopes", () => {
    const entries = toOAuthScopeDisplayEntries([
      "stella:search",
      "stella:templates",
      "offline_access",
      "provider:custom",
      "toString",
      "__proto__",
    ]);

    expect(entries).toEqual([
      { label: "consent.scopeSearch", group: "read", type: "known" },
      { label: "consent.scopeTemplates", group: "change", type: "known" },
      { label: "consent.scopeOfflineAccess", group: "other", type: "known" },
      { scope: "provider:custom", group: "other", type: "unknown" },
      { scope: "toString", group: "other", type: "unknown" },
      { scope: "__proto__", group: "other", type: "unknown" },
    ] satisfies OAuthScopeDisplayEntry[]);
  });

  test("deduplicates shared known labels while retaining distinct unknown scopes", () => {
    const entries = toOAuthScopeDisplayEntries([
      "openid",
      "profile",
      "email",
      "vendor:one",
      "vendor:one",
      "vendor:two",
    ]);

    expect(entries).toEqual([
      { label: "consent.scopeProfile", group: "read", type: "known" },
      { scope: "vendor:one", group: "other", type: "unknown" },
      { scope: "vendor:two", group: "other", type: "unknown" },
    ] satisfies OAuthScopeDisplayEntry[]);
  });
});
