import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTranslator } from "use-intl";
import * as v from "valibot";

import en from "@/i18n/langs/en.json";
import {
  groupOAuthScopeDisplayEntries,
  orderOAuthScopeSummary,
  toOAuthScopeDisplayEntries,
  translateOAuthScopeSummary,
  type OAuthScopeDisplayEntry,
} from "@/lib/oauth-scopes";

describe("OAuth scope display groups", () => {
  test("groups every requested entry exactly once", () => {
    const entries = toOAuthScopeDisplayEntries([
      "stella:search",
      "stella:read",
      "stella:law_read",
      "stella:templates",
      "stella:skills",
      "offline_access",
      "provider:custom",
    ]);
    const grouped = groupOAuthScopeDisplayEntries(entries);
    const regrouped = Object.values(grouped).flat();

    expect(regrouped).toEqual(entries);
    expect(regrouped).toHaveLength(entries.length);
    expect(grouped.read).toHaveLength(3);
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
        sensitive: true,
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

  test("discloses public legal research as translated read access", () => {
    const entries = toOAuthScopeDisplayEntries(["stella:law_read"]);
    expect(entries).toEqual([
      {
        label: "consent.scopeLawRead",
        summary: "consent.summaryLawRead",
        group: "read",
        sensitive: false,
        type: "known",
      },
    ] satisfies OAuthScopeDisplayEntry[]);
    expect(
      entries.map((entry) => translateOAuthScopeSummary((key) => key, entry)),
    ).toEqual(["consent.summaryLawRead"]);
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
        "stella:onboarding",
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
      "consent.summaryTemplates",
      "consent.summaryMattersWrite",
      "consent.summaryDocumentsWrite",
      "consent.summarySkills",
      "consent.summaryAdminWrite",
      "consent.summaryOnboarding",
    ]);
  });

  test("every destructive capability scope discloses sensitive access and deletion", () => {
    const catalog = path.resolve(
      import.meta.dir,
      "../../../../packages/cli/capabilities",
    );
    const capabilitySchema = v.object({
      scope: v.string(),
      destructive: v.boolean(),
    });
    const destructiveScopes = new Set<string>();
    for (const file of new Bun.Glob("*.json").scanSync({ cwd: catalog })) {
      const capability = v.parse(
        capabilitySchema,
        JSON.parse(readFileSync(path.join(catalog, file), "utf-8")),
      );
      if (capability.destructive) {
        destructiveScopes.add(capability.scope);
      }
    }
    expect(destructiveScopes.size).toBeGreaterThan(0);
    for (const scope of destructiveScopes) {
      const [entry] = toOAuthScopeDisplayEntries([scope]);
      expect(entry?.type).toBe("known");
      if (entry?.type !== "known") {
        continue;
      }
      expect(entry.sensitive).toBe(true);
      const t = createTranslator({ locale: "en", messages: en });
      expect(translateOAuthScopeSummary(t, entry)).toContain("delet");
    }
  });
});
