import { describe, expect, test } from "bun:test";

import {
  groupOAuthScopeDisplayEntries,
  orderOAuthScopeSummary,
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
      {
        label: "consent.scopeSearch",
        summary: "consent.summarySearch",
        group: "read",
        sensitive: false,
        type: "known",
      },
      {
        label: "consent.scopeTemplates",
        summary: "consent.summaryTemplates",
        group: "change",
        sensitive: false,
        type: "known",
      },
      {
        label: "consent.scopeOfflineAccess",
        summary: "consent.summaryOfflineAccess",
        group: "other",
        sensitive: false,
        type: "known",
      },
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
      {
        label: "consent.scopeProfile",
        summary: "consent.summaryProfile",
        group: "read",
        sensitive: false,
        type: "known",
      },
      { scope: "vendor:one", group: "other", type: "unknown" },
      { scope: "vendor:two", group: "other", type: "unknown" },
    ] satisfies OAuthScopeDisplayEntry[]);
  });

  test("summarizes deleting and administering first", () => {
    const { change } = groupOAuthScopeDisplayEntries(
      toOAuthScopeDisplayEntries([
        "stella:templates",
        "stella:matters_write",
        "stella:documents_write",
        "stella:skills",
        "stella:admin_write",
      ]),
    );
    expect(
      orderOAuthScopeSummary(change).map((entry) =>
        entry.type === "known" ? entry.summary : entry.scope,
      ),
    ).toEqual([
      "consent.summaryDocumentsWrite",
      "consent.summaryAdminWrite",
      "consent.summaryTemplates",
      "consent.summaryMattersWrite",
      "consent.summarySkills",
    ]);
  });

  test("marks every scope that deletes data or administers the organization", () => {
    const sensitive = toOAuthScopeDisplayEntries([
      "stella:documents_write",
      "stella:contacts_write",
      "stella:knowledge_write",
      "stella:billing_write",
      "stella:admin_write",
      "stella:read",
      "stella:matters_write",
    ]).filter((entry) => entry.type === "known" && entry.sensitive);
    expect(sensitive).toHaveLength(5);
  });
});
