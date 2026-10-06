import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import { REVIEW_ACCOUNT_EXCLUDED_SCOPES } from "@/api/lib/auth/review-account-policy";
import {
  loadCapabilityEndpoint,
  parseCatalog,
} from "@/api/mcp/capability-tools";
import { MCP_MODES, MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { isAccountAuthorizedForMcpTool } from "@/api/mcp/write-tool-authority";

const reviewEmail = "review@example.test";
const demoEmail = "limited@example.test";

/** Every scope a review-organization credential keeps. */
const reviewScopes: ReadonlySet<string> = new Set(
  MCP_OAUTH_SCOPES.filter(
    (scope) =>
      !(REVIEW_ACCOUNT_EXCLUDED_SCOPES as readonly string[]).includes(scope),
  ),
);

const withRestrictedAccounts = async (run: () => Promise<void> | void) => {
  const previous = {
    demoEmail: env.DEMO_ACCOUNT_EMAIL,
    reviewEmail: env.APP_REVIEW_ACCOUNT_EMAIL,
    reviewOrganization: env.APP_REVIEW_ORGANIZATION_ID,
  };
  env.DEMO_ACCOUNT_EMAIL = demoEmail;
  env.APP_REVIEW_ACCOUNT_EMAIL = reviewEmail;
  env.APP_REVIEW_ORGANIZATION_ID = "org_review";
  try {
    await run();
  } finally {
    env.DEMO_ACCOUNT_EMAIL = previous.demoEmail;
    env.APP_REVIEW_ACCOUNT_EMAIL = previous.reviewEmail;
    env.APP_REVIEW_ORGANIZATION_ID = previous.reviewOrganization;
  }
};

describe("restricted review account MCP exposure", () => {
  test("admits every static tool its scopes expose", async () => {
    await withRestrictedAccounts(() => {
      const exposed = new Map<string, boolean>();
      const demoRefused: string[] = [];
      for (const mode of MCP_MODES) {
        for (const definition of listStaticMcpToolDefinitions(mode)) {
          if (!reviewScopes.has(definition.scope)) {
            continue;
          }
          exposed.set(
            definition.name,
            isAccountAuthorizedForMcpTool(reviewEmail, definition),
          );
          if (!isAccountAuthorizedForMcpTool(demoEmail, definition)) {
            demoRefused.push(definition.name);
          }
        }
      }
      expect(
        [...exposed].flatMap(([name, admitted]) => (admitted ? [] : [name])),
      ).toEqual([]);
      // The check is live: tools the demo account is refused stay open here.
      expect(exposed.get("fill_template")).toBe(true);
      expect(demoRefused).toContain("fill_template");
    });
  });

  test("backs no exposed capability with an account-control operation", async () => {
    const generated = await import("@/api/mcp/generated/capability-catalog");
    const catalog = parseCatalog(generated.default);
    expect(catalog.length).toBeGreaterThan(0);
    const refused: string[] = [];
    let checked = 0;
    for (const entry of catalog) {
      const scopes = [entry.scope, ...(entry.additionalScopes ?? [])];
      if (!scopes.every((scope) => reviewScopes.has(scope))) {
        continue;
      }
      const endpoint = await loadCapabilityEndpoint(entry.id);
      expect({ id: entry.id, loaded: endpoint !== null }).toEqual({
        id: entry.id,
        loaded: true,
      });
      checked += 1;
      if (endpoint?.config.accountAccess === ACCOUNT_ACCESS.accountControl) {
        refused.push(entry.id);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(refused).toEqual([]);
  });
});
