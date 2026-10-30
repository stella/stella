import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTranslator } from "use-intl";
import * as v from "valibot";

import {
  MCP_ADVANCED_RESOURCE_SCOPES,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_OAUTH_PROTOCOL_SCOPES,
} from "@stll/api-contract";

import en from "@/i18n/langs/en.json";
import {
  groupOAuthScopeDisplayEntries,
  groupOAuthScopeSummaryEntries,
  type OAuthScopeDisplayEntry,
  toOAuthScopeDisplayEntries,
  translateOAuthScopeSummary,
} from "@/lib/oauth-scopes";

describe("OAuth scope display groups", () => {
  test("discloses every scope in each resource grant using translated consent copy", () => {
    const translate = createTranslator({ locale: "en", messages: en });
    for (const scopes of [
      MCP_DEFAULT_RESOURCE_SCOPES,
      MCP_ADVANCED_RESOURCE_SCOPES,
    ]) {
      const entries = toOAuthScopeDisplayEntries(scopes);
      expect(entries).toHaveLength(scopes.length);
      for (const entry of entries) {
        expect(entry.type).toBe("known");
        if (entry.type !== "known") {
          throw new TypeError("Resource scope lacks consent copy");
        }
        expect(translate(entry.label)).not.toBe(entry.label);
        expect(translate(entry.summary)).not.toBe(entry.summary);
      }
    }
    expect(
      toOAuthScopeDisplayEntries(MCP_DEFAULT_RESOURCE_SCOPES).map((entry) =>
        entry.type === "known" ? entry.label : entry.scope,
      ),
    ).not.toContain("consent.scopeChat");
    expect(
      toOAuthScopeDisplayEntries(MCP_DEFAULT_RESOURCE_SCOPES).map((entry) =>
        entry.type === "known" ? entry.label : entry.scope,
      ),
    ).not.toContain("consent.scopeSkills");
  });

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
        summaryGroup: "read",
        sensitive: false,
        type: "known",
      },
      {
        label: "consent.scopeTemplates",
        summary: "consent.summaryTemplates",
        group: "change",
        summaryGroup: "use",
        sensitive: true,
        type: "known",
      },
      {
        label: "consent.scopeOfflineAccess",
        summary: "consent.summaryStaySignedIn",
        group: "other",
        summaryGroup: "other",
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
        summaryGroup: "read",
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
        summaryGroup: "read",
        sensitive: false,
        type: "known",
      },
      { scope: "vendor:one", group: "other", type: "unknown" },
      { scope: "vendor:two", group: "other", type: "unknown" },
    ] satisfies OAuthScopeDisplayEntry[]);
  });

  test("every grantable scope contributes to exactly one summary line without duplicates", () => {
    const scopes = [
      ...MCP_ADVANCED_RESOURCE_SCOPES,
      ...MCP_ANONYMIZED_RESOURCE_SCOPES,
      ...MCP_OAUTH_PROTOCOL_SCOPES,
    ];
    for (const scope of scopes) {
      const entries = toOAuthScopeDisplayEntries([scope, scope]);
      expect(entries).toHaveLength(1);
      expect(entries.at(0)?.type).toBe("known");
      expect(
        Object.values(groupOAuthScopeSummaryEntries(entries)).flat(),
      ).toEqual(entries);
    }
    const entries = toOAuthScopeDisplayEntries([
      ...scopes,
      ...scopes,
      "vendor:custom",
      "vendor:custom",
    ]);
    const groups = groupOAuthScopeSummaryEntries(entries);
    const regrouped = Object.values(groups).flat();
    expect(new Set(regrouped).size).toBe(entries.length);
    expect(new Set(regrouped)).toEqual(new Set(entries));
    expect(Object.values(groups)).toHaveLength(4);
    expect(
      groups.use.map((entry) =>
        entry.type === "known" ? entry.label : entry.scope,
      ),
    ).toEqual([
      "consent.scopeTemplates",
      "consent.scopeSkills",
      "consent.scopeExternalMcps",
      "consent.scopeTemplatesAnonymized",
    ]);
    expect(
      groups.other
        .filter((entry) => entry.type === "known")
        .map((entry) => entry.label),
    ).toEqual([
      "consent.scopeOnboarding",
      "consent.scopeFeedback",
      "consent.scopeOfflineAccess",
    ]);
    expect(groups.other).toContainEqual({
      scope: "vendor:custom",
      group: "other",
      type: "unknown",
    });
  });

  test("every destructive capability scope triggers the single deletion warning", () => {
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
      expect(en.consent.sensitiveAccess).toContain("delete data");
    }
  });
});
