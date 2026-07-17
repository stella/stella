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
} as const;

type WaiverReason = (typeof WAIVER_REASON)[keyof typeof WAIVER_REASON];

/**
 * Handler domains deliberately not in the cross-tenant matrix. Deleting an
 * entry here is the natural act once a domain gains a matrix case: the
 * "no covered domain stays waived" test below fails on a stale waiver, forcing
 * it out. Most `preExistingGap` rows are genuine read handlers awaiting a
 * matrix case (e.g. `usage`, `properties`, `fields`, `user-files`
 * read-content/read-thumbnail); adding those is incremental follow-up work.
 */
const CROSS_TENANT_WAIVERS: Record<string, WaiverReason> = {
  "ai-autocomplete": WAIVER_REASON.preExistingGap,
  "ai-config": WAIVER_REASON.preExistingGap,
  "audit-logs": WAIVER_REASON.preExistingGap,
  "case-law": WAIVER_REASON.preExistingGap,
  catalogue: WAIVER_REASON.preExistingGap,
  chat: WAIVER_REASON.preExistingGap,
  clauses: WAIVER_REASON.preExistingGap,
  "document-types": WAIVER_REASON.preExistingGap,
  docx: WAIVER_REASON.preExistingGap,
  fields: WAIVER_REASON.preExistingGap,
  legislation: WAIVER_REASON.preExistingGap,
  me: WAIVER_REASON.preExistingGap,
  "organization-settings": WAIVER_REASON.preExistingGap,
  playbooks: WAIVER_REASON.preExistingGap,
  properties: WAIVER_REASON.preExistingGap,
  reports: WAIVER_REASON.preExistingGap,
  search: WAIVER_REASON.preExistingGap,
  skills: WAIVER_REASON.preExistingGap,
  "style-sets": WAIVER_REASON.preExistingGap,
  tasks: WAIVER_REASON.preExistingGap,
  "template-recipes": WAIVER_REASON.preExistingGap,
  usage: WAIVER_REASON.preExistingGap,
  "user-files": WAIVER_REASON.preExistingGap,
  "view-templates": WAIVER_REASON.preExistingGap,
  views: WAIVER_REASON.preExistingGap,
  workspaces: WAIVER_REASON.preExistingGap,
  auth: WAIVER_REASON.noTenantReadSurface,
  dev: WAIVER_REASON.noTenantReadSurface,
  "external-preview": WAIVER_REASON.noTenantReadSurface,
  feedback: WAIVER_REASON.noTenantReadSurface,
  "folio-collab": WAIVER_REASON.noTenantReadSurface,
  health: WAIVER_REASON.noTenantReadSurface,
  "hosted-usage-webhook": WAIVER_REASON.noTenantReadSurface,
  mcp: WAIVER_REASON.noTenantReadSurface,
  "mcp-connectors": WAIVER_REASON.noTenantReadSurface,
  smoke: WAIVER_REASON.noTenantReadSurface,
  uploads: WAIVER_REASON.noTenantReadSurface,
  verify: WAIVER_REASON.noTenantReadSurface,
};

const handlerDomains = readdirSync(handlersDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

// A domain is "covered" iff the matrix imports a handler from it. Parsing the
// import specifiers keeps this in lockstep with the real matrix: a new case
// drags its `@/api/handlers/<domain>/...` import along, and this set updates
// with no second list to maintain.
const coveredDomains = new Set(
  [
    ...readFileSync(crossTenantMatrixPath, "utf8").matchAll(
      /@\/api\/handlers\/([^/"]+)\//g,
    ),
  ].map((match) => match[1]),
);

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

  test("every cross-tenant matrix import names a real handler domain", () => {
    const unknownCovered = [...coveredDomains].filter(
      (domain) => !handlerDomains.includes(domain),
    );
    expect(unknownCovered).toEqual([]);
  });
});
