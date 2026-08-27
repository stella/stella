import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import * as v from "valibot";

/**
 * Restores the mutation-endpoint census `permission-guards.test.ts` used to
 * run (removed in fdcc8c73a as redundant with the `require-safe-route-handlers`
 * oxlint rule), scoped to the route files that rule is turned OFF for. Those
 * files are exactly the ones the live lint rule cannot see, so they are the
 * ones worth a second, independent check.
 *
 * Two invariants:
 *  1. The oxlint exemption list itself cannot grow silently: it is compared
 *     against a checked-in expected list, so widening it requires touching
 *     this file too.
 *  2. Every mutation-shaped route (`.post`/`.put`/`.patch`/`.delete` with a
 *     string-literal path) inside an exempt file must be named in a
 *     reviewed, checked-in allowlist. An endpoint the allowlist does not
 *     name is unreviewed; an allowlist entry with no matching endpoint is
 *     stale.
 *
 * Known gap, reported rather than fixed here: `mcp/routes.ts` is a 4-line
 * re-export (`createMcpRoute` from `mcp/routes-core.ts`); the real MCP route
 * registrations live in `routes-core.ts`. Neither the lint rule's enforced
 * glob (`**\/routes.ts`, `**\/*route.ts`) nor this exemption list matches
 * "routes-core.ts", so that file sits outside both mechanisms. MCP's own
 * per-tool `roles[...].authorize(...)` checks (see `mcp/knowledge-tools.ts`)
 * are what actually gate it; the exemption bookkeeping just names the wrong
 * file.
 */

const REPO_ROOT = nodePath.join(import.meta.dirname, "../../../../..");
const HANDLERS_PREFIX = "apps/api/src/handlers/";
const RULE_ID = "require-safe-route-handlers/require-safe-route-handlers";

// Mirror of the file list in oxlint.config.ts's route-boundary-exception
// override for the rule above. Keep in sync deliberately: a silent change
// here should fail this test, not slide through unnoticed.
const EXPECTED_EXEMPT_ROUTE_FILES = [
  "apps/api/src/handlers/agent-auth/routes.ts",
  "apps/api/src/handlers/ai-config/routes.ts",
  "apps/api/src/handlers/auth/routes.ts",
  "apps/api/src/handlers/auth/ui-routes.ts",
  "apps/api/src/handlers/dev/routes.ts",
  "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts",
  "apps/api/src/handlers/feedback/routes.ts",
  "apps/api/src/handlers/folio-collab/routes.ts",
  "apps/api/src/handlers/health/routes.ts",
  "apps/api/src/handlers/hosted-usage-webhook/routes.ts",
  "apps/api/src/handlers/mcp/routes.ts",
  "apps/api/src/handlers/mcp-app-sandbox/routes.ts",
  "apps/api/src/handlers/mcp-connectors/oauth-client-metadata-route.ts",
  "apps/api/src/handlers/smoke/routes.ts",
  "apps/api/src/handlers/verify/routes.ts",
  "apps/api/src/handlers/well-known/routes.ts",
  "apps/api/src/handlers/workspaces/events.ts",
].sort();

/**
 * Reviewed mutation endpoints inside the exempt files above. Each entry
 * documents why it does not carry a `permissions:` HandlerConfig guard.
 * Adding an endpoint here requires code review approval, same as the
 * original allowlist.
 */
const REVIEWED_UNGUARDED: Record<string, string[]> = {
  // Session-authenticated (sessionAuthMacro + validateSession guard), not
  // an org-role-scoped resource.
  "ai-config/routes.ts": ["POST /validate-provider"],
  // Dev-only surface, several endpoints gated by env.isDev inline; the
  // whole route group sits behind the standard auth macro at mount time.
  "dev/routes.ts": [
    "POST /seed",
    "POST /seed-skills",
    "POST /seed-firm-knowledge",
    "POST /clean",
    "POST /rebuild-search",
    "POST /clear-cache",
  ],
  // Desktop-edit handoff/session endpoints authenticate via a handoff or
  // session token carried in the request, not an org-role permission.
  "entities/desktop-edit-sessions-route.ts": [
    "POST /desktop-edit-handoffs/redeem",
    "POST /desktop-edit-handoffs/:handoffId/opened",
    "POST /desktop-edit-sessions/:sessionId/checkpoint",
    "POST /desktop-edit-sessions/:sessionId/finalize",
    "POST /desktop-edit-sessions/:sessionId/respond-takeover",
  ],
  // Deliberately public intake (no Stella account required); protected by
  // per-IP rate limiting and content dedup inside receivePublicFeedback,
  // not identity.
  "feedback/routes.ts": ["POST /feedback"],
  // Folio collaboration session lifecycle: authenticated via the session's
  // own collab token, minted and checked inside each handler.
  "folio-collab/routes.ts": [
    "POST /authorize",
    "POST /refresh-token",
    "POST /snapshot/load",
    "POST /snapshot/store",
    "POST /:sessionId/cancel",
    "POST /:sessionId/checkpoint",
    "POST /:sessionId/finalize",
  ],
  // Deliberately mounted outside the auth macro; authenticated by the HMAC
  // signature verified inside receiveHostedUsageWebhook, not identity.
  "hosted-usage-webhook/routes.ts": ["POST /webhook"],
  // Non-production synthetic-monitoring session mint: gated by the
  // SMOKE_SESSION_SECRET presence check plus a constant-time shared-secret
  // comparison, both inside the handler.
  "smoke/routes.ts": ["POST /session"],
};

/** Matches `.put(`, `.post(`, `.patch(`, `.delete(` calls whose first
 *  argument is a string literal — the same shape the original
 *  permission-guards.test.ts scanned for. A call whose path is a named
 *  constant (e.g. agent-auth/routes.ts) is invisible to this regex; that
 *  limitation is inherited from the original tool, not introduced here. */
const MUTATION_RE = /\.(put|post|patch|delete)\(\s*["'`](.*?)["'`]/gu;

type Endpoint = { method: string; path: string; label: string };

const parseRouteFile = (relPath: string): Endpoint[] => {
  const source = readFileSync(nodePath.join(REPO_ROOT, relPath), "utf-8");
  const endpoints: Endpoint[] = [];
  for (const match of source.matchAll(MUTATION_RE)) {
    const method = (match[1] ?? "").toUpperCase();
    const path = match[2] ?? "";
    endpoints.push({ method, path, label: `${method} ${path}` });
  }
  return endpoints;
};

const oxlintConfigModuleSchema = v.object({
  default: v.object({
    overrides: v.optional(
      v.array(
        v.object({
          files: v.optional(v.array(v.string())),
          rules: v.optional(v.record(v.string(), v.unknown())),
        }),
      ),
    ),
  }),
});

describe("route-boundary exemptions (require-safe-route-handlers off)", () => {
  test("the oxlint exemption list for handler route files matches the checked-in list", async () => {
    const oxlintConfigPath = nodePath.join(REPO_ROOT, "oxlint.config.ts");
    const oxlintConfig = v.parse(
      oxlintConfigModuleSchema,
      await import(oxlintConfigPath),
    ).default;

    const exemptFiles = new Set<string>();
    for (const override of oxlintConfig.overrides ?? []) {
      if (override.rules?.[RULE_ID] !== "off") {
        continue;
      }
      for (const file of override.files ?? []) {
        if (file.startsWith(HANDLERS_PREFIX)) {
          exemptFiles.add(file);
        }
      }
    }

    expect([...exemptFiles].sort()).toEqual(EXPECTED_EXEMPT_ROUTE_FILES);
  });

  test("every mutation endpoint in an exempt file is a reviewed, still-real allowlist entry", () => {
    const unreviewed: string[] = [];
    const stale: string[] = [];

    for (const relFile of EXPECTED_EXEMPT_ROUTE_FILES) {
      const key = relFile.slice(HANDLERS_PREFIX.length);
      const allowed = new Set(REVIEWED_UNGUARDED[key]);
      const endpoints = parseRouteFile(relFile);
      const found = new Set(endpoints.map((ep) => ep.label));

      for (const ep of endpoints) {
        if (!allowed.has(ep.label)) {
          unreviewed.push(`${key}: ${ep.label}`);
        }
      }
      for (const label of allowed) {
        if (!found.has(label)) {
          stale.push(`${key}: ${label}`);
        }
      }
    }

    expect(unreviewed).toEqual([]);
    expect(stale).toEqual([]);
  });
});
