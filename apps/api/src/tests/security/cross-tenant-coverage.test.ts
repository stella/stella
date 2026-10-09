import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Meta-test: the cross-tenant isolation matrix
// (`cross-tenant-handlers.test.ts`) hand-enumerates read/list handlers and
// proves workspace A cannot reach workspace/org B's resources. Nothing stopped
// a *new* handler domain from landing without ever being added to that matrix.
// This guard fails when a `handlers/<domain>/` directory is neither exercised
// by the matrix nor carries an explicit, reasoned waiver, so a new domain is a
// deliberate decision rather than a silent gap.

const handlersDir = path.resolve(import.meta.dir, "../../handlers");
const crossTenantMatrixPath = path.resolve(
  import.meta.dir,
  "cross-tenant-handlers.test.ts",
);

/**
 * Reason a handler domain is intentionally absent from the cross-tenant
 * isolation matrix. A closed set so a waiver is a reviewed choice, not free
 * text.
 */
const WAIVER_REASON = {
  /**
   * The domain owns a tenant-scoped read/list handler that the matrix should
   * eventually exercise but does not yet. Close the gap by adding a matrix
   * case and deleting the waiver.
   */
  preExistingGap: "pre-existing gap, tracked",
  /**
   * The domain has no workspace/organization-scoped read surface to isolate:
   * auth/session/transport/upload mechanics, webhooks, health, dev-only, or
   * intentionally public reads. No cross-tenant matrix case is meaningful.
   */
  noTenantReadSurface: "no cross-tenant read surface",
  /**
   * The domain has an organization-scoped read surface, but it does not read
   * through the tenant-scoped RLS database the matrix harness exercises, so a
   * matrix case would prove nothing about how the domain actually isolates.
   * Isolation must instead be covered by a dedicated test, named here.
   */
  isolatedOutsideRlsHarness: "isolated outside the RLS harness, covered",
  /**
   * The domain's tenant-scoped reads only return rows once optional bundled
   * content is present, which the matrix harness cannot guarantee: a matrix
   * case would pass vacuously wherever that content is absent. Isolation must
   * instead be covered by a test that binds its own fixture content, named
   * here.
   */
  contentConditionedRead: "read conditioned on bundled content, covered",
} as const;

type WaiverReason = (typeof WAIVER_REASON)[keyof typeof WAIVER_REASON];

/**
 * Handler domains deliberately not in the cross-tenant matrix. Deleting an
 * entry here is the natural act once a domain gains a matrix case: the
 * "no covered domain stays waived" test below fails on a stale waiver, forcing
 * it out. Most `preExistingGap` rows are genuine read handlers awaiting a
 * matrix case (e.g. `usage`, `properties`, and `fields`); adding those is
 * incremental follow-up work.
 */
const CROSS_TENANT_WAIVERS: Record<string, WaiverReason> = {
  // Machine API keys live in better-auth's `apikey` table, which the scoped
  // `stella` role is denied outright (`denyStellaAccessPolicies`) — every read
  // goes through the plugin on the owner connection, so there is no RLS
  // boundary for this harness to probe. The plugin lists by owning *user*, and
  // the organization filter is applied in `handlers/api-keys/list.ts` against
  // each key's server-written metadata. That filter, and the equivalent check
  // on the credential path, are covered by
  // `tests/security/machine-api-keys.test.ts`.
  "api-keys": WAIVER_REASON.isolatedOutsideRlsHarness,
  // Desktop registry search authenticates with a purpose-bound API key
  // rather than the session the matrix harness drives, so no matrix case can
  // reach it. The key's server-written metadata pins the organization and
  // membership is re-resolved on every request
  // (`handlers/desktop-registry/auth.test.ts`); its one tenant-scoped read,
  // saved lookup formats, runs on the membership-scoped RLS database covered
  // by `tests/security/template-lookup-formats-rls.integration.test.ts`; and
  // revocation cannot cross organizations
  // (`lib/business-registries/desktop/revocation.db.test.ts`).
  "desktop-registry": WAIVER_REASON.isolatedOutsideRlsHarness,
  // Purpose-bound desktop credentials, not the session used by the matrix,
  // bind the caller's organization. No request field selects another tenant.
  // Credential binding is covered by handlers/desktop-registry/auth.test.ts;
  // handlers/desktop-feature-access/routes.test.ts proves an organization's
  // member grant is hidden from the same verified identity in another org.
  "desktop-feature-access": WAIVER_REASON.isolatedOutsideRlsHarness,
  // This session-driven matrix cannot authenticate desktop credentials.
  // Credential binding: desktop-registry/auth.test.ts. Real membership/RLS
  // isolation: desktop-time-entries/cross-org.db.test.ts, whose tests are:
  // "org A desktop candidates exclude org B matters for a user belonging to both organizations";
  // "org A desktop batch refuses org B matters and never replays an org B batch key";
  // "org A desktop status hides an org B batch key and fences only its own namespace";
  // "org A desktop single create refuses an org B matter despite dual organization membership".
  "desktop-time-entries": WAIVER_REASON.isolatedOutsideRlsHarness,
  "ai-autocomplete": WAIVER_REASON.preExistingGap,
  "ai-config": WAIVER_REASON.preExistingGap,
  "audit-logs": WAIVER_REASON.preExistingGap,
  catalogue: WAIVER_REASON.preExistingGap,
  clauses: WAIVER_REASON.preExistingGap,
  "document-types": WAIVER_REASON.preExistingGap,
  fields: WAIVER_REASON.preExistingGap,
  flows: WAIVER_REASON.preExistingGap,
  legislation: WAIVER_REASON.preExistingGap,
  me: WAIVER_REASON.preExistingGap,
  "organization-settings": WAIVER_REASON.preExistingGap,
  playbooks: WAIVER_REASON.preExistingGap,
  properties: WAIVER_REASON.preExistingGap,
  reports: WAIVER_REASON.preExistingGap,
  search: WAIVER_REASON.preExistingGap,
  skills: WAIVER_REASON.preExistingGap,
  "style-sets": WAIVER_REASON.preExistingGap,
  // The pack catalogue itself is deployment content, not tenant data; the
  // only tenant-scoped read is which of a pack's templates the organization
  // has already installed, and that is empty until the content submodule is
  // checked out. Covered by
  // `handlers/template-packs/installs/create.db.test.ts`, which binds the
  // committed fixture content and asserts one organization neither sees nor
  // reuses another's copy.
  "template-packs": WAIVER_REASON.contentConditionedRead,
  "template-recipes": WAIVER_REASON.preExistingGap,
  usage: WAIVER_REASON.preExistingGap,
  "view-templates": WAIVER_REASON.preExistingGap,
  views: WAIVER_REASON.preExistingGap,
  workspaces: WAIVER_REASON.preExistingGap,
  "agent-auth": WAIVER_REASON.noTenantReadSurface,
  auth: WAIVER_REASON.noTenantReadSurface,
  dev: WAIVER_REASON.noTenantReadSurface,
  "external-preview": WAIVER_REASON.noTenantReadSurface,
  feedback: WAIVER_REASON.noTenantReadSurface,
  "folio-collab": WAIVER_REASON.noTenantReadSurface,
  health: WAIVER_REASON.noTenantReadSurface,
  "hosted-usage-webhook": WAIVER_REASON.noTenantReadSurface,
  // Fixed-CSP HTML shell with no database access or tenant-scoped input.
  "mcp-app-sandbox": WAIVER_REASON.noTenantReadSurface,
  // Fixed-CSP HTML shell with no database access or tenant-scoped input.
  "visual-sandbox": WAIVER_REASON.noTenantReadSurface,
  mcp: WAIVER_REASON.noTenantReadSurface,
  "mcp-connectors": WAIVER_REASON.noTenantReadSurface,
  // Deployment-owned directory access, independent of tenant membership;
  // credential denial and the projected read are covered by operator/routes.test.ts
  // and lib/db/operator-registrations/read.postgres.test.ts.
  operator: WAIVER_REASON.noTenantReadSurface,
  // Unauthenticated reads of bundled deployment content (public template
  // packs, starter playbooks); no database access or tenant-scoped input.
  "public-knowledge": WAIVER_REASON.noTenantReadSurface,
  // Anonymous screening against the global sanctions lists, read through a
  // role granted only those reference tables; no tenant-scoped input or rows.
  sanctions: WAIVER_REASON.noTenantReadSurface,
  // Like mcp-connectors: the only reads are per-user+org connection state
  // (org+user RLS) and external Microsoft Graph data. Neither is a
  // workspace-scoped surface the A-vs-B RLS matrix can meaningfully isolate.
  sharepoint: WAIVER_REASON.noTenantReadSurface,
  smoke: WAIVER_REASON.noTenantReadSurface,
  // Public corpus ingestion has no tenant data or tenant-facing read surface.
  "soft-law": WAIVER_REASON.noTenantReadSurface,
  uploads: WAIVER_REASON.noTenantReadSurface,
  verify: WAIVER_REASON.noTenantReadSurface,
  // Static plain-text host-verification token from env; no database access.
  "well-known": WAIVER_REASON.noTenantReadSurface,
};

/**
 * Domains whose coverage is checked handler by handler rather than by a
 * single import: every handler module their `routes.ts` mounts must be
 * exercised by the matrix or carry a reasoned waiver here. One import would
 * otherwise mark the whole domain covered and hide a new route beside it.
 */
const PER_HANDLER_WAIVERS: Record<string, Record<string, WaiverReason>> = {
  chat: {
    // The model catalog for the caller's own organization: no record id in,
    // nothing another tenant owns out.
    "get-model-options": WAIVER_REASON.noTenantReadSurface,
    // Rewrites the prompt text in the request body; reads no stored record.
    "improve-prompt": WAIVER_REASON.noTenantReadSurface,
  },
};

const handlerDomains = readdirSync(handlersDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

// A domain is "covered" iff the matrix imports a handler from it. Parsing the
// import specifiers keeps this in lockstep with the real matrix: a new case
// drags its `@/api/handlers/<domain>/...` import along, and this set updates
// with no second list to maintain.
const matrixSource = readFileSync(crossTenantMatrixPath, "utf-8");

const coveredDomains = new Set(
  [...matrixSource.matchAll(/@\/api\/handlers\/([^/"]+)\//gu)]
    .map((match) => match[1])
    .filter((domain): domain is string => domain !== undefined),
);

/** Handler modules of `domain` imported by `source`, relative to the domain. */
const domainHandlerImports = (source: string, domain: string): string[] =>
  [
    ...source.matchAll(
      // Domain names are directory names ([a-z0-9-]), safe in a pattern.
      new RegExp(`@/api/handlers/${domain}/([^"]+)"`, "gu"),
    ),
  ]
    .map((match) => match[1])
    .filter((modulePath): modulePath is string => modulePath !== undefined);

const mountedHandlers = (domain: string): string[] =>
  domainHandlerImports(
    readFileSync(path.join(handlersDir, domain, "routes.ts"), "utf-8"),
    domain,
  ).toSorted();

describe("cross-tenant matrix coverage guard", () => {
  test("every handler domain is in the cross-tenant matrix or explicitly waived", () => {
    const uncovered = handlerDomains.filter(
      (domain) =>
        !coveredDomains.has(domain) && !(domain in CROSS_TENANT_WAIVERS),
    );
    expect(uncovered).toEqual([]);
  });

  test("no covered domain is still waived (adding a matrix case removes the waiver)", () => {
    const shadowed = Object.keys(CROSS_TENANT_WAIVERS).filter((domain) =>
      coveredDomains.has(domain),
    );
    expect(shadowed).toEqual([]);
  });

  test("every waiver names a real handler domain", () => {
    const staleWaivers = Object.keys(CROSS_TENANT_WAIVERS).filter(
      (domain) => !handlerDomains.includes(domain),
    );
    expect(staleWaivers).toEqual([]);
  });

  test.each(Object.keys(PER_HANDLER_WAIVERS))(
    "every handler %s mounts is in the matrix or explicitly waived",
    (domain) => {
      const waived = PER_HANDLER_WAIVERS[domain] ?? {};
      const exercised = new Set(domainHandlerImports(matrixSource, domain));
      const mounted = mountedHandlers(domain);
      expect(mounted.length).toBeGreaterThan(0);
      expect(
        mounted.filter(
          (handler) => !exercised.has(handler) && !(handler in waived),
        ),
      ).toEqual([]);
      // A waiver must name a mounted handler the matrix does not exercise.
      expect(
        Object.keys(waived).filter(
          (handler) => exercised.has(handler) || !mounted.includes(handler),
        ),
      ).toEqual([]);
    },
  );

  test("every cross-tenant matrix import names a real handler domain", () => {
    const unknownCovered = [...coveredDomains].filter(
      (domain) => !handlerDomains.includes(domain),
    );
    expect(unknownCovered).toEqual([]);
  });
});
